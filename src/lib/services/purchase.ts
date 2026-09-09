import type { Tx } from '@/lib/db';
import { transaction } from '@/lib/db';
import {
  dec,
  toMoney,
  toUnitCost,
  toQuantity,
  sum,
} from '@/lib/money';
import { ACCOUNT_KEYS, DOC_TYPES } from '@/lib/constants';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { postJournalEntry, reverseJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { writeAudit } from '@/lib/services/audit';
import { resolveTaxCode } from '@/lib/services/tax';
import { computePurchaseTotals } from '@/lib/calc/purchase';
import type { PurchaseContractInput, PurchaseLineInput } from '@/lib/calc/purchase';

/**
 * PurchaseService — the start of the "enter once, update everywhere" chain.
 *
 * Approving a purchase contract performs the following inside ONE database
 * transaction. If any step fails, none of them survive:
 *
 *   1. contract   → DRAFT becomes POSTED
 *   2. job        → one shipment/job record, the profitability object
 *   3. lots       → one traceability lot per distinct lot number
 *   4. containers → one container per distinct container number
 *   5. batches    → one costed batch per contract line, quantity ORDERED
 *   6. accounting → Dr Inventory in Transit / Cr Accounts Payable (supplier)
 *   7. audit      → who approved what, and when
 *
 * Note what does NOT happen: no warehouse stock is created. Approving a
 * purchase order does not mean the coffee has arrived. The goods are owned and
 * the supplier is owed, so they sit in "Inventory in Transit" until a goods
 * receipt lands them in a named warehouse. See GoodsReceiptService.
 *
 * The supplier payable and the supplier ledger are not separate writes: both
 * are views over the journal line tagged with `vendorId`, so they cannot drift.
 */

export {
  computePurchaseTotals,
  type PurchaseLineInput,
  type PurchaseContractInput,
} from '@/lib/calc/purchase';

async function assertReferenceIsFree(tx: Tx, companyId: string, reference: string, excludeId?: string) {
  const existing = await tx.purchaseContract.findFirst({
    where: { companyId, contractReference: reference, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { id: true, contractNumber: true },
  });
  if (existing) {
    throw new ConflictError(`Contract reference "${reference}" is already used by ${existing.contractNumber}.`);
  }
}

/**
 * Replaces whatever rate the browser sent with the rate the chosen code
 * actually carries, and drops tax entirely when the company is not registered.
 * The form computes the same figures for its preview, but only this result is
 * ever saved.
 */
async function applyServerTaxRates(tx: Tx, input: PurchaseContractInput): Promise<PurchaseContractInput> {
  const company = await tx.company.findUniqueOrThrow({
    where: { id: input.companyId },
    select: { taxEnabled: true },
  });

  const lines = [];
  for (const line of input.lines) {
    const code = await resolveTaxCode(tx, {
      companyId: input.companyId,
      taxEnabled: company.taxEnabled,
      taxCodeId: line.taxCodeId,
      appliesTo: 'PURCHASE',
    });
    lines.push({ ...line, taxCodeId: code.id, taxRatePct: code.ratePct.toString() });
  }
  return { ...input, lines };
}

function lineData(totals: ReturnType<typeof computePurchaseTotals>) {
  return totals.lines.map((l) => ({
    lineNumber: l.lineNumber,
    itemId: l.itemId,
    lotNumber: l.lotNumber,
    batchNumber: l.batchNumber,
    containerNumber: l.containerNumber,
    containerType: l.containerType,
    quantity: l.quantity,
    unit: l.unit,
    quantityKg: l.quantityKg,
    bags: l.bags,
    bagWeightKg: l.bagWeightKg,
    unitPrice: l.unitPrice,
    unitPriceKg: l.unitPriceKg,
    lineSubtotal: l.lineSubtotal,
    freightAllocated: l.freightAllocated,
    otherChargesAllocated: l.otherChargesAllocated,
    lineTotal: l.lineTotal,
    unitCostKg: l.unitCostKg,
    containers: l.containers,
    taxCodeId: l.taxCodeId,
    taxRatePct: l.taxRatePct,
    taxAmount: l.taxAmount,
    taxAmountUsd: l.taxAmountUsd,
    notes: l.notes,
  }));
}

/**
 * Batch, lot and container numbers, checked when the contract is saved.
 *
 * Batches are only written when the contract is approved, so without this the
 * clash surfaces as a raw unique-constraint failure at approval — after the
 * user has typed the whole document. Checking here names the offending number
 * while it is still on screen.
 *
 * Lots may legitimately span contracts (a supplier lot can be split across
 * shipments) so they are allowed to repeat, but only for the same coffee.
 *
 * Containers are physically reused in the real world, months apart. We still
 * refuse to attach an existing container number to a second contract, because
 * the container row carries the shipment it belongs to: silently repointing it
 * would strip the container off the earlier shipment and quietly falsify that
 * shipment's records. Refusing is the safe reading.
 */
async function assertTraceabilityNumbersAreFree(
  tx: Tx,
  companyId: string,
  lines: PurchaseLineInput[],
  excludeContractId?: string,
): Promise<void> {
  const seenBatches = new Set<string>();
  const seenContainers = new Set<string>();

  for (const line of lines) {
    const batchNumber = line.batchNumber.trim();
    if (seenBatches.has(batchNumber)) {
      throw new ConflictError(`Batch number "${batchNumber}" appears more than once on this contract.`);
    }
    seenBatches.add(batchNumber);

    const clash = await tx.batch.findFirst({
      where: {
        companyId,
        batchNumber,
        ...(excludeContractId ? { NOT: { purchaseContractId: excludeContractId } } : {}),
      },
      select: { batchNumber: true, purchaseContract: { select: { contractNumber: true } } },
    });
    if (clash) {
      throw new ConflictError(
        `Batch number "${batchNumber}" is already used by ${clash.purchaseContract?.contractNumber ?? 'another contract'}.`,
      );
    }

    const lot = await tx.lot.findFirst({
      where: { companyId, lotNumber: line.lotNumber.trim() },
      select: { itemId: true, lotNumber: true },
    });
    if (lot && lot.itemId !== line.itemId) {
      throw new ConflictError(
        `Lot "${lot.lotNumber}" already exists for a different coffee. Use a lot number of its own.`,
      );
    }

    if (line.containerNumber) {
      const containerNumber = line.containerNumber.trim();
      if (seenContainers.has(containerNumber)) continue;
      seenContainers.add(containerNumber);

      const container = await tx.container.findFirst({
        where: {
          companyId,
          containerNumber,
          ...(excludeContractId ? { NOT: { purchaseContractId: excludeContractId } } : {}),
        },
        select: { containerNumber: true, purchaseContract: { select: { contractNumber: true } } },
      });
      if (container) {
        throw new ConflictError(
          `Container "${containerNumber}" is already recorded on ${container.purchaseContract?.contractNumber ?? 'another contract'}.`,
        );
      }
    }
  }
}

export async function createPurchaseContract(input: PurchaseContractInput, userId: string) {
  return transaction(async (tx) => {
    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, companyId: input.companyId },
      select: { id: true, vendorName: true, paymentTermDays: true },
    });
    if (!vendor) throw new NotFoundError('Supplier');

    // Zero-day terms are real and must still produce a due date, or the
    // contract can never appear as overdue on the payables ageing.
    const termDays = input.paymentTermDays ?? vendor.paymentTermDays ?? 0;

    for (const line of input.lines) {
      const item = await tx.coffeeItem.findFirst({
        where: { id: line.itemId, companyId: input.companyId },
        select: { id: true },
      });
      if (!item) throw new NotFoundError('Coffee item');
    }

    await assertReferenceIsFree(tx, input.companyId, input.contractReference);
    await assertTraceabilityNumbersAreFree(tx, input.companyId, input.lines);

    const totals = computePurchaseTotals(await applyServerTaxRates(tx, input));
    const contractNumber = await nextReference(tx, {
      companyId: input.companyId,
      docType: DOC_TYPES.PURCHASE_CONTRACT,
    });

    const dueDate = new Date(input.contractDate.getTime() + termDays * 86_400_000);

    const contract = await tx.purchaseContract.create({
      data: {
        companyId: input.companyId,
        contractNumber,
        contractReference: input.contractReference,
        supplierContractNo: input.supplierContractNo ?? null,
        contractDate: input.contractDate,
        vendorId: input.vendorId,
        origin: input.origin ?? null,
        currency: input.currency.toUpperCase(),
        rateToUsd: dec(input.rateToUsd),
        rateLocalPerUsd: dec(input.rateLocalPerUsd),
        subtotal: totals.subtotal,
        freightAmount: totals.freightAmount,
        otherCharges: totals.otherCharges,
        totalValue: totals.totalValue,
        totalValueUsd: totals.totalValueUsd,
        taxAmount: totals.taxAmount,
        taxAmountUsd: totals.taxAmountUsd,
        containers: totals.totalContainers,
        totalBags: totals.totalBags,
        incoterm: input.incoterm ?? 'FOB',
        portOfLoading: input.portOfLoading ?? null,
        destination: input.destination ?? null,
        expectedShipmentDate: input.expectedShipmentDate ?? null,
        paymentTermDays: termDays,
        dueDate,
        notes: input.notes ?? null,
        status: 'DRAFT',
        createdById: userId,
        lines: { create: lineData(totals) },
      },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'PURCHASE_CONTRACT_CREATED',
      entityType: 'PurchaseContract',
      entityId: contract.id,
      after: { contractNumber, supplier: vendor.vendorName, totalValue: contract.totalValue, status: 'DRAFT' },
    });

    return contract;
  });
}

