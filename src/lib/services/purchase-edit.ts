import type { Tx } from '@/lib/db';
import { transaction } from '@/lib/db';
import { dec, toMoney, toQuantity, toUnitCost, type Decimal } from '@/lib/money';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { postJournalEntry, reverseJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { writeAudit } from '@/lib/services/audit';
import { lockBatch } from '@/lib/services/inventory';
import { documentSoldKg, restateSoldCost } from '@/lib/services/landed-cost';
import { supplierGrossPayable } from '@/lib/services/tax';
import {
  addContainerToOrder,
  applyServerTaxRates,
  assertReferenceIsFree,
  assertTraceabilityNumbersAreFree,
  computePurchaseTotals,
  editContainer,
  resolveDueDate,
  type PurchaseContractInput,
  type PurchaseLineInput,
} from '@/lib/services/purchase';

/**
 * Correct an approved purchase order where it stands.
 *
 * The client asked for every field of a purchase order to be editable, and an
 * approved order used to offer only "reverse it and enter it again" — which is
 * refused the moment any coffee has been received, so a wrong price on an
 * order already half sold could not be put right at all.
 *
 * What changes, and how the books follow:
 *
 *   Reference, supplier number, origin, terms, ports, dates, notes
 *       written in place.
 *
 *   Supplier, date, currency, rates, prices, freight, charges, tax
 *       the order's own posting is taken back and posted again at the new
 *       values, dated on the (corrected) order date, so the supplier's ledger
 *       reads as if it had been entered right. Taken-back pairs are hidden
 *       from every ledger and report; the audit log keeps both.
 *
 *   Price on coffee already received or sold
 *       the difference follows the coffee: the share still on the shelf goes
 *       to stock, the share already sold goes to cost of sales and onto the
 *       invoices that sold it — exactly what a late landed cost does. The
 *       share still at sea stays in transit. Stock value, cost per kilo and
 *       every profit figure move with it.
 *
 *   Coffee, kilograms, lot, batch, container
 *       changed on a container that has not been received. Once received,
 *       those are what the warehouse counted, and they are corrected through
 *       the receipt; the message says so.
 *
 *   Adding a container, removing one
 *       added as a new container of the order; removed only when nothing has
 *       happened to it — no receipt, no cost, no sale.
 *
 * Refused, with the reason: changing the supplier or the currency after the
 * supplier has been paid or credited against this order (the payments were
 * made to that supplier, in that currency), and lowering the order below what
 * has already been paid.
 */

export type ApprovedOrderLine = PurchaseLineInput & { id?: string | null };

export type EditApprovedOrderInput = Omit<PurchaseContractInput, 'lines'> & {
  contractId: string;
  userId: string;
  reason?: string | null;
  lines: ApprovedOrderLine[];
};

type BatchRow = {
  id: string;
  shipmentId: string;
  purchaseContractLineId: string | null;
  lotId: string;
  itemId: string;
  orderedQuantityKg: Decimal;
  receivedQuantityKg: Decimal;
  soldQuantityKg: Decimal;
  allocatedQuantityKg: Decimal;
  purchaseCostUsd: Decimal;
  capitalisedCostUsd: Decimal;
};

const same = (a: string | null | undefined, b: string | null | undefined) => (a?.trim() || null) === (b?.trim() || null);

export async function editApprovedPurchase(input: EditApprovedOrderInput) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text FROM purchase_contracts
      WHERE "id" = ${input.contractId} AND "companyId" = ${input.companyId}
      FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('Purchase contract');
    if (locked[0].status !== 'POSTED') {
      throw new BusinessRuleError('Only an approved order is corrected here. A draft is edited directly.');
    }

    const before = await tx.purchaseContract.findUniqueOrThrow({
      where: { id: input.contractId },
      include: {
        vendor: { select: { vendorName: true, country: true } },
        lines: { orderBy: { lineNumber: 'asc' } },
        shipments: { select: { id: true, purchaseContractLineId: true } },
      },
    });
    const company = await getCompanyContext(tx, input.companyId);
    const companyRow = await tx.company.findUniqueOrThrow({ where: { id: input.companyId }, select: { country: true } });

    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, companyId: input.companyId },
      select: { id: true, vendorName: true, country: true, paymentTermDays: true },
    });
    if (!vendor) throw new NotFoundError('Supplier');
    for (const line of input.lines) {
      const item = await tx.coffeeItem.findFirst({ where: { id: line.itemId, companyId: input.companyId }, select: { id: true } });
      if (!item) throw new NotFoundError('Coffee item');
    }

    const existingById = new Map(before.lines.map((l) => [l.id, l]));
    for (const line of input.lines) {
      if (line.id && !existingById.has(line.id)) {
        throw new BusinessRuleError('One of the containers does not belong to this order. Reload the page and try again.');
      }
    }

    const reference = input.contractReference?.trim() || before.contractReference;
    await assertReferenceIsFree(tx, input.companyId, reference, before.id);
    // New containers only: a kept container's own numbers are already its own.
    await assertTraceabilityNumbersAreFree(
      tx,
      input.companyId,
      input.lines.filter((l) => !l.id),
      before.id,
    );

    // --- which coffee each row carries -------------------------------------
    const batches: BatchRow[] = await tx.batch.findMany({
      where: { purchaseContractId: before.id, status: 'ACTIVE' },
      select: {
        id: true,
        shipmentId: true,
        purchaseContractLineId: true,
        lotId: true,
        itemId: true,
        orderedQuantityKg: true,
        receivedQuantityKg: true,
        soldQuantityKg: true,
        allocatedQuantityKg: true,
        purchaseCostUsd: true,
        capitalisedCostUsd: true,
      },
      orderBy: { batchNumber: 'asc' },
    });
    const lineOfShipment = new Map(before.shipments.map((s) => [s.id, s.purchaseContractLineId]));
    const lineOf = (b: BatchRow) =>
      b.purchaseContractLineId ?? lineOfShipment.get(b.shipmentId) ?? (before.lines.length === 1 ? before.lines[0].id : null);
    const batchesOf = (lineId: string) => batches.filter((b) => lineOf(b) === lineId);
    const hasMoved = (lineId: string) =>
      batchesOf(lineId).some(
        (b) => dec(b.receivedQuantityKg).greaterThan(0) || dec(b.soldQuantityKg).greaterThan(0) || dec(b.allocatedQuantityKg).greaterThan(0),
      );

    // --- what the supplier has already been paid or credited ---------------
    const [paidRow] = await tx.$queryRaw<Array<{ amount: string }>>`
      SELECT COALESCE(SUM(pa."amount"), 0)::text AS amount
      FROM payment_allocations pa
      JOIN payments p ON p."id" = pa."paymentId"
      WHERE pa."purchaseContractId" = ${before.id} AND p."status" = 'POSTED'
        AND NOT EXISTS (SELECT 1 FROM cheques ch WHERE ch."paymentId" = p."id" AND ch.status IN ('BOUNCED', 'CANCELLED'))`;
    const [creditRow] = await tx.$queryRaw<Array<{ amount: string }>>`
      SELECT COALESCE(SUM(cn."totalAmount"), 0)::text AS amount
      FROM credit_notes cn WHERE cn."purchaseContractId" = ${before.id} AND cn."status" = 'POSTED'`;
    const settled = dec(paidRow?.amount ?? 0).plus(dec(creditRow?.amount ?? 0));

    const currency = input.currency.toUpperCase();
    const vendorChanged = vendor.id !== before.vendorId;
    const currencyChanged = currency !== before.currency;
    if (settled.greaterThan(0) && vendorChanged) {
      throw new BusinessRuleError(
        `${before.vendor.vendorName} has already been paid or credited against this order, so it cannot be moved to ${vendor.vendorName}. Take back that payment first, then change the supplier.`,
      );
    }
    if (settled.greaterThan(0) && currencyChanged) {
      throw new BusinessRuleError(
        `This order has already been paid in ${before.currency}, so its currency cannot change. Take back that payment first.`,
      );
    }

    // --- the order as it should be -------------------------------------------
    const normalized: PurchaseContractInput = {
      ...input,
      contractReference: reference,
      currency,
      // The row ids are this function's business; the arithmetic takes rows.
      lines: input.lines.map((line) => {
        const row: PurchaseLineInput & { id?: string | null } = { ...line };
        delete row.id;
        return row;
      }),
    };
    const totals = computePurchaseTotals(await applyServerTaxRates(tx, normalized));

    const newPayable = supplierGrossPayable({
      netAmount: totals.totalValue,
      taxAmount: totals.taxAmount,
      netAmountUsd: totals.totalValueUsd,
      taxAmountUsd: totals.taxAmountUsd,
      vendorCountry: vendor.country,
      companyCountry: companyRow.country,
    });
    if (newPayable.amount.lessThan(settled.minus('0.005'))) {
      throw new BusinessRuleError(
        `${before.currency} ${settled.toFixed(2)} has already been paid on this order, which is more than the corrected ${currency} ${newPayable.amount.toFixed(2)}. Record the refund or credit from the supplier first.`,
      );
    }

    const changes: string[] = [];
    const describe = (n: number) => `Container ${n}`;
    /*
     * Whether the order's posting has to be taken back and posted again. A
     * correction to the notes or the port does not touch the books, and must
     * still save on an order whose month has been closed.
     */
    let booksChange =
      vendorChanged ||
      currencyChanged ||
      before.contractDate.getTime() !== input.contractDate.getTime() ||
      !dec(before.rateToUsd).equals(dec(input.rateToUsd)) ||
      !dec(before.rateLocalPerUsd).equals(dec(input.rateLocalPerUsd)) ||
      !toMoney(before.totalValue).equals(toMoney(totals.totalValue)) ||
      !toMoney(before.taxAmount).equals(toMoney(totals.taxAmount));

    // --- containers taken off the order --------------------------------------
    const keptIds = new Set(input.lines.map((l) => l.id).filter(Boolean) as string[]);
    for (const line of before.lines.filter((l) => !keptIds.has(l.id))) {
      await removeUntouchedContainer(tx, {
        companyId: input.companyId,
        contractId: before.id,
        line,
        batches: batchesOf(line.id),
        label: describe(line.lineNumber),
      });
      changes.push(`${describe(line.lineNumber)} removed`);
      booksChange = true;
    }

    // --- containers kept: what may change, and the change itself -------------
    const rowOf = new Map<number, string>(); // index in the input → line id
    for (const [index, line] of input.lines.entries()) {
      const computed = totals.lines[index];
      if (!line.id) continue;
      const existing = existingById.get(line.id)!;
      rowOf.set(index, existing.id);
      const label = describe(existing.lineNumber);

      const itemChanged = computed.itemId !== existing.itemId;
      const kgChanged = !toQuantity(computed.quantityKg).equals(toQuantity(existing.quantityKg));
      const identityChanged =
        !same(computed.lotNumber, existing.lotNumber) ||
        !same(computed.batchNumber, existing.batchNumber) ||
        !same(computed.containerNumber, existing.containerNumber);

      if ((itemChanged || kgChanged || identityChanged) && hasMoved(existing.id)) {
        const what = [itemChanged && 'coffee', kgChanged && 'kilograms', identityChanged && 'lot, batch or container number']
          .filter(Boolean)
          .join(', ');
        throw new BusinessRuleError(
          `${label} has already been received, so its ${what} cannot change here — they are what the warehouse counted. Correct them on the goods receipt, or take the receipt back first. Prices, rates and every other field can still be corrected.`,
        );
      }

      if (itemChanged) {
        await changeContainerCoffee(tx, { companyId: input.companyId, lineId: existing.id, itemId: computed.itemId, batches: batchesOf(existing.id), label });
        changes.push(`${label}: coffee changed`);
      }
      if (kgChanged || identityChanged) {
        // The container's own correction: kilograms, bags, container, lot and
        // batch, on the one shipment and batch that carry it.
        const shipmentId = batchesOf(existing.id)[0]?.shipmentId;
        if (!shipmentId) throw new BusinessRuleError(`${label} has no coffee record to correct.`);
        await editContainer({
          companyId: input.companyId,
          shipmentId,
          userId: input.userId,
          quantityKg: kgChanged ? computed.quantityKg.toString() : null,
          bags: computed.bags,
          containerNumber: identityChanged ? computed.containerNumber : null,
          lotNumber: identityChanged ? computed.lotNumber : null,
          batchNumber: identityChanged ? computed.batchNumber : null,
          reason: input.reason ?? null,
        });
        if (kgChanged) {
          changes.push(`${label}: ${toQuantity(existing.quantityKg).toString()} → ${toQuantity(computed.quantityKg).toString()} KG`);
          booksChange = true;
        }
        if (identityChanged) changes.push(`${label}: lot, batch or container number changed`);
      }
    }

    // --- containers added -----------------------------------------------------
    for (const [index, line] of input.lines.entries()) {
      if (line.id) continue;
      const computed = totals.lines[index];
      // Opened the way any container added to an approved order is; its
      // money is then set from the one calculation below with the rest.
      const added = await addContainerToOrder({
        companyId: input.companyId,
        contractId: before.id,
        userId: input.userId,
        itemId: computed.itemId,
        quantityKg: computed.quantityKg.toString(),
        unitPriceKg: computed.unitPriceKg.toString(),
        bags: computed.bags,
        containerNumber: computed.containerNumber,
        lotNumber: computed.lotNumber,
        batchNumber: computed.batchNumber,
        reason: input.reason ?? null,
      });
      rowOf.set(index, added.lineId);
      changes.push(`Container ${added.lineNumber} added`);
      booksChange = true;
    }

    // --- every row's money, from the one calculation -------------------------
    for (const [index] of input.lines.entries()) {
      const lineId = rowOf.get(index)!;
      const computed = totals.lines[index];
      await tx.purchaseContractLine.update({
        where: { id: lineId },
        data: {
          itemId: computed.itemId,
          quantity: computed.quantity,
          unit: computed.unit,
          quantityKg: computed.quantityKg,
          bags: computed.bags,
          bagWeightKg: computed.bagWeightKg,
          unitPrice: computed.unitPrice,
          unitPriceKg: computed.unitPriceKg,
          lineSubtotal: computed.lineSubtotal,
          freightAllocated: computed.freightAllocated,
          otherChargesAllocated: computed.otherChargesAllocated,
          lineTotal: computed.lineTotal,
          unitCostKg: computed.unitCostKg,
          taxCodeId: computed.taxCodeId,
          taxRatePct: computed.taxRatePct,
          taxAmount: computed.taxAmount,
          taxAmountUsd: computed.taxAmountUsd,
          notes: computed.notes,
        },
      });
      // The bag count on a container still at sea is the order's to say; once
      // received, it is what the warehouse counted.
      const own = await tx.batch.findMany({
        where: { purchaseContractId: before.id, status: 'ACTIVE', purchaseContractLineId: lineId },
        select: { id: true, shipmentId: true, receivedQuantityKg: true },
      });
      if (own.length === 1 && dec(own[0].receivedQuantityKg).isZero()) {
        await tx.batch.update({ where: { id: own[0].id }, data: { orderedBags: computed.bags, bagWeightKg: computed.bagWeightKg } });
        await tx.shipment.updateMany({ where: { id: own[0].shipmentId, purchaseContractLineId: lineId }, data: { bags: computed.bags } });
      }
    }

    const { dueDate, termDays } = resolveDueDate(input.contractDate, input.dueDate, vendor.paymentTermDays);
    const after = await tx.purchaseContract.update({
      where: { id: before.id },
      data: {
        contractReference: reference,
        supplierContractNo: input.supplierContractNo ?? null,
        contractDate: input.contractDate,
        vendorId: vendor.id,
        origin: input.origin ?? null,
        currency,
        rateToUsd: dec(input.rateToUsd),
        rateLocalPerUsd: dec(input.rateLocalPerUsd),
        subtotal: totals.subtotal,
        freightAmount: totals.freightAmount,
        otherCharges: totals.otherCharges,
        totalValue: totals.totalValue,
        totalValueUsd: totals.totalValueUsd,
        taxAmount: totals.taxAmount,
        taxAmountUsd: totals.taxAmountUsd,
        containers: input.containers ?? input.lines.length,
        totalBags: totals.totalBags,
        incoterm: input.incoterm ?? before.incoterm,
        portOfLoading: input.portOfLoading ?? null,
        destination: input.destination ?? null,
        expectedShipmentDate: input.expectedShipmentDate ?? null,
        paymentTermDays: termDays,
        dueDate,
        notes: input.notes ?? null,
      },
      include: { lines: { orderBy: { lineNumber: 'asc' } }, shipments: { select: { id: true } } },
    });

    // Every shipment of the order carries the order's supplier and route.
    await tx.shipment.updateMany({
      where: { purchaseContractId: before.id },
      data: {
        vendorId: vendor.id,
        origin: after.origin,
        destination: after.destination,
        portOfLoading: after.portOfLoading,
        incoterm: after.incoterm,
      },
    });

    // --- the coffee's cost follows the price ---------------------------------
    const moved = await restateBatchCosts(tx, {
      companyId: input.companyId,
      contractId: before.id,
      currency,
      rateToUsd: dec(input.rateToUsd),
      lines: after.lines,
    });

    // --- the books ------------------------------------------------------------
    if (booksChange) await repostOrder(tx, {
      companyId: input.companyId,
      userId: input.userId,
      contract: after,
      vendor,
      companyCountry: companyRow.country,
      localCurrency: company.localCurrency,
      reason: input.reason?.trim() || 'Order corrected',
    });

    if (moved.shelfUsd.isZero() === false || moved.soldUsd.isZero() === false) {
      await postCostFollowsCoffee(tx, {
        companyId: input.companyId,
        userId: input.userId,
        contractId: before.id,
        reference,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: dec(input.rateLocalPerUsd),
        byShipment: moved.byShipment,
      });
    }

    // What changed on the order itself, for the audit log.
    const header: Array<[string, unknown, unknown]> = [
      ['reference', before.contractReference, reference],
      ['supplier', before.vendor.vendorName, vendor.vendorName],
      ['date', before.contractDate.toISOString().slice(0, 10), input.contractDate.toISOString().slice(0, 10)],
      ['currency', before.currency, currency],
      ['rate to USD', before.rateToUsd.toString(), dec(input.rateToUsd).toString()],
      ['local rate', before.rateLocalPerUsd.toString(), dec(input.rateLocalPerUsd).toString()],
      ['total', before.totalValue.toString(), totals.totalValue.toString()],
    ];
    for (const [field, was, now] of header) {
      if (String(was) !== String(now)) changes.push(`${field}: ${String(was)} → ${String(now)}`);
    }

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'PURCHASE_CONTRACT_EDITED',
      entityType: 'PurchaseContract',
      entityId: before.id,
      before: {
        reference: before.contractReference,
        supplier: before.vendor.vendorName,
        date: before.contractDate,
        currency: before.currency,
        rateToUsd: before.rateToUsd.toString(),
        totalValue: before.totalValue.toString(),
        lines: before.lines.map((l) => ({ line: l.lineNumber, itemId: l.itemId, kg: l.quantityKg.toString(), price: l.unitPrice.toString() })),
      },
      after: {
        reference,
        supplier: vendor.vendorName,
        date: input.contractDate,
        currency,
        rateToUsd: dec(input.rateToUsd).toString(),
        totalValue: totals.totalValue.toString(),
        lines: after.lines.map((l) => ({ line: l.lineNumber, itemId: l.itemId, kg: l.quantityKg.toString(), price: l.unitPrice.toString() })),
        changes,
        reason: input.reason?.trim() || null,
        costMovedToStockUsd: moved.shelfUsd.toString(),
        costMovedToSalesUsd: moved.soldUsd.toString(),
      },
    });

    return { id: before.id, changes };
  });
}

