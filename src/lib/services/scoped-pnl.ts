import { prisma } from '@/lib/db';
import { dec, toMoney, percentage, type Decimal } from '@/lib/money';
import { getCogsReport, getShipmentProfitability } from '@/lib/services/profitability';
import { getProfitAndLoss } from '@/lib/services/reports';

/**
 * Profit and loss for one shipment or one customer (client brief §6.8–6.9).
 *
 * Built from the same sources as the company statement and the shipment
 * reports — the invoice lines, the batch costing, the expenses booked to the
 * shipment — never from a formula of its own. Company overheads are not
 * spread over shipments or customers by this report: where management has
 * allocated a share to a shipment it is shown, and the company's operating
 * expenses for the period are shown beside the result as unallocated, so
 * nothing is invented and nothing counted twice.
 */
export type ScopedPair = { local: Decimal; usd: Decimal | null };

export type ScopedPnl = {
  scope: 'shipment' | 'customer';
  label: string;
  /** Shipment P&L covers the shipment's whole life; customer P&L the period. */
  periodNote: string;
  revenue: ScopedPair;
  cogs: ScopedPair;
  grossProfit: ScopedPair;
  grossMarginPct: Decimal | null;
  /** Period costs booked to the shipment, not capitalised into stock. */
  periodCosts: ScopedPair | null;
  /** Management's overhead share, where one was allocated. */
  allocatedOverhead: ScopedPair | null;
  /** Gross profit less the costs above — only where they are attributable. */
  netProfit: ScopedPair | null;
  netMarginPct: Decimal | null;
  /** Why there is no net figure, when there is none. */
  netNote: string | null;
  /** The company's operating expenses in the period, not attributed to this scope. */
  unallocatedCompanyExpensesLocal: Decimal;
  soldKg: Decimal;
  lines: number;
  /** How the USD equivalent is stated. */
  usdBasis: string;
};

const pair = (local: Decimal, usd: Decimal | null): ScopedPair => ({ local: toMoney(local), usd: usd === null ? null : toMoney(usd) });

/** One purchase order's shipment, over its whole life, as Shipment Profitability states it. */
export async function getShipmentPnl(params: { companyId: string; contractId: string; from: Date; to: Date }): Promise<ScopedPnl | null> {
  const rows = (await getShipmentProfitability({ companyId: params.companyId })).filter((r) => r.contractId === params.contractId);
  if (rows.length === 0) return null;
  const sum = (pick: (r: (typeof rows)[number]) => Decimal) => rows.reduce((t, r) => t.plus(pick(r)), dec(0));
  const rate = rows[0].rateLocalPerUsd;
  const usd = (local: Decimal) => (rate.greaterThan(0) ? local.dividedBy(rate) : null);
  const revenue = sum((r) => r.salesRevenueLocal);
  const cogs = sum((r) => r.allocatedLandedCostLocal);
  const gross = revenue.minus(cogs);
  const period = sum((r) => r.otherCostsLocal);
  const overhead = sum((r) => r.allocatedOverheadLocal);
  const net = gross.minus(period).minus(overhead);
  const company = await getProfitAndLoss({ companyId: params.companyId, from: params.from, to: params.to });
  return {
    scope: 'shipment',
    label: rows[0].contractReference,
    periodNote: 'The shipment over its whole life — every sale of its coffee and every cost booked to it, whatever the date.',
    revenue: pair(revenue, usd(revenue)),
    cogs: pair(cogs, usd(cogs)),
    grossProfit: pair(gross, usd(gross)),
    grossMarginPct: revenue.isZero() ? null : percentage(gross, revenue),
    periodCosts: pair(period, usd(period)),
    allocatedOverhead: overhead.isZero() ? null : pair(overhead, usd(overhead)),
    netProfit: pair(net, usd(net)),
    netMarginPct: revenue.isZero() ? null : percentage(net, revenue),
    netNote: overhead.isZero() ? 'No company overhead has been allocated to this shipment; net profit is after its own period costs only.' : null,
    unallocatedCompanyExpensesLocal: toMoney(company.totals.operatingExpensesLocal),
    soldKg: sum((r) => r.soldQuantityKg),
    lines: rows.length,
    usdBasis: `≈ USD at this order's USD/MAD rate, ${rate.toString()}.`,
  };
}

