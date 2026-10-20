import { prisma } from '@/lib/db';
import { dec, toMoney, toUnitCost, percentage, type Decimal, type DecimalInput } from '@/lib/money';
import { formatQuantityKg } from '@/lib/format';
import type { Tx } from '@/lib/db';

/**
 * Where a shipment stands, for its profit: still selling, sold out but not yet
 * closed, or closed.
 *
 * The client reads two different things off a shipment that is still selling
 * — the profit on what has been sold, and the cost of what is still in the
 * warehouse — and only a closed shipment has a final result. Stock reaching
 * zero does not close it: the last expenses may still be coming, so closing
 * is a step someone takes (Closed, on the shipment's status), and the system
 * refuses it while anything is still open (`closureBlockers`).
 *
 * Customer payments play no part: profit is sales less the cost of what was
 * sold, whatever has been collected.
 */
export type ShipmentStage = 'ACTIVE' | 'SOLD_OUT_PENDING' | 'CLOSED';

export const SHIPMENT_STAGE_LABELS: Record<ShipmentStage, string> = {
  ACTIVE: 'Active / Partially Sold',
  SOLD_OUT_PENDING: 'Sold Out — Pending Financial Closure',
  CLOSED: 'Closed / Fully Sold',
};

export function shipmentStage(params: { remainingKg: DecimalInput; soldKg: DecimalInput; closed: boolean }): ShipmentStage {
  const nothingLeft = dec(params.remainingKg).lessThanOrEqualTo(0);
  // Coffee returned to stock after closing reopens the result: it is no
  // longer final while there is something left to sell.
  if (params.closed && nothingLeft) return 'CLOSED';
  if (nothingLeft && dec(params.soldKg).greaterThan(0)) return 'SOLD_OUT_PENDING';
  return 'ACTIVE';
}

/** The figures a shipment's profit is read from, all in the company's currency. */
export type ShipmentResult = {
  stage: ShipmentStage;
  /** Gross profit ÷ KG sold — the profit on a kilo actually sold. */
  profitPerKgSold: Decimal | null;
  /** Period costs booked to the shipment but not into stock. */
  periodCostsLocal: Decimal;
  /** The shipment's share of company overheads, when management allocated one. */
  overheadLocal: Decimal;
  /** Whether there is anything to deduct from gross profit at all. */
  hasDeductions: boolean;
  /** Gross profit less period costs and overhead: profit to date, or final once closed. */
  netLocal: Decimal;
  netMarginPct: Decimal | null;
};

export function shipmentResult(params: {
  stage: ShipmentStage;
  revenueLocal: Decimal;
  grossProfitLocal: Decimal;
  soldKg: Decimal;
  periodCostsLocal: Decimal;
  overheadLocal: Decimal;
}): ShipmentResult {
  const periodCostsLocal = toMoney(params.periodCostsLocal);
  const overheadLocal = toMoney(params.overheadLocal);
  const netLocal = toMoney(params.grossProfitLocal.minus(periodCostsLocal).minus(overheadLocal));
  return {
    stage: params.stage,
    profitPerKgSold: params.soldKg.greaterThan(0) ? toUnitCost(params.grossProfitLocal.dividedBy(params.soldKg)) : null,
    periodCostsLocal,
    overheadLocal,
    hasDeductions: !periodCostsLocal.isZero() || !overheadLocal.isZero(),
    netLocal,
    netMarginPct: params.revenueLocal.isZero() ? null : percentage(netLocal, params.revenueLocal),
  };
}

/**
 * Why a shipment record cannot be closed yet, or an empty list when it can.
 *
 * Closing makes its result final, so everything that could still move it has
 * to be settled first: no coffee left or still to arrive, and no draft sale,
 * credit note, receipt or expense against it.
 */
export async function closureBlockers(tx: Tx, companyId: string, shipmentId: string): Promise<string[]> {
  const shipment = await tx.shipment.findFirst({ where: { id: shipmentId, companyId }, select: { purchaseContractId: true } });
  if (!shipment) return ['Shipment not found.'];
  const batches = await tx.batch.findMany({ where: { companyId, shipmentId }, select: { id: true, inTransitQuantityKg: true } });
  const batchIds = batches.map((b) => b.id);
  const [onHand, draftSales, draftCredits, draftReceipts, draftExpenses] = await Promise.all([
    tx.inventoryBalance.aggregate({ where: { companyId, batchId: { in: batchIds } }, _sum: { onHandKg: true } }),
    tx.salesInvoice.count({ where: { companyId, status: 'DRAFT', lines: { some: { batchId: { in: batchIds } } } } }),
    tx.creditNote.count({ where: { companyId, status: 'DRAFT', lines: { some: { batchId: { in: batchIds } } } } }),
    tx.goodsReceipt.count({ where: { companyId, status: 'DRAFT', lines: { some: { batchId: { in: batchIds } } } } }),
    tx.expense.count({
      where: { companyId, status: 'DRAFT', OR: [{ shipmentId }, { shipmentId: null, purchaseContractId: shipment.purchaseContractId }] },
    }),
  ]);
  const left = dec(onHand._sum.onHandKg ?? 0);
  const arriving = batches.reduce((t, b) => t.plus(dec(b.inTransitQuantityKg)), dec(0));
  const reasons: string[] = [];
  if (left.greaterThan(0)) reasons.push(`${formatQuantityKg(left)} is still in stock. Sell it, or write it off with a stock count, first.`);
  if (arriving.greaterThan(0)) reasons.push(`${formatQuantityKg(arriving)} has not been received yet.`);
  if (draftSales > 0) reasons.push(`${draftSales} draft sales invoice(s) sell its coffee. Post or delete them first.`);
  if (draftCredits > 0) reasons.push(`${draftCredits} draft credit note(s) return its coffee. Post or delete them first.`);
  if (draftReceipts > 0) reasons.push(`${draftReceipts} draft goods receipt(s) are open for it. Post or delete them first.`);
  if (draftExpenses > 0) reasons.push(`${draftExpenses} draft expense(s) are booked to it. Post or delete them first.`);
  return reasons;
}

