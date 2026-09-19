import type { Tx } from '@/lib/db';
import { transaction } from '@/lib/db';
import {
  dec,
  toMoney,
  toUnitCost,
  toQuantity,
  sum,
  allocateProportionally,
  type Decimal,
  type DecimalInput,
} from '@/lib/money';
import { ACCOUNT_KEYS, DOC_TYPES, SHIPMENT_STATUSES_LANDED } from '@/lib/constants';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { postJournalEntry, reverseJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { writeAudit } from '@/lib/services/audit';
import { repairSharedContainerAssignments } from '@/lib/services/shipment';
import { NO_TAX, resolveTaxCode, supplierGrossPayable, supplierInvoiceIncludesInputTax } from '@/lib/services/tax';
import { computePurchaseTotals } from '@/lib/calc/purchase';
import { shortDocumentNumber } from '@/lib/short-number';
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
    select: { taxEnabled: true, country: true },
  });
  const vendor = await tx.vendor.findFirst({
    where: { id: input.vendorId, companyId: input.companyId },
    select: { country: true },
  });
  // A foreign exporter does not invoice the buyer's VAT/TVA. Forcing the
  // statutory rate onto that purchase is how AP was overstated by 20%.
  const taxOnInvoice = supplierInvoiceIncludesInputTax(vendor?.country, company.country);

  const lines = [];
  for (const line of input.lines) {
    const code = taxOnInvoice
      ? await resolveTaxCode(tx, {
          companyId: input.companyId,
          taxEnabled: company.taxEnabled,
          taxCodeId: line.taxCodeId,
          appliesTo: 'PURCHASE',
        })
      : NO_TAX;
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
    // Whichever reference the supplier gave; the calc mirrors the missing one.
    const batchNumber = (line.batchNumber?.trim() || line.lotNumber?.trim()) ?? '';
    if (!batchNumber) continue;

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
      where: { companyId, lotNumber: (line.lotNumber?.trim() || batchNumber) },
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

/**
 * When the supplier expects to be paid.
 *
 * The purchase order does not ask. It offered Net 7 / Net 30 / Net 60, which
 * the client trades on none of; it then offered a date, and §1 does not list
 * one either. So the contract takes the supplier's standing terms, and where
 * there are none it is due on its own date — which is what an invoice with no
 * stated terms means anyway. A caller may still supply a date, and the
 * supplier's ledger is where a different arrangement is recorded.
 *
 * `paymentTermDays` is still stored, because the payables ageing and the
 * supplier's standing terms are both expressed in days — it is derived from
 * the two dates rather than driving them.
 */
function resolveDueDate(
  documentDate: Date,
  chosen: Date | null | undefined,
  standingTermDays: number | null | undefined,
): { dueDate: Date; termDays: number } {
  if (chosen) {
    const days = Math.max(0, Math.round((chosen.getTime() - documentDate.getTime()) / 86_400_000));
    return { dueDate: chosen, termDays: days };
  }

  const days = standingTermDays ?? 0;
  return { dueDate: new Date(documentDate.getTime() + days * 86_400_000), termDays: days };
}

export async function createPurchaseContract(input: PurchaseContractInput, userId: string) {
  return transaction(async (tx) => {
    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, companyId: input.companyId },
      select: { id: true, vendorName: true, paymentTermDays: true },
    });
    if (!vendor) throw new NotFoundError('Supplier');

    // A date the user picked, or the supplier's standing terms, or the
    // contract's own date. Zero-day terms are real and must still produce a
    // due date, or the contract can never appear as overdue on the payables
    // ageing.
    const { dueDate, termDays } = resolveDueDate(
      input.contractDate,
      input.dueDate,
      vendor.paymentTermDays,
    );

    for (const line of input.lines) {
      const item = await tx.coffeeItem.findFirst({
        where: { id: line.itemId, companyId: input.companyId },
        select: { id: true },
      });
      if (!item) throw new NotFoundError('Coffee item');
    }

    await assertTraceabilityNumbersAreFree(tx, input.companyId, input.lines);

    const totals = computePurchaseTotals(await applyServerTaxRates(tx, input));
    const contractNumber = await nextReference(tx, {
      companyId: input.companyId,
      docType: DOC_TYPES.PURCHASE_CONTRACT,
    });

    /**
     * The supplier's reference, or ours when they have not given one.
     *
     * Demanding a unique reference before the contract could be saved meant
     * inventing one at the moment somebody was trying to record a deal — and
     * an invented reference matches nothing on the supplier's paperwork, which
     * is the only thing the field is for. The FID number is already unique, so
     * its short form — "PO 3", the way anybody says it — stands in until the
     * real reference arrives. The long FID-MA-PO-000003 never reaches a screen.
     */
    const reference = input.contractReference?.trim() || shortDocumentNumber(contractNumber, 'PO');
    await assertReferenceIsFree(tx, input.companyId, reference);

    const contract = await tx.purchaseContract.create({
      data: {
        companyId: input.companyId,
        contractNumber,
        contractReference: reference,
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
        containers: input.containers ?? totals.totalContainers,
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

    const reference = input.contractReference?.trim() || shortDocumentNumber(existing.contractNumber, 'PO');
    await assertReferenceIsFree(tx, input.companyId, reference, id);
    await assertTraceabilityNumbersAreFree(tx, input.companyId, input.lines, id);

    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, companyId: input.companyId },
      select: { paymentTermDays: true },
    });
    if (!vendor) throw new NotFoundError('Supplier');

    const totals = computePurchaseTotals(await applyServerTaxRates(tx, input));
    const { dueDate, termDays } = resolveDueDate(
      input.contractDate,
      input.dueDate,
      vendor.paymentTermDays,
    );

    await tx.purchaseContractLine.deleteMany({ where: { purchaseContractId: id } });

    const contract = await tx.purchaseContract.update({
      where: { id },
      data: {
        contractReference: reference,
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
        containers: input.containers ?? totals.totalContainers,
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
      include: {
        lines: { orderBy: { lineNumber: 'asc' } },
        vendor: true,
        company: { select: { country: true } },
      },
    });

    if (contract.lines.length === 0) {
      throw new BusinessRuleError('This contract has no lines and cannot be approved.');
    }

    const company = await getCompanyContext(tx, params.companyId);
    const postedAt = new Date();

    /*
     * --- 2: one shipment per line ------------------------------------------
     *
     * One purchase order is not one shipment. A single contract routinely
     * covers three containers of three coffees that sail on different
     * vessels, arrive on different days and go to different warehouses. One
     * job record for the lot could only say "arrived" once, and said it as
     * soon as the first container landed.
     *
     * So each line becomes a shipment of its own — its own item, its own
     * quantity, its own container, lot and batch, its own arrival — and the
     * contract is the parent that holds them. The order's own reference is
     * what ties them together on every screen.
     */
    const lotCache = new Map<string, string>();
    const containerCache = new Map<string, string>();
    const opened: Array<{ id: string; shipmentNumber: string; jobNumber: string }> = [];

    /*
     * How many containers each shipment carries.
     *
     * A line that names its container carries one. When the lines do not,
     * the count entered on the contract is shared out across them — two
     * containers over two lines is one each, three over two is two and one —
     * so the order's total is always the shipments' added up and never the
     * header figure repeated on every row.
     */
    const named = contract.lines.filter((l) => l.containerNumber).length;
    const unnamed = contract.lines.length - named;
    const spare = Math.max(0, contract.containers - named);
    const containersFor = (line: (typeof contract.lines)[number], index: number) => {
      if (line.containerNumber) return 1;
      const unnamedBefore = contract.lines.slice(0, index).filter((l) => !l.containerNumber).length;
      const share = Math.floor(spare / Math.max(unnamed, 1)) + (unnamedBefore < spare % Math.max(unnamed, 1) ? 1 : 0);
      return share;
    };

    for (const [lineIndex, line] of contract.lines.entries()) {
      const shipmentNumber = await nextReference(tx, { companyId: params.companyId, docType: DOC_TYPES.SHIPMENT });
      const jobNumber = await nextReference(tx, { companyId: params.companyId, docType: DOC_TYPES.JOB });

      const shipment = await tx.shipment.create({
        data: {
          companyId: params.companyId,
          shipmentNumber,
          jobNumber,
          purchaseContractId: contract.id,
          purchaseContractLineId: line.id,
          vendorId: contract.vendorId,
          itemId: line.itemId,
          quantityKg: line.quantityKg,
          bags: line.bags,
          containers: containersFor(line, lineIndex),
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
          notes: `Opened from line ${line.lineNumber} of ${contract.contractReference}.`,
        },
      });
      opened.push({ id: shipment.id, shipmentNumber, jobNumber });

      /**
       * The contract may not name the coffee yet.
       *
       * A supplier sells 42 MT of Screen 12 in March and decides in May which
       * lots fill it. The batch still has to exist from the moment the
       * contract is approved — it carries the money, the in-transit quantity
       * and the payable — so it is issued a placeholder identity derived from
       * the contract number, and flagged. The goods receipt replaces it with
       * the real lot, splitting it if the coffee arrived under several.
       *
       * A placeholder is never silent: it reads `ICUL/FID/002/1` — the
       * client's own order reference and the line — which nobody will mistake
       * for a supplier's lot number, and the batch cannot be sold until the
       * receipt has named it. It is built from the reference, not the FID
       * number, because the placeholder shows on every stock screen and the
       * FID number is the one thing the client asked never to see.
       */
      const traceabilityPending = !line.lotNumber && !line.batchNumber;
      const lotNumber = line.lotNumber ?? `${contract.contractReference}/${line.lineNumber}`;
      const batchNumber = line.batchNumber ?? lotNumber;

      // Lot: shared across lines that quote the same supplier lot number.
      let lotId = lotCache.get(lotNumber);
      if (!lotId) {
        const existingLot = await tx.lot.findFirst({
          where: { companyId: params.companyId, lotNumber },
          select: { id: true },
        });
        lotId =
          existingLot?.id ??
          (
            await tx.lot.create({
              data: {
                companyId: params.companyId,
                lotNumber,
                itemId: line.itemId,
                purchaseContractId: contract.id,
                originCountry: contract.origin,
              },
              select: { id: true },
            })
          ).id;
        lotCache.set(lotNumber, lotId);
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
          batchNumber,
          traceabilityPending,
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
    // Tax sits on AP only when the supplier billed it (same tax jurisdiction).
    // A foreign coffee exporter is owed the contract value, not the buyer's TVA.
    const payable = supplierGrossPayable({
      netAmount: contract.totalValue,
      taxAmount: contract.taxAmount,
      netAmountUsd: contract.totalValueUsd,
      taxAmountUsd: contract.taxAmountUsd,
      vendorCountry: contract.vendor.country,
      companyCountry: contract.company.country,
    });
    const taxOnSupplier = payable.taxOnSupplierInvoice && dec(contract.taxAmount).greaterThan(0);

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
          ...(opened.length === 1 ? { shipmentId: opened[0].id } : {}),
        },
        ...(taxOnSupplier
          ? [
              {
                accountKey: ACCOUNT_KEYS.VAT_INPUT,
                direction: 'DEBIT' as const,
                currency: contract.currency,
                amount: contract.taxAmount,
                rateToUsd: contract.rateToUsd,
                description: `Input tax on ${contract.contractNumber}`,
                purchaseContractId: contract.id,
              },
            ]
          : []),
        {
          accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
          direction: 'CREDIT',
          currency: contract.currency,
          amount: payable.amount,
          rateToUsd: contract.rateToUsd,
          description: `Payable to ${contract.vendor.vendorName}`,
          vendorId: contract.vendorId,
          purchaseContractId: contract.id,
          ...(opened.length === 1 ? { shipmentId: opened[0].id } : {}),
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
        shipments: opened.map((o) => o.shipmentNumber),
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

    // No stock movements exist yet, so the batches are simply retired — and
    // renamed, so a corrected copy of the order can use the names again.
    const retired = await tx.batch.findMany({ where: { purchaseContractId: contract.id }, select: { id: true, batchNumber: true } });
    for (const batch of retired) {
      await tx.batch.update({
        where: { id: batch.id },
        data: {
          status: 'INACTIVE',
          orderedQuantityKg: 0,
          inTransitQuantityKg: 0,
          batchNumber: `${batch.batchNumber} (reversed, was ${contract.contractNumber})`,
        },
      });
    }

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
  // Every shipment on the order, not just the first: each carries its own
  // containers and each may need the same repair.
  const shipments = await tx.shipment.findMany({
    where: { purchaseContractId },
    select: { id: true, companyId: true },
  });
  for (const shipment of shipments) {
    await repairSharedContainerAssignments(tx, shipment.companyId, shipment.id);
  }

  const rows = await tx.$queryRaw<
    Array<{
      lineId: string;
      lineNumber: number;
      batchId: string;
      batchNumber: string;
      shipmentId: string;
      shipmentStatus: string;
      itemName: string;
      lotNumber: string;
      containerNumber: string | null;
      orderedKg: string;
      receivedKg: string;
      bagWeightKg: string;
      orderedBags: string;
      receivedBags: string;
      traceabilityPending: boolean;
    }>
  >`
    SELECT pcl."id" AS "lineId", pcl."lineNumber", b."id" AS "batchId", b."batchNumber",
           b."shipmentId", s."status"::text AS "shipmentStatus",
           ci."itemName", l."lotNumber", c."containerNumber",
           b."orderedQuantityKg"::text AS "orderedKg",
           b."receivedQuantityKg"::text AS "receivedKg",
           b."bagWeightKg"::text       AS "bagWeightKg",
           b."orderedBags"::text       AS "orderedBags",
           b."receivedBags"::text      AS "receivedBags",
           b."traceabilityPending"     AS "traceabilityPending"
    FROM purchase_contract_lines pcl
    JOIN batches b ON b."purchaseContractLineId" = pcl."id"
    JOIN shipments s ON s."id" = b."shipmentId"
    JOIN coffee_items ci ON ci."id" = b."itemId"
    JOIN lots l ON l."id" = b."lotId"
    LEFT JOIN containers c ON c."id" = b."containerId"
    WHERE pcl."purchaseContractId" = ${purchaseContractId}
    ORDER BY pcl."lineNumber", b."createdAt", b."batchNumber"
  `;

  /*
   * Which containers each batch will be received from.
   *
   * A batch opened under the current rule has one container. An older job
   * carries several batches and several containers on one shipment, some of
   * them not yet tied to a batch — the client's 40,080 KG in two containers
   * beside 21,000 KG in one. Every container on the shipment is handed to a
   * batch: its own where it has one, otherwise the batch with the most
   * coffee per container so far, so the receive screen shows one row per
   * container and none of them goes missing.
   */
  const containers = await tx.container.findMany({
    where: { shipmentId: { in: [...new Set(rows.map((r) => r.shipmentId))] } },
    orderBy: { createdAt: 'asc' },
    select: { containerNumber: true, shipmentId: true, batches: { select: { id: true } } },
  });
  const containersByBatch = new Map<string, string[]>();
  for (const row of rows) containersByBatch.set(row.batchId, []);
  for (const shipmentId of new Set(rows.map((r) => r.shipmentId))) {
    const onShipment = rows.filter((r) => r.shipmentId === shipmentId);
    for (const container of containers.filter((c) => c.shipmentId === shipmentId)) {
      const owner = onShipment.find((r) => container.batches.some((b) => b.id === r.batchId));
      const target =
        owner ??
        onShipment.reduce((best, r) => {
          const perContainer = (r: (typeof onShipment)[number]) =>
            Number(r.orderedKg) / ((containersByBatch.get(r.batchId)?.length ?? 0) + 1);
          return perContainer(r) > perContainer(best) ? r : best;
        }, onShipment[0]);
      if (target) containersByBatch.get(target.batchId)?.push(container.containerNumber);
    }
  }

  return rows.map((row) => ({
    lineId: row.lineId,
    lineNumber: row.lineNumber,
    batchId: row.batchId,
    batchNumber: row.batchNumber,
    shipmentId: row.shipmentId,
    /** Landed, so it can be received; the receive screen ticks these by default. */
    arrived: SHIPMENT_STATUSES_LANDED.includes(row.shipmentStatus),
    itemName: row.itemName,
    lotNumber: row.lotNumber,
    containerNumber: row.containerNumber,
    /** Every container this batch is received from, its own first. */
    containerNumbers: containersByBatch.get(row.batchId) ?? [],
    orderedKg: toQuantity(row.orderedKg),
    receivedKg: toQuantity(row.receivedKg),
    outstandingKg: toQuantity(dec(row.orderedKg).minus(dec(row.receivedKg))),
    bagWeightKg: toQuantity(row.bagWeightKg),
    orderedBags: Number(row.orderedBags),
    receivedBags: Number(row.receivedBags),
    /** True when the contract named no lot, so the receipt must. */
    traceabilityPending: row.traceabilityPending,
  }));
}

export type SplitContainerPart = { quantityKg: string | number; containerNumber?: string | null };

/**
 * Split one ordered line into containers, on a posted order.
 *
 * The client's own case: 40,080 KG of Screen 18 entered as one row, sailing
 * in two containers. Each container has to load, arrive and be received on
 * its own, so each needs its own row — its own contract line, shipment, batch
 * and (until the receipt names it) placeholder lot. This gives it that after
 * the fact, without touching the books: the order's value, the payable and
 * the journal are exactly what they were, because the parts are the line
 * divided, never added to. Money, bags and any expense already capitalised
 * are shared in proportion to the kilograms, with the rounding remainder on
 * the first part so the totals are unchanged to the last cent.
 *
 * Refused once anything has been received, sold or reserved against the
 * line: by then the batch is stock, and stock is split by a transfer, not by
 * rewriting where it came from.
 */
export async function splitContractLine(params: {
  companyId: string;
  contractId: string;
  lineId: string;
  userId: string;
  parts: SplitContainerPart[];
}) {
  if (params.parts.length < 2) throw new BusinessRuleError('Split into at least two containers.');

  return transaction(async (tx) => {
    const contract = await tx.purchaseContract.findFirst({
      where: { id: params.contractId, companyId: params.companyId },
      select: { id: true, status: true, contractReference: true, containers: true, currency: true },
    });
    if (!contract) throw new NotFoundError('Purchase contract');
    if (contract.status !== 'POSTED') {
      throw new BusinessRuleError('Only an approved order can be split into containers. A draft is simply edited.');
    }

    const line = await tx.purchaseContractLine.findFirst({
      where: { id: params.lineId, purchaseContractId: contract.id },
      include: {
        batches: { where: { status: 'ACTIVE' }, include: { lot: true, invoiceLines: { select: { id: true } } } },
        shipments: { select: { id: true } },
      },
    });
    if (!line) throw new NotFoundError('Contract line');
    if (line.batches.length !== 1) {
      throw new BusinessRuleError('This line has already been split or received under several batches; split the remaining container from the goods receipt instead.');
    }
    const batch = line.batches[0];
    if (dec(batch.receivedQuantityKg).greaterThan(0) || batch.invoiceLines.length > 0 || dec(batch.allocatedQuantityKg).greaterThan(0)) {
      throw new BusinessRuleError('Coffee on this line has already been received or sold. Split what is left at the goods receipt instead.');
    }
    const shipment = await tx.shipment.findFirst({
      where: { id: batch.shipmentId, companyId: params.companyId },
      include: { containerList: { orderBy: { createdAt: 'asc' } } },
    });
    if (!shipment) throw new NotFoundError('Shipment');

    const quantities = params.parts.map((p) => toQuantity(dec(p.quantityKg)));
    if (quantities.some((q) => q.lessThanOrEqualTo(0))) throw new BusinessRuleError('Every container needs a quantity.');
    const total = sum(quantities);
    if (!total.equals(dec(line.quantityKg))) {
      throw new BusinessRuleError(
        `The containers add up to ${total.toString()} KG but the line is ${dec(line.quantityKg).toString()} KG. They have to match.`,
      );
    }

    // Every figure on the line, shared by kilograms so the parts add back up.
    const share = (amount: DecimalInput) => allocateProportionally(amount, quantities);
    const subtotals = share(line.lineSubtotal);
    const freights = share(line.freightAllocated);
    const others = share(line.otherChargesAllocated);
    const totals = share(line.lineTotal);
    const bags = allocateProportionally(dec(line.bags), quantities).map((b) => Number(b.toDecimalPlaces(0)));
    const purchaseCosts = share(batch.purchaseCostUsd);
    const capitalised = share(batch.capitalisedCostUsd);
    const unitQuantities = share(line.quantity);
    const taxes = share(line.taxAmount);
    const taxesUsd = share(line.taxAmountUsd);

    const maxLine = await tx.purchaseContractLine.aggregate({
      where: { purchaseContractId: contract.id },
      _max: { lineNumber: true },
    });
    let nextLineNumber = (maxLine._max.lineNumber ?? 0) + 1;

    // Containers the parts name: an existing row on this shipment is moved,
    // anything else is created. The original batch keeps its own where the
    // first part names it or names nothing.
    const containerByNumber = new Map(shipment.containerList.map((c) => [c.containerNumber, c.id]));
    const resolveContainer = async (number: string | null | undefined, shipmentId: string, kg: Decimal, bagCount: number) => {
      const trimmed = number?.trim();
      if (!trimmed) return null;
      const existing =
        containerByNumber.get(trimmed) ??
        (await tx.container.findFirst({ where: { companyId: params.companyId, containerNumber: trimmed }, select: { id: true } }))?.id;
      if (existing) {
        await tx.container.update({ where: { id: existing }, data: { shipmentId, purchaseContractId: contract.id, netWeightKg: kg, bags: bagCount } });
        return existing;
      }
      const created = await tx.container.create({
        data: { companyId: params.companyId, containerNumber: trimmed, purchaseContractId: contract.id, shipmentId, netWeightKg: kg, bags: bagCount },
        select: { id: true },
      });
      return created.id;
    };

    const created: Array<{ lineId: string; shipmentId: string; batchId: string; quantityKg: string }> = [];

    for (const [index, part] of params.parts.entries()) {
      const kg = quantities[index];
      if (index === 0) {
        // The original line, shipment and batch become the first container.
        await tx.purchaseContractLine.update({
          where: { id: line.id },
          data: {
            quantity: unitQuantities[0],
            quantityKg: kg,
            bags: bags[0],
            lineSubtotal: subtotals[0],
            freightAllocated: freights[0],
            otherChargesAllocated: others[0],
            lineTotal: totals[0],
            taxAmount: taxes[0],
            taxAmountUsd: taxesUsd[0],
            containers: 1,
            containerNumber: part.containerNumber?.trim() || line.containerNumber,
          },
        });
        const containerId = (await resolveContainer(part.containerNumber ?? line.containerNumber, shipment.id, kg, bags[0])) ?? batch.containerId;
        await tx.shipment.update({ where: { id: shipment.id }, data: { quantityKg: kg, bags: bags[0], containers: 1 } });
        await tx.batch.update({
          where: { id: batch.id },
          data: {
            orderedQuantityKg: kg,
            inTransitQuantityKg: kg,
            orderedBags: bags[0],
            purchaseCostUsd: purchaseCosts[0],
            capitalisedCostUsd: capitalised[0],
            containerId,
          },
        });
        created.push({ lineId: line.id, shipmentId: shipment.id, batchId: batch.id, quantityKg: kg.toString() });
        continue;
      }

      const lineNumber = nextLineNumber++;
      const newLine = await tx.purchaseContractLine.create({
        data: {
          purchaseContractId: contract.id,
          lineNumber,
          itemId: line.itemId,
          quantity: unitQuantities[index],
          unit: line.unit,
          quantityKg: kg,
          unitPrice: line.unitPrice,
          unitPriceKg: line.unitPriceKg,
          lineSubtotal: subtotals[index],
          freightAllocated: freights[index],
          otherChargesAllocated: others[index],
          lineTotal: totals[index],
          unitCostKg: line.unitCostKg,
          containers: 1,
          lotNumber: line.lotNumber,
          batchNumber: line.batchNumber ? `${line.batchNumber}/${index + 1}` : null,
          containerNumber: part.containerNumber?.trim() || null,
          bags: bags[index],
          bagWeightKg: line.bagWeightKg,
          containerType: line.containerType,
          taxCodeId: line.taxCodeId,
          taxRatePct: line.taxRatePct,
          taxAmount: taxes[index],
          taxAmountUsd: taxesUsd[index],
          notes: line.notes,
        },
      });

      const shipmentNumber = await nextReference(tx, { companyId: params.companyId, docType: DOC_TYPES.SHIPMENT });
      const jobNumber = await nextReference(tx, { companyId: params.companyId, docType: DOC_TYPES.JOB });
      const newShipment = await tx.shipment.create({
        data: {
          companyId: params.companyId,
          shipmentNumber,
          jobNumber,
          purchaseContractId: contract.id,
          purchaseContractLineId: newLine.id,
          vendorId: shipment.vendorId,
          customerId: shipment.customerId,
          itemId: line.itemId,
          quantityKg: kg,
          bags: bags[index],
          containers: 1,
          origin: shipment.origin,
          destination: shipment.destination,
          portOfLoading: shipment.portOfLoading,
          portOfDischarge: shipment.portOfDischarge,
          incoterm: shipment.incoterm,
          // The same voyage: what was marked on the original applies to
          // every container that sailed in it.
          status: shipment.status,
          documentStatus: shipment.documentStatus,
          shippingLineId: shipment.shippingLineId,
          bookingNumber: shipment.bookingNumber,
          billOfLading: shipment.billOfLading,
          vesselName: shipment.vesselName,
          voyageNumber: shipment.voyageNumber,
          loadingDate: shipment.loadingDate,
          etdDate: shipment.etdDate,
          etaDate: shipment.etaDate,
          ataDate: shipment.ataDate,
          clearanceDate: shipment.clearanceDate,
          deliveryDate: shipment.deliveryDate,
          createdById: params.userId,
        },
      });
      await tx.shipmentStatusHistory.create({
        data: {
          shipmentId: newShipment.id,
          fromStatus: null,
          toStatus: shipment.status,
          changedById: params.userId,
          notes: `Split from line ${line.lineNumber} of ${contract.contractReference}: container ${index + 1} of ${params.parts.length}.`,
        },
      });

      // Its own lot when the coffee is still unnamed; the supplier's lot when
      // the order named one, because one lot can fill several containers.
      let lotId = batch.lotId;
      let batchNumber = `${line.batchNumber ?? batch.lot.lotNumber}/${index + 1}`;
      if (batch.traceabilityPending) {
        const lotNumber = `${contract.contractReference}/${lineNumber}`;
        const lot =
          (await tx.lot.findFirst({ where: { companyId: params.companyId, lotNumber }, select: { id: true } })) ??
          (await tx.lot.create({
            data: { companyId: params.companyId, lotNumber, itemId: line.itemId, purchaseContractId: contract.id },
            select: { id: true },
          }));
        lotId = lot.id;
        batchNumber = lotNumber;
      }
      const containerId = await resolveContainer(part.containerNumber, newShipment.id, kg, bags[index]);

      const newBatch = await tx.batch.create({
        data: {
          companyId: params.companyId,
          batchNumber,
          traceabilityPending: batch.traceabilityPending,
          itemId: line.itemId,
          lotId,
          containerId,
          shipmentId: newShipment.id,
          purchaseContractId: contract.id,
          purchaseContractLineId: newLine.id,
          orderedQuantityKg: kg,
          inTransitQuantityKg: kg,
          orderedBags: bags[index],
          bagWeightKg: line.bagWeightKg,
          unitCost: batch.unitCost,
          currency: batch.currency,
          unitCostUsd: batch.unitCostUsd,
          purchaseCostUsd: purchaseCosts[index],
          capitalisedCostUsd: capitalised[index],
          landedUnitCostUsd: batch.landedUnitCostUsd,
        },
        select: { id: true },
      });
      created.push({ lineId: newLine.id, shipmentId: newShipment.id, batchId: newBatch.id, quantityKg: kg.toString() });
    }

    // Containers on the original shipment that no part claimed follow the
    // parts in order, so a numbered box never sits on a row with none.
    const claimed = new Set(params.parts.map((p) => p.containerNumber?.trim()).filter(Boolean));
    const spare = shipment.containerList.filter((c) => !claimed.has(c.containerNumber));
    const targets = created.slice(1).filter((_, i) => !params.parts[i + 1].containerNumber?.trim());
    for (const [i, container] of spare.slice(0, targets.length).entries()) {
      await tx.container.update({ where: { id: container.id }, data: { shipmentId: targets[i].shipmentId } });
      await tx.batch.update({ where: { id: targets[i].batchId }, data: { containerId: container.id } });
    }

    // The order's declared container count grows by the rows added.
    await tx.purchaseContract.update({
      where: { id: contract.id },
      data: { containers: Math.max(contract.containers, 0) + (params.parts.length - 1) },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'PURCHASE_LINE_SPLIT',
      entityType: 'PurchaseContract',
      entityId: contract.id,
      before: { lineId: line.id, quantityKg: dec(line.quantityKg).toString() },
      after: { containers: created.map((c) => c.quantityKg) },
    });

    return created;
  });
}

/**
 * Correct an approved order: reverse it and open an editable copy.
 *
 * An approved order is not edited in place — its payable and journal are
 * posted. When the order was entered wrongly and nothing has been received,
 * paid or spent against it, the honest correction is the one the books can
 * follow: the posting is reversed (the reversal is kept, dated today) and a
 * draft copy of the order opens with every line, ready to be put right and
 * approved again under the same reference. The same guards as a reversal
 * apply, so an order with coffee already in stock cannot be corrected this
 * way — it says so.
 */
export async function correctPurchaseContract(params: { id: string; companyId: string; userId: string; reason: string }) {
  const original = await transaction(async (tx) => {
    const contract = await tx.purchaseContract.findFirst({
      where: { id: params.id, companyId: params.companyId },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });
    if (!contract) throw new NotFoundError('Purchase contract');
    if (contract.status !== 'POSTED') throw new BusinessRuleError('Only an approved order can be corrected this way; a draft is edited directly.');
    return contract;
  });

  await reversePurchaseContract({ id: params.id, companyId: params.companyId, userId: params.userId, reason: params.reason });

  // The reference belongs to the trade, and the trade now lives on the copy.
  // The reversed record keeps a marked-up form of it so the two can never be
  // confused, and the copy takes the real one.
  await transaction((tx) =>
    tx.purchaseContract.update({
      where: { id: params.id },
      data: { contractReference: `${original.contractReference} (reversed, was ${original.contractNumber})` },
    }),
  );

  const copy = await createPurchaseContract(
    {
      companyId: params.companyId,
      contractReference: original.contractReference,
      supplierContractNo: original.supplierContractNo,
      contractDate: original.contractDate,
      vendorId: original.vendorId,
      origin: original.origin,
      currency: original.currency,
      rateToUsd: original.rateToUsd.toString(),
      rateLocalPerUsd: original.rateLocalPerUsd.toString(),
      freightAmount: original.freightAmount.toString(),
      otherCharges: original.otherCharges.toString(),
      incoterm: original.incoterm,
      portOfLoading: original.portOfLoading,
      destination: original.destination,
      expectedShipmentDate: original.expectedShipmentDate,
      dueDate: original.dueDate,
      containers: original.containers,
      notes: original.notes,
      lines: original.lines.map((line) => ({
        itemId: line.itemId,
        lotNumber: line.lotNumber,
        batchNumber: line.batchNumber,
        containerNumber: line.containerNumber,
        containerType: line.containerType,
        quantity: line.quantity.toString(),
        unit: line.unit,
        unitPrice: line.unitPrice.toString(),
        bags: line.bags,
        bagWeightKg: line.bagWeightKg.toString(),
        taxCodeId: line.taxCodeId,
        taxRatePct: line.taxRatePct.toString(),
        notes: line.notes,
      })),
    },
    params.userId,
  );

  await transaction((tx) =>
    writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'PURCHASE_CONTRACT_CORRECTED',
      entityType: 'PurchaseContract',
      entityId: params.id,
      after: { replacedBy: copy.id, reason: params.reason },
    }),
  );

  return copy;
}

export type EditContainerInput = {
  companyId: string;
  shipmentId: string;
  userId: string;
  quantityKg?: string | number | null;
  bags?: number | null;
  containerNumber?: string | null;
  lotNumber?: string | null;
  batchNumber?: string | null;
  reason?: string | null;
};

/**
 * Correct one container on an approved order before it is received.
 *
 * "Only container 3 has the wrong KG" should not mean re-entering five. The
 * container's row — kilograms, bags, container number, lot, batch — is
 * changed in place, and the money follows the kilograms at the row's own
 * price: the supplier is owed more or less by exactly the difference, which
 * is posted as its own entry against the order so the books say what
 * happened and when. Old and new values, who and why, go to the audit log.
 *
 * Refused once the container has been received: by then its kilograms are
 * stock, and stock is corrected by the receipt, a transfer or a count.
 */
export async function editContainer(input: EditContainerInput) {
  return transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, companyId: input.companyId },
      include: {
        purchaseContract: { include: { vendor: true, company: true } },
        batches: { where: { status: 'ACTIVE' }, include: { lot: true, container: true } },
      },
    });
    if (!shipment) throw new NotFoundError('Shipment');
    const contract = shipment.purchaseContract;
    if (contract.status !== 'POSTED') throw new BusinessRuleError('Edit the draft order directly.');
    if (shipment.batches.length !== 1 || !shipment.purchaseContractLineId) {
      throw new BusinessRuleError('This shipment carries several batches. Divide it into containers first, then edit each.');
    }
    const batch = shipment.batches[0];
    if (dec(batch.receivedQuantityKg).greaterThan(0) || dec(batch.soldQuantityKg).greaterThan(0) || dec(batch.allocatedQuantityKg).greaterThan(0)) {
      throw new BusinessRuleError('This container has already been received. Correct the stock with a transfer or count, or reverse the goods receipt first.');
    }
    const line = await tx.purchaseContractLine.findUniqueOrThrow({ where: { id: shipment.purchaseContractLineId } });

    const before = {
      quantityKg: dec(line.quantityKg).toString(),
      bags: line.bags,
      containerNumber: batch.container?.containerNumber ?? line.containerNumber ?? null,
      lotNumber: batch.lot.lotNumber,
      batchNumber: batch.batchNumber,
    };

    // --- kilograms, and the money that follows them ------------------------
    const newKg = input.quantityKg !== undefined && input.quantityKg !== null && String(input.quantityKg).trim() !== ''
      ? toQuantity(dec(input.quantityKg))
      : dec(line.quantityKg);
    if (newKg.lessThanOrEqualTo(0)) throw new BusinessRuleError('The quantity must be more than zero.');
    const kgChanged = !newKg.equals(dec(line.quantityKg));
    const newBags = input.bags ?? (kgChanged && dec(line.bagWeightKg).greaterThan(0) ? Number(newKg.dividedBy(line.bagWeightKg).toDecimalPlaces(0)) : line.bags);

    if (kgChanged) {
      const subtotal = toMoney(newKg.times(line.unitPriceKg));
      const charges = dec(line.freightAllocated).plus(line.otherChargesAllocated);
      const total = toMoney(subtotal.plus(charges));
      const taxRate = dec(line.taxRatePct).dividedBy(100);
      const tax = toMoney(subtotal.times(taxRate));
      const deltaSubtotal = subtotal.minus(line.lineSubtotal);
      const deltaTax = tax.minus(line.taxAmount);
      const unitQuantity = line.unit === 'KG' ? newKg : line.unit === 'MT' ? newKg.dividedBy(1000) : dec(line.bagWeightKg).greaterThan(0) ? newKg.dividedBy(line.bagWeightKg) : newKg;
      const taxUsd = toMoney(contract.currency === 'USD' ? tax : tax.dividedBy(contract.rateToUsd));

      await tx.purchaseContractLine.update({
        where: { id: line.id },
        data: {
          quantity: toQuantity(unitQuantity),
          quantityKg: newKg,
          bags: newBags,
          lineSubtotal: subtotal,
          lineTotal: total,
          unitCostKg: newKg.greaterThan(0) ? toUnitCost(total.dividedBy(newKg)) : line.unitCostKg,
          taxAmount: tax,
          taxAmountUsd: taxUsd,
        },
      });

      const toUsd = (amount: Decimal) => toMoney(contract.currency === 'USD' ? amount : amount.dividedBy(contract.rateToUsd));
      const newSubtotal = dec(contract.subtotal).plus(deltaSubtotal);
      const newTax = dec(contract.taxAmount).plus(deltaTax);
      const newTotal = dec(contract.totalValue).plus(deltaSubtotal);
      await tx.purchaseContract.update({
        where: { id: contract.id },
        data: {
          subtotal: toMoney(newSubtotal),
          taxAmount: toMoney(newTax),
          taxAmountUsd: toUsd(newTax),
          totalValue: toMoney(newTotal),
          totalValueUsd: toUsd(newTotal),
          totalBags: contract.totalBags - line.bags + newBags,
        },
      });

      const unitCostUsd = dec(batch.unitCostUsd);
      await tx.batch.update({
        where: { id: batch.id },
        data: {
          orderedQuantityKg: newKg,
          inTransitQuantityKg: newKg,
          orderedBags: newBags,
          purchaseCostUsd: toMoney(newKg.times(unitCostUsd)),
        },
      });
      await tx.shipment.update({ where: { id: shipment.id }, data: { quantityKg: newKg, bags: newBags } });

      await postOrderAdjustment(tx, {
        contract,
        deltaSubtotal,
        deltaTax,
        shipmentId: shipment.id,
        userId: input.userId,
        description: `${contract.contractReference}: container corrected ${before.quantityKg} → ${newKg.toString()} KG${input.reason?.trim() ? ` — ${input.reason.trim()}` : ''}`,
      });
    } else if (input.bags !== undefined && input.bags !== null && input.bags !== line.bags) {
      await tx.purchaseContractLine.update({ where: { id: line.id }, data: { bags: newBags } });
      await tx.batch.update({ where: { id: batch.id }, data: { orderedBags: newBags } });
      await tx.shipment.update({ where: { id: shipment.id }, data: { bags: newBags } });
      await tx.purchaseContract.update({ where: { id: contract.id }, data: { totalBags: contract.totalBags - line.bags + newBags } });
    }

    // --- identity: container, lot, batch -------------------------------------
    const containerNumber = input.containerNumber?.trim();
    if (containerNumber && containerNumber !== before.containerNumber) {
      const existing = await tx.container.findFirst({ where: { companyId: input.companyId, containerNumber }, select: { id: true, shipmentId: true } });
      if (existing && existing.shipmentId && existing.shipmentId !== shipment.id) {
        throw new BusinessRuleError(`Container ${containerNumber} is already on another shipment.`);
      }
      const containerId = existing
        ? (await tx.container.update({ where: { id: existing.id }, data: { shipmentId: shipment.id, purchaseContractId: contract.id, netWeightKg: newKg, bags: newBags }, select: { id: true } })).id
        : batch.containerId
          ? (await tx.container.update({ where: { id: batch.containerId }, data: { containerNumber, netWeightKg: newKg, bags: newBags }, select: { id: true } })).id
          : (await tx.container.create({ data: { companyId: input.companyId, containerNumber, purchaseContractId: contract.id, shipmentId: shipment.id, netWeightKg: newKg, bags: newBags }, select: { id: true } })).id;
      await tx.batch.update({ where: { id: batch.id }, data: { containerId } });
      await tx.purchaseContractLine.update({ where: { id: line.id }, data: { containerNumber } });
    } else if (kgChanged && batch.containerId) {
      await tx.container.update({ where: { id: batch.containerId }, data: { netWeightKg: newKg, bags: newBags } });
    }

    const lotNumber = input.lotNumber?.trim();
    const batchNumber = input.batchNumber?.trim();
    if ((lotNumber && lotNumber !== before.lotNumber) || (batchNumber && batchNumber !== before.batchNumber)) {
      const nextLot = lotNumber || before.lotNumber;
      const nextBatch = batchNumber || (lotNumber ? lotNumber : before.batchNumber);
      let lotId = batch.lotId;
      if (nextLot !== before.lotNumber) {
        const sharedLot = await tx.batch.count({ where: { lotId: batch.lotId, NOT: { id: batch.id } } });
        if (sharedLot === 0) {
          await tx.lot.update({ where: { id: batch.lotId }, data: { lotNumber: nextLot } });
        } else {
          lotId = (
            (await tx.lot.findFirst({ where: { companyId: input.companyId, lotNumber: nextLot }, select: { id: true } })) ??
            (await tx.lot.create({ data: { companyId: input.companyId, lotNumber: nextLot, itemId: batch.itemId, purchaseContractId: contract.id }, select: { id: true } }))
          ).id;
        }
      }
      if (nextBatch !== before.batchNumber) {
        const clash = await tx.batch.findFirst({ where: { companyId: input.companyId, batchNumber: nextBatch, NOT: { id: batch.id } }, select: { id: true } });
        if (clash) throw new BusinessRuleError(`Batch ${nextBatch} already exists.`);
      }
      await tx.batch.update({ where: { id: batch.id }, data: { lotId, batchNumber: nextBatch, traceabilityPending: false } });
      await tx.purchaseContractLine.update({ where: { id: line.id }, data: { lotNumber: nextLot, batchNumber: nextBatch } });
    }

    const after = {
      quantityKg: newKg.toString(),
      bags: newBags,
      containerNumber: containerNumber || before.containerNumber,
      lotNumber: lotNumber || before.lotNumber,
      batchNumber: batchNumber || (lotNumber ? lotNumber : before.batchNumber),
    };
    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'CONTAINER_CORRECTED',
      entityType: 'Shipment',
      entityId: shipment.id,
      before,
      after: { ...after, reason: input.reason?.trim() || null },
    });
    return { before, after, contractId: contract.id };
  });
}