export async function updatePurchaseContract(id: string, input: PurchaseContractInput, userId: string) {
  return transaction(async (tx) => {
    const existing = await tx.purchaseContract.findFirst({
      where: { id, companyId: input.companyId },
      include: { lines: true },
    });
    if (!existing) throw new NotFoundError('Purchase contract');
    if (existing.status !== 'DRAFT') {
      throw new BusinessRuleError('Only draft contracts can be edited. Reverse the contract to correct a posted one.');
    }

    await assertReferenceIsFree(tx, input.companyId, input.contractReference, id);
    await assertTraceabilityNumbersAreFree(tx, input.companyId, input.lines, id);

    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, companyId: input.companyId },
      select: { paymentTermDays: true },
    });
    if (!vendor) throw new NotFoundError('Supplier');

    const totals = computePurchaseTotals(await applyServerTaxRates(tx, input));
    const termDays = input.paymentTermDays ?? vendor.paymentTermDays ?? 0;
    const dueDate = new Date(input.contractDate.getTime() + termDays * 86_400_000);

    await tx.purchaseContractLine.deleteMany({ where: { purchaseContractId: id } });

    const contract = await tx.purchaseContract.update({
      where: { id },
      data: {
        contractReference: input.contractReference,
        supplierContractNo: input.supplierContractNo ?? null,
        contractDate: input.contractDate,
        vendorId: input.vendorId,
        origin: input.origin ?? null,
        currency: input.currency.toUpperCase(),
        rateToUsd: dec(input.rateToUsd),
        rateLocalPerUsd: dec(input.rateLocalPerUsd),
        subtotal: totals.subtotal,
        freightAmount: totals.freightAmount,
        otherCharges: totals.otherCharges,
        totalValue: totals.totalValue,
        totalValueUsd: totals.totalValueUsd,
        taxAmount: totals.taxAmount,
        taxAmountUsd: totals.taxAmountUsd,
        containers: totals.totalContainers,
        totalBags: totals.totalBags,
        incoterm: input.incoterm ?? 'FOB',
        portOfLoading: input.portOfLoading ?? null,
        destination: input.destination ?? null,
        expectedShipmentDate: input.expectedShipmentDate ?? null,
        paymentTermDays: termDays,
        dueDate,
        notes: input.notes ?? null,
        lines: { create: lineData(totals) },
      },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'PURCHASE_CONTRACT_UPDATED',
      entityType: 'PurchaseContract',
      entityId: id,
      before: { totalValue: existing.totalValue, lines: existing.lines.length },
      after: { totalValue: contract.totalValue, lines: contract.lines.length },
    });

    return contract;
  });
}