/**
 * Each batch's cost at the corrected price, and where the difference went.
 *
 * The share of the difference is split by kilograms in the same three places
 * a late landed cost goes: what is sold, what is still at sea, and the rest on
 * the shelf. The sold share is written onto the invoices that sold it, so
 * every margin report moves with the ledger.
 */
async function restateBatchCosts(
  tx: Tx,
  params: {
    companyId: string;
    contractId: string;
    currency: string;
    rateToUsd: Decimal;
    lines: Array<{ id: string; unitCostKg: Decimal }>;
  },
) {
  const unitCostOf = new Map(params.lines.map((l) => [l.id, dec(l.unitCostKg)]));
  const shipments = await tx.shipment.findMany({
    where: { purchaseContractId: params.contractId },
    select: { id: true, purchaseContractLineId: true },
  });
  const lineOfShipment = new Map(shipments.map((s) => [s.id, s.purchaseContractLineId]));
  const batches = await tx.batch.findMany({
    where: { purchaseContractId: params.contractId, status: 'ACTIVE' },
    select: {
      id: true,
      shipmentId: true,
      purchaseContractLineId: true,
      orderedQuantityKg: true,
      receivedQuantityKg: true,
      soldQuantityKg: true,
      purchaseCostUsd: true,
      capitalisedCostUsd: true,
    },
    orderBy: { id: 'asc' },
  });

  let shelfUsd = dec(0);
  let soldUsd = dec(0);
  const byShipment = new Map<string, { shelfUsd: Decimal; soldUsd: Decimal }>();

  for (const batch of batches) {
    const lineId = batch.purchaseContractLineId ?? lineOfShipment.get(batch.shipmentId) ?? (params.lines.length === 1 ? params.lines[0].id : null);
    const unitCost = lineId ? unitCostOf.get(lineId) : undefined;
    if (!unitCost) continue;

    await lockBatch(tx, params.companyId, batch.id);
    const unitCostUsd = toUnitCost(params.currency === 'USD' ? unitCost : unitCost.dividedBy(params.rateToUsd));
    const orderedKg = dec(batch.orderedQuantityKg);
    const purchaseCostUsd = toMoney(orderedKg.times(unitCostUsd));
    const deltaUsd = toMoney(purchaseCostUsd.minus(dec(batch.purchaseCostUsd)));
    const landedUnitCostUsd = orderedKg.greaterThan(0)
      ? toUnitCost(purchaseCostUsd.plus(dec(batch.capitalisedCostUsd)).dividedBy(orderedKg))
      : unitCostUsd;

    await tx.batch.update({
      where: { id: batch.id },
      data: { unitCost, currency: params.currency, unitCostUsd, purchaseCostUsd, landedUnitCostUsd },
    });
    if (deltaUsd.isZero() || orderedKg.lessThanOrEqualTo(0)) continue;

    const soldKg = Decimal_min(await documentSoldKg(tx, params.companyId, batch.id), dec(batch.soldQuantityKg));
    const atSeaKg = Decimal_max(orderedKg.minus(dec(batch.receivedQuantityKg)), dec(0));
    const soldShare = toMoney(deltaUsd.times(soldKg).dividedBy(orderedKg));
    const atSeaShare = toMoney(deltaUsd.times(atSeaKg).dividedBy(orderedKg));
    const shelfShare = toMoney(deltaUsd.minus(soldShare).minus(atSeaShare));

    if (!soldShare.isZero()) {
      await restateSoldCost(tx, { companyId: params.companyId, batchId: batch.id, trueUpUsd: soldShare });
    }
    shelfUsd = shelfUsd.plus(shelfShare);
    soldUsd = soldUsd.plus(soldShare);
    const row = byShipment.get(batch.shipmentId) ?? { shelfUsd: dec(0), soldUsd: dec(0) };
    row.shelfUsd = row.shelfUsd.plus(shelfShare);
    row.soldUsd = row.soldUsd.plus(soldShare);
    byShipment.set(batch.shipmentId, row);
  }

  return { shelfUsd: toMoney(shelfUsd), soldUsd: toMoney(soldUsd), byShipment };
}