/** When each shipment record was last closed, for the records that are closed now. */
export async function getClosedDates(companyId: string, shipmentIds: string[]): Promise<Map<string, Date>> {
  if (shipmentIds.length === 0) return new Map();
  const rows = await prisma.shipmentStatusHistory.findMany({
    where: { toStatus: 'CLOSED', shipmentId: { in: shipmentIds }, shipment: { companyId, status: 'CLOSED' } },
    orderBy: { changedAt: 'desc' },
    select: { shipmentId: true, changedAt: true },
  });
  const closed = new Map<string, Date>();
  for (const row of rows) if (!closed.has(row.shipmentId)) closed.set(row.shipmentId, row.changedAt);
  return closed;
}

/**
 * What is still owed on each shipment (§7.5), by purchase order: by
 * customers for its coffee, and to suppliers for the coffee and for its
 * shipment costs.
 *
 * A customer's balance is never spread over shipments wholesale: each
 * invoice's outstanding amount is shared over its lines by value, and only
 * the lines that sold this shipment's coffee count. The supplier side is the
 * order's own payable (in its currency) and the unpaid shipment costs booked
 * to the order (in the company's currency).
 */
export type ShipmentOutstanding = { customerLocal: Decimal; supplierOrder: Decimal; supplierCurrency: string; shipmentCostsOwedLocal: Decimal };

export async function getShipmentOutstandings(companyId: string): Promise<Map<string, ShipmentOutstanding>> {
  const { getReceivables, getPayables } = await import('@/lib/services/receivables');
  const [receivables, payables, lines, contracts, company] = await Promise.all([
    getReceivables({ companyId, onlyOutstanding: true }),
    getPayables({ companyId, onlyOutstanding: true }),
    prisma.$queryRaw<Array<{ contractId: string; invoiceId: string; share: string }>>`
      SELECT b."purchaseContractId" AS "contractId", sil."salesInvoiceId" AS "invoiceId",
             (SUM(sil."lineTotal" + sil."taxAmount") / NULLIF(MAX(si."totalAmount"), 0))::text AS share
        FROM sales_invoice_lines sil
        JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
        JOIN batches b ON b."id" = sil."batchId"
       WHERE si."companyId" = ${companyId} AND si."status" = 'POSTED'
       GROUP BY b."purchaseContractId", sil."salesInvoiceId"`,
    prisma.purchaseContract.findMany({ where: { companyId }, select: { id: true, contractReference: true, currency: true } }),
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { localCurrency: true } }),
  ]);
  // In the company's currency: a local document as it stands, any other at its own rate.
  const inLocal = (d: { currency: string; outstandingAmount: Decimal; outstandingAmountUsd: Decimal; rateLocalPerUsd: Decimal }) =>
    d.currency === company.localCurrency ? d.outstandingAmount : d.outstandingAmountUsd.times(d.rateLocalPerUsd);
  const out = new Map<string, ShipmentOutstanding>();
  const entry = (contractId: string) => {
    let e = out.get(contractId);
    if (!e) {
      e = { customerLocal: dec(0), supplierOrder: dec(0), supplierCurrency: contracts.find((c) => c.id === contractId)?.currency ?? 'USD', shipmentCostsOwedLocal: dec(0) };
      out.set(contractId, e);
    }
    return e;
  };
  const owed = new Map(receivables.map((r) => [r.invoiceId, r]));
  for (const line of lines) {
    const r = owed.get(line.invoiceId);
    if (!r) continue;
    const e = entry(line.contractId);
    e.customerLocal = e.customerLocal.plus(inLocal(r).times(dec(line.share ?? 0)));
  }
  const byReference = new Map(contracts.map((c) => [c.contractReference, c.id]));
  for (const p of payables) {
    if (p.kind === 'CONTRACT' && contracts.some((c) => c.id === p.contractId)) {
      const e = entry(p.contractId);
      e.supplierOrder = e.supplierOrder.plus(p.outstandingAmount);
    } else if (p.kind === 'EXPENSE' && p.orderReference && byReference.has(p.orderReference)) {
      const e = entry(byReference.get(p.orderReference)!);
      e.shipmentCostsOwedLocal = e.shipmentCostsOwedLocal.plus(inLocal(p));
    }
  }
  for (const e of out.values()) {
    e.customerLocal = toMoney(e.customerLocal);
    e.supplierOrder = toMoney(e.supplierOrder);
    e.shipmentCostsOwedLocal = toMoney(e.shipmentCostsOwedLocal);
  }
  return out;
}