/**
 * Approves and posts a draft contract.
 *
 * Idempotency: the contract row is locked with SELECT … FOR UPDATE and its
 * status re-read inside the lock, so a double-clicked "Approve" produces exactly
 * one set of postings — the second attempt sees POSTED and is rejected.
 */
export async function postPurchaseContract(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM purchase_contracts
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Purchase contract');
    if (locked[0].status !== 'DRAFT') {
      throw new BusinessRuleError(
        `This contract is already ${locked[0].status.toLowerCase()} and cannot be approved again.`,
      );
    }

    const contract = await tx.purchaseContract.findUniqueOrThrow({
      where: { id: params.id },
      include: { lines: { orderBy: { lineNumber: 'asc' } }, vendor: true },
    });

    if (contract.lines.length === 0) {
      throw new BusinessRuleError('This contract has no lines and cannot be approved.');
    }

    const company = await getCompanyContext(tx, params.companyId);
    const postedAt = new Date();

    // --- 2: the job / shipment record --------------------------------------
    const shipmentNumber = await nextReference(tx, { companyId: params.companyId, docType: DOC_TYPES.SHIPMENT });
    const jobNumber = await nextReference(tx, { companyId: params.companyId, docType: DOC_TYPES.JOB });

    const totalQuantityKg = toQuantity(sum(contract.lines.map((l) => l.quantityKg)));
    const totalBags = contract.lines.reduce((acc, l) => acc + l.bags, 0);

    const shipment = await tx.shipment.create({
      data: {
        companyId: params.companyId,
        shipmentNumber,
        jobNumber,
        purchaseContractId: contract.id,
        vendorId: contract.vendorId,
        itemId: contract.lines[0].itemId,
        quantityKg: totalQuantityKg,
        bags: totalBags,
        containers: contract.containers,
        origin: contract.origin,
        destination: contract.destination,
        portOfLoading: contract.portOfLoading,
        incoterm: contract.incoterm,
        status: 'CONTRACT_CREATED',
        documentStatus: 'DRAFT_PENDING',
        createdById: params.userId,
      },
    });

    await tx.shipmentStatusHistory.create({
      data: {
        shipmentId: shipment.id,
        fromStatus: null,
        toStatus: 'CONTRACT_CREATED',
        changedById: params.userId,
        notes: `Job opened automatically from purchase contract ${contract.contractNumber}.`,
      },
    });

    // --- 3, 4 & 5: lots, containers and costed batches ---------------------
    const lotCache = new Map<string, string>();
    const containerCache = new Map<string, string>();

    for (const line of contract.lines) {
      // Lot: shared across lines that quote the same supplier lot number.
      let lotId = lotCache.get(line.lotNumber);
      if (!lotId) {
        const existingLot = await tx.lot.findFirst({
          where: { companyId: params.companyId, lotNumber: line.lotNumber },
          select: { id: true },
        });
        lotId =
          existingLot?.id ??
          (
            await tx.lot.create({
              data: {
                companyId: params.companyId,
                lotNumber: line.lotNumber,
                itemId: line.itemId,
                purchaseContractId: contract.id,
                originCountry: contract.origin,
              },
              select: { id: true },
            })
          ).id;
        lotCache.set(line.lotNumber, lotId);
      }

      // Container, when the contract states one.
      let containerId: string | null = null;
      if (line.containerNumber) {
        containerId = containerCache.get(line.containerNumber) ?? null;
        if (!containerId) {
          const existingContainer = await tx.container.findFirst({
            where: { companyId: params.companyId, containerNumber: line.containerNumber },
            select: { id: true },
          });
          if (existingContainer) {
            containerId = existingContainer.id;
            await tx.container.update({
              where: { id: containerId },
              data: { shipmentId: shipment.id, purchaseContractId: contract.id },
            });
          } else {
            containerId = (
              await tx.container.create({
                data: {
                  companyId: params.companyId,
                  containerNumber: line.containerNumber,
                  containerType: line.containerType,
                  purchaseContractId: contract.id,
                  shipmentId: shipment.id,
                  netWeightKg: line.quantityKg,
                  bags: line.bags,
                },
                select: { id: true },
              })
            ).id;
          }
          containerCache.set(line.containerNumber, containerId);
        }
      }

      const unitCostUsd = toUnitCost(
        contract.currency === 'USD' ? line.unitCostKg : dec(line.unitCostKg).dividedBy(contract.rateToUsd),
      );
      const purchaseCostUsd = toMoney(dec(line.quantityKg).times(unitCostUsd));

      await tx.batch.create({
        data: {
          companyId: params.companyId,
          batchNumber: line.batchNumber,
          itemId: line.itemId,
          lotId,
          containerId,
          shipmentId: shipment.id,
          purchaseContractId: contract.id,
          purchaseContractLineId: line.id,
          // Ordered, not received: the coffee is owned but not yet in a warehouse.
          orderedQuantityKg: line.quantityKg,
          inTransitQuantityKg: line.quantityKg,
          orderedBags: line.bags,
          bagWeightKg: line.bagWeightKg,
          unitCost: line.unitCostKg,
          currency: contract.currency,
          unitCostUsd,
          purchaseCostUsd,
          landedUnitCostUsd: unitCostUsd,
        },
      });
    }

    // --- 6: accounting -----------------------------------------------------
    await postJournalEntry(tx, {
      companyId: params.companyId,
      entryDate: contract.contractDate,
      description: `Purchase contract ${contract.contractNumber} — ${contract.vendor.vendorName}`,
      sourceType: 'PURCHASE_CONTRACT',
      sourceId: contract.id,
      createdById: params.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: contract.rateLocalPerUsd,
      lines: [
        {
          accountKey: ACCOUNT_KEYS.INVENTORY_IN_TRANSIT,
          direction: 'DEBIT',
          currency: contract.currency,
          amount: contract.totalValue,
          rateToUsd: contract.rateToUsd,
          description: 'Coffee purchased, in transit',
          purchaseContractId: contract.id,
          vendorId: contract.vendorId,
          shipmentId: shipment.id,
        },
        ...(dec(contract.taxAmount).greaterThan(0)
          ? [
              {
                accountKey: ACCOUNT_KEYS.VAT_INPUT,
                direction: 'DEBIT' as const,
                currency: contract.currency,
                amount: contract.taxAmount,
                rateToUsd: contract.rateToUsd,
                description: `Input tax on ${contract.contractNumber}`,
                vendorId: contract.vendorId,
                purchaseContractId: contract.id,
              },
            ]
          : []),
        {
          accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
          direction: 'CREDIT',
          currency: contract.currency,
          // Gross: the supplier is owed the goods and the tax on them. Only
          // the goods reached inventory above; the tax went to VAT recoverable.
          amount: toMoney(dec(contract.totalValue).plus(contract.taxAmount)),
          rateToUsd: contract.rateToUsd,
          description: `Payable to ${contract.vendor.vendorName}`,
          vendorId: contract.vendorId,
          purchaseContractId: contract.id,
          shipmentId: shipment.id,
        },
      ],
    });

    // --- 1: flip the contract status ---------------------------------------
    const posted = await tx.purchaseContract.update({
      where: { id: contract.id },
      data: { status: 'POSTED', postedAt, postedById: params.userId },
      include: { lines: true, shipments: true },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'PURCHASE_CONTRACT_APPROVED',
      entityType: 'PurchaseContract',
      entityId: contract.id,
      before: { status: 'DRAFT' },
      after: {
        status: 'POSTED',
        totalValue: contract.totalValue,
        currency: contract.currency,
        jobNumber,
        shipmentNumber,
        batchesCreated: contract.lines.length,
      },
    });

    return posted;
  });
}