const Decimal_min = (a: Decimal, b: Decimal) => (a.lessThan(b) ? a : b);
const Decimal_max = (a: Decimal, b: Decimal) => (a.greaterThan(b) ? a : b);

/**
 * Take back the order's own postings and post it once more, as it now reads.
 *
 * Only the order's own entries: its approval and any container corrections
 * against it. The goods receipts, costs and sales that followed are their own
 * documents and stay exactly as they are.
 */
async function repostOrder(
  tx: Tx,
  params: {
    companyId: string;
    userId: string;
    contract: {
      id: string;
      contractReference: string;
      contractDate: Date;
      currency: string;
      rateToUsd: Decimal;
      rateLocalPerUsd: Decimal;
      totalValue: Decimal;
      totalValueUsd: Decimal;
      taxAmount: Decimal;
      taxAmountUsd: Decimal;
      shipments: Array<{ id: string }>;
    };
    vendor: { id: string; vendorName: string; country: string | null };
    companyCountry: string | null;
    localCurrency: string;
    reason: string;
  },
) {
  const { contract } = params;
  const live = await tx.journalEntry.findMany({
    where: {
      companyId: params.companyId,
      sourceType: 'PURCHASE_CONTRACT',
      sourceId: contract.id,
      status: 'POSTED',
      isReversal: false,
      reversedBy: { is: null },
    },
    select: { id: true },
    orderBy: { sourceSeq: 'asc' },
  });
  const today = new Date();
  for (const entry of live) {
    await reverseJournalEntry(tx, {
      companyId: params.companyId,
      sourceType: 'PURCHASE_CONTRACT',
      sourceId: contract.id,
      entryId: entry.id,
      createdById: params.userId,
      entryDate: today,
      reason: params.reason,
    });
  }

  const payable = supplierGrossPayable({
    netAmount: contract.totalValue,
    taxAmount: contract.taxAmount,
    netAmountUsd: contract.totalValueUsd,
    taxAmountUsd: contract.taxAmountUsd,
    vendorCountry: params.vendor.country,
    companyCountry: params.companyCountry,
  });
  const taxOnSupplier = payable.taxOnSupplierInvoice && dec(contract.taxAmount).greaterThan(0);
  const oneShipment = contract.shipments.length === 1 ? { shipmentId: contract.shipments[0].id } : {};

  await postJournalEntry(tx, {
    companyId: params.companyId,
    entryDate: contract.contractDate,
    description: `Purchase order ${contract.contractReference} — ${params.vendor.vendorName}`,
    sourceType: 'PURCHASE_CONTRACT',
    sourceId: contract.id,
    createdById: params.userId,
    localCurrency: params.localCurrency,
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
        vendorId: params.vendor.id,
        ...oneShipment,
      },
      ...(taxOnSupplier
        ? [
            {
              accountKey: ACCOUNT_KEYS.VAT_INPUT,
              direction: 'DEBIT' as const,
              currency: contract.currency,
              amount: contract.taxAmount,
              rateToUsd: contract.rateToUsd,
              description: `Input tax on ${contract.contractReference}`,
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
        description: `Payable to ${params.vendor.vendorName}`,
        vendorId: params.vendor.id,
        purchaseContractId: contract.id,
        ...oneShipment,
      },
    ],
  });
}