type AdjustableContract = {
  id: string;
  companyId: string;
  contractReference: string;
  currency: string;
  rateToUsd: Decimal;
  rateLocalPerUsd: Decimal;
  vendorId: string;
  vendor: { vendorName: string; country: string | null };
  company: { country: string | null; localCurrency: string };
};

/**
 * The supplier is owed more or less: post the difference against the order.
 *
 * Same accounts and rates as the order's own posting, under the same source,
 * so a reversal of the order takes this back out with it. Nothing is posted
 * when the difference is zero.
 */
async function postOrderAdjustment(
  tx: Tx,
  params: { contract: AdjustableContract; deltaSubtotal: Decimal; deltaTax: Decimal; shipmentId: string; userId: string; description: string },
) {
  const { contract, deltaSubtotal, deltaTax } = params;
  if (deltaSubtotal.isZero() && deltaTax.isZero()) return;
  const toUsd = (amount: Decimal) => toMoney(contract.currency === 'USD' ? amount : amount.dividedBy(contract.rateToUsd));
  const payable = supplierGrossPayable({
    netAmount: deltaSubtotal.abs(),
    taxAmount: deltaTax.abs(),
    netAmountUsd: toUsd(deltaSubtotal.abs()),
    taxAmountUsd: toUsd(deltaTax.abs()),
    vendorCountry: contract.vendor.country,
    companyCountry: contract.company.country,
  });
  const taxOnSupplier = payable.taxOnSupplierInvoice && !deltaTax.isZero();
  const up = deltaSubtotal.greaterThanOrEqualTo(0);
  await postJournalEntry(tx, {
    companyId: contract.companyId,
    entryDate: new Date(),
    description: params.description,
    sourceType: 'PURCHASE_CONTRACT',
    sourceId: contract.id,
    createdById: params.userId,
    localCurrency: contract.company.localCurrency,
    rateLocalPerUsd: contract.rateLocalPerUsd,
    lines: [
      {
        accountKey: ACCOUNT_KEYS.INVENTORY_IN_TRANSIT,
        direction: up ? 'DEBIT' : 'CREDIT',
        currency: contract.currency,
        amount: deltaSubtotal.abs(),
        rateToUsd: contract.rateToUsd,
        description: up ? 'More coffee on the order, in transit' : 'Less coffee on the order, in transit',
        purchaseContractId: contract.id,
        vendorId: contract.vendorId,
        shipmentId: params.shipmentId,
      },
      ...(taxOnSupplier
        ? [
            {
              accountKey: ACCOUNT_KEYS.VAT_INPUT,
              direction: (up ? 'DEBIT' : 'CREDIT') as 'DEBIT' | 'CREDIT',
              currency: contract.currency,
              amount: deltaTax.abs(),
              rateToUsd: contract.rateToUsd,
              description: 'Input tax on the correction',
              purchaseContractId: contract.id,
            },
          ]
        : []),
      {
        accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
        direction: up ? 'CREDIT' : 'DEBIT',
        currency: contract.currency,
        amount: payable.amount,
        rateToUsd: contract.rateToUsd,
        description: `Payable to ${contract.vendor.vendorName} corrected`,
        vendorId: contract.vendorId,
        purchaseContractId: contract.id,
        shipmentId: params.shipmentId,
      },
    ],
  });
}