/**
 * Reverses a posted contract. Refuses when downstream activity exists, because
 * silently unwinding a goods receipt, a sale or a supplier payment would be
 * worse than making the user reverse those documents first.
 */
export async function reversePurchaseContract(params: {
  id: string;
  companyId: string;
  userId: string;
  reason: string;
}) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM purchase_contracts
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Purchase contract');
    if (locked[0].status !== 'POSTED') {
      throw new BusinessRuleError('Only a posted contract can be reversed.');
    }

    const contract = await tx.purchaseContract.findUniqueOrThrow({
      where: { id: params.id },
      include: { batches: true, shipments: true },
    });

    const receiptCount = await tx.goodsReceipt.count({
      where: { purchaseContractId: params.id, status: 'POSTED' },
    });
    if (receiptCount > 0) {
      throw new BusinessRuleError(
        'Goods have been received against this contract. Reverse the goods receipts before reversing the contract.',
      );
    }

    if (contract.batches.some((b) => dec(b.soldQuantityKg).greaterThan(0))) {
      throw new BusinessRuleError(
        'Coffee from this contract has been sold. Reverse the related sales invoices first.',
      );
    }
    if (contract.batches.some((b) => dec(b.allocatedQuantityKg).greaterThan(0))) {
      throw new BusinessRuleError('Stock from this contract is reserved by draft sales. Release those drafts first.');
    }

    const paymentCount = await tx.paymentAllocation.count({ where: { purchaseContractId: params.id } });
    if (paymentCount > 0) {
      throw new BusinessRuleError('Supplier payments are allocated to this contract. Reverse those payments first.');
    }

    const expenseCount = await tx.expense.count({
      where: { purchaseContractId: params.id, status: 'POSTED' },
    });
    if (expenseCount > 0) {
      throw new BusinessRuleError('Posted expenses reference this contract. Reverse those expenses first.');
    }

    const reversalDate = new Date();

    await reverseJournalEntry(tx, {
      companyId: params.companyId,
      sourceType: 'PURCHASE_CONTRACT',
      sourceId: contract.id,
      createdById: params.userId,
      entryDate: reversalDate,
      reason: params.reason,
    });

    // No stock movements exist yet, so the batches are simply retired.
    await tx.batch.updateMany({
      where: { purchaseContractId: contract.id },
      data: { status: 'INACTIVE', orderedQuantityKg: 0, inTransitQuantityKg: 0 },
    });

    const reversed = await tx.purchaseContract.update({
      where: { id: contract.id },
      data: { status: 'REVERSED', reversedAt: reversalDate, reversalReason: params.reason },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'PURCHASE_CONTRACT_REVERSED',
      entityType: 'PurchaseContract',
      entityId: contract.id,
      before: { status: 'POSTED' },
      after: { status: 'REVERSED', reason: params.reason },
    });

    return reversed;
  });
}