/** One customer, in the period: what they bought, what it cost, the margin. */
export async function getCustomerPnl(params: { companyId: string; customerId: string; from: Date; to: Date }): Promise<ScopedPnl | null> {
  const customer = await prisma.customer.findFirst({ where: { id: params.customerId, companyId: params.companyId }, select: { customerName: true } });
  if (!customer) return null;
  const lines = (await getCogsReport({ companyId: params.companyId, from: params.from, to: params.to })).filter((l) => l.customerId === params.customerId);
  // Price-only credit notes carry no coffee, so the cost-of-sales lines leave
  // them out; they still reduce what the customer was sold.
  const [priceCredits] = await prisma.$queryRaw<Array<{ local: string | null }>>`
    SELECT SUM(CASE WHEN cn."currency" = co."localCurrency" THEN cnl."lineTotal" ELSE cnl."lineTotalUsd" * cn."rateLocalPerUsd" END)::text AS local
      FROM credit_note_lines cnl
      JOIN credit_notes cn ON cn."id" = cnl."creditNoteId"
      JOIN companies co ON co."id" = cn."companyId"
     WHERE cn."companyId" = ${params.companyId} AND cn."customerId" = ${params.customerId}
       AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'
       AND NOT (cnl."quantityKg" > 0 OR cnl."costTotalUsd" > 0)
       AND cn."creditDate" BETWEEN ${params.from}::date AND ${params.to}::date`;
  const priceCreditLocal = dec(priceCredits?.local ?? 0);
  const revenue = lines.reduce((t, l) => t.plus(l.revenueLocal), dec(0)).minus(priceCreditLocal);
  const cogs = lines.reduce((t, l) => t.plus(l.cogsLocal), dec(0));
  const gross = revenue.minus(cogs);
  // Each line's dollars at the rate of the order its coffee came from; with
  // a price-only credit there is no order to state it at, so no total.
  const allRated = lines.every((l) => l.rateLocalPerUsd) && priceCreditLocal.isZero();
  const usdOf = (pick: (l: (typeof lines)[number]) => Decimal) =>
    allRated ? lines.reduce((t, l) => t.plus(pick(l).dividedBy(l.rateLocalPerUsd!)), dec(0)) : null;
  const revenueUsd = usdOf((l) => l.revenueLocal);
  const cogsUsd = usdOf((l) => l.cogsLocal);
  const company = await getProfitAndLoss({ companyId: params.companyId, from: params.from, to: params.to });
  return {
    scope: 'customer',
    label: customer.customerName,
    periodNote: 'Invoices and credit notes dated in the period.',
    revenue: pair(revenue, revenueUsd),
    cogs: pair(cogs, cogsUsd),
    grossProfit: pair(gross, revenueUsd && cogsUsd ? revenueUsd.minus(cogsUsd) : null),
    grossMarginPct: revenue.isZero() ? null : percentage(gross, revenue),
    periodCosts: null,
    allocatedOverhead: null,
    netProfit: null,
    netMarginPct: null,
    netNote: 'Company overheads are not allocated to customers, so there is no net profit per customer.',
    unallocatedCompanyExpensesLocal: toMoney(company.totals.operatingExpensesLocal),
    soldKg: lines.reduce((t, l) => t.plus(l.quantityKg), dec(0)),
    lines: lines.length,
    usdBasis: allRated
      ? '≈ USD with each line at the USD/MAD rate of the order its coffee came from.'
      : 'USD equivalent unavailable: a credit note has no order rate to state it at.',
  };
}