/**
 * The price difference on coffee that has left transit.
 *
 * The goods receipt moved the coffee from in transit to stock at the old
 * price, and each sale moved it on to cost of sales. The re-posted order puts
 * the whole corrected value in transit, so the difference on coffee no longer
 * there is moved to where the coffee now is. Posted under its own source so a
 * later correction of the same order, which re-posts only the order's own
 * entries, leaves this one standing — each correction moves only its own
 * difference.
 */
async function postCostFollowsCoffee(
  tx: Tx,
  params: {
    companyId: string;
    userId: string;
    contractId: string;
    reference: string;
    localCurrency: string;
    rateLocalPerUsd: Decimal;
    byShipment: Map<string, { shelfUsd: Decimal; soldUsd: Decimal }>;
  },
) {
  type Line = Parameters<typeof postJournalEntry>[1]['lines'][number];
  const lines: Line[] = [];
  const add = (accountKey: string, amount: Decimal, shipmentId: string, description: string) => {
    if (amount.isZero()) return;
    lines.push({
      accountKey,
      direction: amount.greaterThan(0) ? 'DEBIT' : 'CREDIT',
      currency: 'USD',
      amount: amount.abs(),
      rateToUsd: 1,
      description,
      purchaseContractId: params.contractId,
      shipmentId,
    } as Line);
  };
  for (const [shipmentId, row] of params.byShipment) {
    add(ACCOUNT_KEYS.INVENTORY, row.shelfUsd, shipmentId, 'Price correction on coffee in stock');
    add(ACCOUNT_KEYS.COST_OF_GOODS_SOLD, row.soldUsd, shipmentId, 'Price correction on coffee already sold');
    add(ACCOUNT_KEYS.INVENTORY_IN_TRANSIT, row.shelfUsd.plus(row.soldUsd).negated(), shipmentId, 'Price correction moved out of transit');
  }
  if (lines.length < 2) return;

  await postJournalEntry(tx, {
    companyId: params.companyId,
    entryDate: new Date(),
    description: `${params.reference}: price corrected on coffee already received`,
    sourceType: 'LANDED_COST',
    sourceId: params.contractId,
    createdById: params.userId,
    localCurrency: params.localCurrency,
    rateLocalPerUsd: params.rateLocalPerUsd,
    lines,
  });
}