export async function deleteDraftPurchaseContract(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const contract = await tx.purchaseContract.findFirst({
      where: { id: params.id, companyId: params.companyId },
    });
    if (!contract) throw new NotFoundError('Purchase contract');
    if (contract.status !== 'DRAFT') {
      throw new BusinessRuleError('Only draft contracts can be deleted. Posted contracts must be reversed.');
    }

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'PURCHASE_CONTRACT_DELETED',
      entityType: 'PurchaseContract',
      entityId: contract.id,
      before: { contractNumber: contract.contractNumber, totalValue: contract.totalValue },
    });

    await tx.purchaseContract.delete({ where: { id: params.id } });
  });
}

/** Outstanding quantity still to be received against a contract, per line. */
export async function getReceiptStatus(tx: Tx, purchaseContractId: string) {
  const rows = await tx.$queryRaw<
    Array<{
      lineId: string;
      lineNumber: number;
      batchId: string;
      batchNumber: string;
      itemName: string;
      lotNumber: string;
      containerNumber: string | null;
      orderedKg: string;
      receivedKg: string;
      bagWeightKg: string;
      orderedBags: string;
      receivedBags: string;
    }>
  >`
    SELECT pcl."id" AS "lineId", pcl."lineNumber", b."id" AS "batchId", b."batchNumber",
           ci."itemName", l."lotNumber", c."containerNumber",
           b."orderedQuantityKg"::text AS "orderedKg",
           b."receivedQuantityKg"::text AS "receivedKg",
           b."bagWeightKg"::text       AS "bagWeightKg",
           b."orderedBags"::text       AS "orderedBags",
           b."receivedBags"::text      AS "receivedBags"
    FROM purchase_contract_lines pcl
    JOIN batches b ON b."purchaseContractLineId" = pcl."id"
    JOIN coffee_items ci ON ci."id" = b."itemId"
    JOIN lots l ON l."id" = b."lotId"
    LEFT JOIN containers c ON c."id" = b."containerId"
    WHERE pcl."purchaseContractId" = ${purchaseContractId}
    ORDER BY pcl."lineNumber"
  `;

  return rows.map((row) => ({
    lineId: row.lineId,
    lineNumber: row.lineNumber,
    batchId: row.batchId,
    batchNumber: row.batchNumber,
    itemName: row.itemName,
    lotNumber: row.lotNumber,
    containerNumber: row.containerNumber,
    orderedKg: toQuantity(row.orderedKg),
    receivedKg: toQuantity(row.receivedKg),
    outstandingKg: toQuantity(dec(row.orderedKg).minus(dec(row.receivedKg))),
    bagWeightKg: toQuantity(row.bagWeightKg),
    orderedBags: Number(row.orderedBags),
    receivedBags: Number(row.receivedBags),
  }));
}