export type AddContainerInput = {
  companyId: string;
  contractId: string;
  userId: string;
  itemId: string;
  quantityKg: string | number;
  /** Price per KG in the order's currency. */
  unitPriceKg: string | number;
  bags?: number | null;
  containerNumber?: string | null;
  lotNumber?: string | null;
  batchNumber?: string | null;
  reason?: string | null;
};

/**
 * One more container on an approved order.
 *
 * "The order had three containers; there should be four." The fourth goes
 * on the same order — its own row, shipment, batch and lot, pending loading
 * like the others — and the supplier is owed its value, posted as its own
 * entry against the order. No second, unrelated order.
 */
export async function addContainerToOrder(input: AddContainerInput) {
  return transaction(async (tx) => {
    const contract = await tx.purchaseContract.findFirst({
      where: { id: input.contractId, companyId: input.companyId },
      include: { vendor: true, company: true, lines: { orderBy: { lineNumber: 'asc' } } },
    });
    if (!contract) throw new NotFoundError('Purchase contract');
    if (contract.status !== 'POSTED') throw new BusinessRuleError('Add the container to the draft order directly.');
    const item = await tx.coffeeItem.findFirst({ where: { id: input.itemId, companyId: input.companyId } });
    if (!item) throw new NotFoundError('Coffee item');

    const kg = toQuantity(dec(input.quantityKg));
    const price = toUnitCost(dec(input.unitPriceKg));
    if (kg.lessThanOrEqualTo(0)) throw new BusinessRuleError('The quantity must be more than zero.');
    if (price.lessThanOrEqualTo(0)) throw new BusinessRuleError('The price must be more than zero.');
    const bagWeight = dec(item.bagWeightKg).greaterThan(0) ? dec(item.bagWeightKg) : dec(60);
    const bags = input.bags ?? Number(kg.dividedBy(bagWeight).toDecimalPlaces(0));
    const subtotal = toMoney(kg.times(price));
    // The same tax treatment as the order's other rows.
    const sample = contract.lines[0];
    const taxRatePct = sample ? dec(sample.taxRatePct) : dec(0);
    const tax = toMoney(subtotal.times(taxRatePct).dividedBy(100));
    const toUsd = (amount: Decimal) => toMoney(contract.currency === 'USD' ? amount : amount.dividedBy(contract.rateToUsd));
    const lineNumber = (contract.lines.at(-1)?.lineNumber ?? 0) + 1;
    const containerNumber = input.containerNumber?.trim() || null;
    const lotNumber = input.lotNumber?.trim() || null;
    const batchNumber = input.batchNumber?.trim() || null;

    const line = await tx.purchaseContractLine.create({
      data: {
        purchaseContractId: contract.id,
        lineNumber,
        itemId: item.id,
        quantity: kg,
        unit: 'KG',
        quantityKg: kg,
        unitPrice: price,
        unitPriceKg: price,
        lineSubtotal: subtotal,
        lineTotal: subtotal,
        unitCostKg: price,
        containers: 1,
        lotNumber,
        batchNumber,
        containerNumber,
        bags,
        bagWeightKg: bagWeight,
        taxCodeId: sample?.taxCodeId ?? null,
        taxRatePct,
        taxAmount: tax,
        taxAmountUsd: toUsd(tax),
        notes: input.reason?.trim() || null,
      },
    });

    const shipmentNumber = await nextReference(tx, { companyId: input.companyId, docType: DOC_TYPES.SHIPMENT });
    const jobNumber = await nextReference(tx, { companyId: input.companyId, docType: DOC_TYPES.JOB });
    const shipment = await tx.shipment.create({
      data: {
        companyId: input.companyId,
        shipmentNumber,
        jobNumber,
        purchaseContractId: contract.id,
        purchaseContractLineId: line.id,
        vendorId: contract.vendorId,
        itemId: item.id,
        quantityKg: kg,
        bags,
        containers: 1,
        origin: contract.origin,
        destination: contract.destination,
        portOfLoading: contract.portOfLoading,
        incoterm: contract.incoterm,
        status: 'CONTRACT_CREATED',
        documentStatus: 'DRAFT_PENDING',
        createdById: input.userId,
      },
    });
    await tx.shipmentStatusHistory.create({
      data: { shipmentId: shipment.id, fromStatus: null, toStatus: 'CONTRACT_CREATED', changedById: input.userId, notes: `Added to ${contract.contractReference} as container ${lineNumber}.` },
    });

    const traceabilityPending = !lotNumber && !batchNumber;
    const lotName = lotNumber ?? `${contract.contractReference}/${lineNumber}`;
    const lot =
      (await tx.lot.findFirst({ where: { companyId: input.companyId, lotNumber: lotName }, select: { id: true } })) ??
      (await tx.lot.create({ data: { companyId: input.companyId, lotNumber: lotName, itemId: item.id, purchaseContractId: contract.id }, select: { id: true } }));
    const batchName = batchNumber ?? lotName;
    if (await tx.batch.findFirst({ where: { companyId: input.companyId, batchNumber: batchName }, select: { id: true } })) {
      throw new BusinessRuleError(`Batch ${batchName} already exists.`);
    }
    let containerId: string | null = null;
    if (containerNumber) {
      const existing = await tx.container.findFirst({ where: { companyId: input.companyId, containerNumber }, select: { id: true, shipmentId: true } });
      if (existing?.shipmentId && existing.shipmentId !== shipment.id) throw new BusinessRuleError(`Container ${containerNumber} is already on another shipment.`);
      containerId = existing
        ? (await tx.container.update({ where: { id: existing.id }, data: { shipmentId: shipment.id, purchaseContractId: contract.id, netWeightKg: kg, bags }, select: { id: true } })).id
        : (await tx.container.create({ data: { companyId: input.companyId, containerNumber, purchaseContractId: contract.id, shipmentId: shipment.id, netWeightKg: kg, bags }, select: { id: true } })).id;
    }
    const unitCostUsd = toUnitCost(contract.currency === 'USD' ? price : price.dividedBy(contract.rateToUsd));
    const batch = await tx.batch.create({
      data: {
        companyId: input.companyId,
        batchNumber: batchName,
        traceabilityPending,
        itemId: item.id,
        lotId: lot.id,
        containerId,
        shipmentId: shipment.id,
        purchaseContractId: contract.id,
        purchaseContractLineId: line.id,
        orderedQuantityKg: kg,
        inTransitQuantityKg: kg,
        orderedBags: bags,
        bagWeightKg: bagWeight,
        unitCost: price,
        currency: contract.currency,
        unitCostUsd,
        purchaseCostUsd: toMoney(kg.times(unitCostUsd)),
        landedUnitCostUsd: unitCostUsd,
      },
      select: { id: true },
    });

    const newSubtotal = toMoney(dec(contract.subtotal).plus(subtotal));
    const newTax = toMoney(dec(contract.taxAmount).plus(tax));
    const newTotal = toMoney(dec(contract.totalValue).plus(subtotal));
    await tx.purchaseContract.update({
      where: { id: contract.id },
      data: {
        subtotal: newSubtotal,
        taxAmount: newTax,
        taxAmountUsd: toUsd(newTax),
        totalValue: newTotal,
        totalValueUsd: toUsd(newTotal),
        totalBags: contract.totalBags + bags,
        containers: contract.containers + 1,
      },
    });

    await postOrderAdjustment(tx, {
      contract,
      deltaSubtotal: subtotal,
      deltaTax: tax,
      shipmentId: shipment.id,
      userId: input.userId,
      description: `${contract.contractReference}: container ${lineNumber} added — ${item.itemName}, ${kg.toString()} KG${input.reason?.trim() ? ` — ${input.reason.trim()}` : ''}`,
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'CONTAINER_ADDED',
      entityType: 'PurchaseContract',
      entityId: contract.id,
      after: { lineNumber, item: item.itemName, quantityKg: kg.toString(), unitPriceKg: price.toString(), containerNumber, reason: input.reason ?? null },
    });

    return { lineId: line.id, shipmentId: shipment.id, batchId: batch.id, lineNumber };
  });
}