/** A container's coffee, before anything has been received. */
async function changeContainerCoffee(
  tx: Tx,
  params: { companyId: string; lineId: string; itemId: string; batches: BatchRow[]; label: string },
) {
  for (const batch of params.batches) {
    const sharing = await tx.batch.count({ where: { lotId: batch.lotId, NOT: { id: batch.id } } });
    if (sharing > 0) {
      throw new BusinessRuleError(
        `${params.label} shares its lot number with another container. Give it a lot number of its own before changing its coffee.`,
      );
    }
    await tx.lot.update({ where: { id: batch.lotId }, data: { itemId: params.itemId } });
    await tx.batch.update({ where: { id: batch.id }, data: { itemId: params.itemId } });
    await tx.shipment.updateMany({ where: { id: batch.shipmentId, purchaseContractLineId: params.lineId }, data: { itemId: params.itemId } });
  }
}

/**
 * Take a container off the order, when nothing has happened to it.
 *
 * Everything that could depend on it is counted first and named in the
 * refusal: a receipt, a cost, a sale, a stock movement. The order's own
 * postings mention the container's shipment for analysis only, and those are
 * re-posted by the correction anyway, so that mention is cleared.
 */
async function removeUntouchedContainer(
  tx: Tx,
  params: {
    companyId: string;
    contractId: string;
    line: { id: string; lineNumber: number };
    batches: BatchRow[];
    label: string;
  },
) {
  const batchIds = params.batches.map((b) => b.id);
  const shipmentIds = [...new Set(params.batches.map((b) => b.shipmentId))];
  const containers = await tx.batch.findMany({ where: { id: { in: batchIds } }, select: { containerId: true } });
  const containerIds = containers.map((c) => c.containerId).filter(Boolean) as string[];

  const [receipts, receiptLines, movements, invoiceLines, invoices, expenses, transfers, credits, counts, money, allocations] =
    await Promise.all([
      tx.goodsReceipt.count({ where: { shipmentId: { in: shipmentIds } } }),
      tx.goodsReceiptLine.count({ where: { batchId: { in: batchIds } } }),
      tx.inventoryTransaction.count({ where: { OR: [{ batchId: { in: batchIds } }, { shipmentId: { in: shipmentIds } }] } }),
      tx.salesInvoiceLine.count({ where: { OR: [{ batchId: { in: batchIds } }, { shipmentId: { in: shipmentIds } }] } }),
      tx.salesInvoice.count({ where: { shipmentId: { in: shipmentIds } } }),
      tx.expense.count({
        where: {
          OR: [
            { shipmentId: { in: shipmentIds } },
            { batchId: { in: batchIds } },
            ...(containerIds.length ? [{ containerId: { in: containerIds } }] : []),
          ],
        },
      }),
      tx.stockTransferLine.count({ where: { batchId: { in: batchIds } } }),
      tx.creditNoteLine.count({ where: { batchId: { in: batchIds } } }),
      tx.stockCountLine.count({ where: { batchId: { in: batchIds } } }),
      Promise.all([
        tx.receipt.count({ where: { shipmentId: { in: shipmentIds } } }),
        tx.payment.count({ where: { shipmentId: { in: shipmentIds } } }),
      ]).then(([a, b]) => a + b),
      tx.overheadAllocationLine.count({ where: { shipmentId: { in: shipmentIds } } }),
    ]);

  // A cost booked to the whole order is spread onto every container, even one
  // it was not filed under; taking the container away would lose that share.
  const spread =
    params.batches.some((b) => !dec(b.capitalisedCostUsd).isZero()) ||
    (await tx.expenseBatchShare.count({ where: { batchId: { in: batchIds } } })) > 0;

  const blockers = [
    spread && 'shipment costs spread onto it',
    receipts + receiptLines > 0 && 'a goods receipt',
    movements > 0 && 'stock movements',
    invoiceLines + invoices + credits > 0 && 'a sale',
    expenses > 0 && 'a cost booked to it',
    transfers > 0 && 'a stock transfer',
    counts > 0 && 'a stock count',
    money > 0 && 'a receipt or payment',
    allocations > 0 && 'an overhead allocation',
  ].filter(Boolean);
  if (blockers.length > 0) {
    throw new BusinessRuleError(
      `${params.label} cannot be taken off the order because it already has ${blockers.join(', ')}. Take those back first, or keep the container and correct it instead.`,
    );
  }

  // Journal lines that name the shipment or batch for analysis. Only the
  // order's own entries can, at this point, and those are re-posted below.
  const foreign = await tx.journalLine.count({
    where: {
      OR: [{ shipmentId: { in: shipmentIds } }, { batchId: { in: batchIds } }],
      NOT: { journalEntry: { sourceType: 'PURCHASE_CONTRACT', sourceId: params.contractId } },
    },
  });
  if (foreign > 0) {
    throw new BusinessRuleError(`${params.label} is referred to by other entries in the books, so it cannot be taken off the order.`);
  }
  await tx.journalLine.updateMany({
    where: { OR: [{ shipmentId: { in: shipmentIds } }, { batchId: { in: batchIds } }] },
    data: { shipmentId: null, batchId: null },
  });

  await tx.inventoryBalance.deleteMany({ where: { batchId: { in: batchIds } } });
  await tx.batch.deleteMany({ where: { id: { in: batchIds } } });
  for (const containerId of containerIds) {
    const stillUsed = await tx.batch.count({ where: { containerId } });
    if (stillUsed === 0) await tx.container.delete({ where: { id: containerId } });
  }
  // Container rows filed on the shipment without coffee of their own go with
  // it; any that carry another row's coffee are only detached.
  for (const container of await tx.container.findMany({ where: { shipmentId: { in: shipmentIds } }, select: { id: true } })) {
    const stillUsed = await tx.batch.count({ where: { containerId: container.id } });
    if (stillUsed === 0) await tx.container.delete({ where: { id: container.id } });
    else await tx.container.update({ where: { id: container.id }, data: { shipmentId: null } });
  }
  for (const lotId of [...new Set(params.batches.map((b) => b.lotId))]) {
    const stillUsed = await tx.batch.count({ where: { lotId } });
    if (stillUsed === 0) await tx.lot.delete({ where: { id: lotId } });
  }
  await tx.shipmentStatusHistory.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await tx.shipmentDocumentStatusHistory.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  // A shipment still carrying another row's coffee stays.
  for (const shipmentId of shipmentIds) {
    const stillUsed = await tx.batch.count({ where: { shipmentId } });
    if (stillUsed === 0) await tx.shipment.delete({ where: { id: shipmentId } });
    else await tx.shipment.updateMany({ where: { id: shipmentId, purchaseContractLineId: params.line.id }, data: { purchaseContractLineId: null } });
  }
  await tx.purchaseContractLine.delete({ where: { id: params.line.id } });
}
