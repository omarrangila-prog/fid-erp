import { prisma } from '@/lib/db';
import { dec, toMoney, type Decimal } from '@/lib/money';

/**
 * Exchange rates on a shipment: each transaction at its own, and a weighted
 * average only where one figure has to stand for several.
 *
 * The costing converted everything on an order at the purchase contract's
 * rate. On ICUL/FID/002 the coffee was bought at 9.85 MAD to the dollar but
 * every local cost was booked at 9.60, and the commission at 9.50 — so the
 * MAD 475,254.50 of costs read as MAD 487,967.79 once turned back at 9.85, and
 * the stock, cost of sales and profit in dirhams carried the difference.
 *
 * The rules this file keeps:
 *
 *   - A transaction's own amount, currency and rate are never replaced. Its
 *     local value is the one stored when it was entered.
 *   - A shipment total in local currency is the sum of those stored values,
 *     never "total dollars × one rate".
 *   - Where one rate must describe several transactions it is the weighted
 *     average: their local total over their foreign total. Not the first, not
 *     the latest, not a rate somebody picked.
 *   - Different currency pairs are never averaged together. USD→MAD is one
 *     figure, AED→MAD another.
 *
 * The costs capitalised onto an order are spread across its batches by the
 * allocation rule, and the share each batch took of each bill is not stored.
 * A batch's capitalised dollars are therefore restated in local currency at
 * the weighted rate of the order's capitalised costs. Summed over the order
 * that gives back exactly the local amounts entered; for a cost booked to one
 * container only, a batch's own share is the order's blend rather than that
 * bill's exact rate.
 */

export type FxTransaction = {
  kind: 'PURCHASE' | 'COST' | 'SALE';
  id: string;
  date: Date;
  /** What it was: the category of a cost, the supplier of a purchase, the customer of a sale. */
  label: string;
  reference: string | null;
  currency: string;
  amount: Decimal;
  usd: Decimal;
  local: Decimal;
  /** Local currency per 1 USD, as this transaction was entered. */
  rateLocalPerUsd: Decimal;
};

export type FxPair = {
  /** e.g. USD */
  from: string;
  /** e.g. MAD */
  to: string;
  /** Weighted: `toTotal / fromTotal`. 1 `from` = `rate` `to`. */
  rate: Decimal;
  fromTotal: Decimal;
  toTotal: Decimal;
  count: number;
  /** The lowest and highest rate among them, so a spread is visible. */
  lowest: Decimal;
  highest: Decimal;
};

/**
 * One weighted rate per currency pair.
 *
 * A dirham bill and a dollar bill are both on the dollar–dirham pair: the
 * first was converted to dollars at its rate, the second to dirhams at its
 * rate, and both say how many dirhams a dollar was worth that day. A bill in
 * a third currency is its own pair.
 */
export function summariseFx(transactions: FxTransaction[], localCurrency: string): FxPair[] {
  const pairs = new Map<string, { from: string; fromTotal: Decimal; toTotal: Decimal; rates: Decimal[] }>();
  for (const t of transactions) {
    const onDollarPair = t.currency === 'USD' || t.currency === localCurrency;
    if (onDollarPair && localCurrency === 'USD') continue;
    const from = onDollarPair ? 'USD' : t.currency;
    const fromAmount = onDollarPair ? t.usd : t.amount;
    if (fromAmount.isZero()) continue;
    const entry = pairs.get(from) ?? { from, fromTotal: dec(0), toTotal: dec(0), rates: [] };
    entry.fromTotal = entry.fromTotal.plus(fromAmount.abs());
    entry.toTotal = entry.toTotal.plus(t.local.abs());
    entry.rates.push(t.local.abs().dividedBy(fromAmount.abs()));
    pairs.set(from, entry);
  }
  return [...pairs.values()]
    .filter((p) => p.fromTotal.greaterThan(0))
    .map((p) => ({
      from: p.from,
      to: localCurrency,
      rate: p.toTotal.dividedBy(p.fromTotal).toDecimalPlaces(6),
      fromTotal: toMoney(p.fromTotal),
      toTotal: toMoney(p.toTotal),
      count: p.rates.length,
      lowest: p.rates.reduce((a, b) => (b.lessThan(a) ? b : a)).toDecimalPlaces(6),
      highest: p.rates.reduce((a, b) => (b.greaterThan(a) ? b : a)).toDecimalPlaces(6),
    }))
    .sort((a, b) => (a.from === 'USD' ? -1 : b.from === 'USD' ? 1 : a.from.localeCompare(b.from)));
}

/**
 * The weighted rate of the costs capitalised onto each order: local total
 * over dollar total, from the bills as they were entered. An order with no
 * capitalised cost has no such rate and is left out.
 */
export async function getCapitalisedRates(companyId: string, contractIds: string[]): Promise<Map<string, Decimal>> {
  if (contractIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ contractId: string; local: string; usd: string }>>`
    SELECT s."purchaseContractId" AS "contractId",
           COALESCE(SUM(e."amountLocal"), 0)::text AS local,
           COALESCE(SUM(e."amountUsd"), 0)::text AS usd
    FROM expenses e
    JOIN shipments s ON s."id" = e."shipmentId"
    WHERE e."companyId" = ${companyId} AND e."status" = 'POSTED' AND e."capitaliseToLandedCost" = true
      AND s."purchaseContractId" = ANY(${contractIds})
    GROUP BY s."purchaseContractId"`;
  const rates = new Map<string, Decimal>();
  for (const row of rows) {
    if (dec(row.usd).greaterThan(0)) rates.set(row.contractId, dec(row.local).dividedBy(dec(row.usd)));
  }
  return rates;
}

/**
 * A batch's landed cost in local currency: its coffee at the purchase's own
 * rate, its capitalised costs at the rate those costs were entered at.
 */
export function batchLandedLocal(params: {
  purchaseUsd: Decimal;
  capitalisedUsd: Decimal;
  purchaseRate: Decimal;
  capitalisedRate: Decimal | undefined;
}): { goodsLocal: Decimal; capitalisedLocal: Decimal; landedLocal: Decimal } {
  const goodsLocal = toMoney(params.purchaseUsd.times(params.purchaseRate));
  const capitalisedLocal = toMoney(params.capitalisedUsd.times(params.capitalisedRate ?? params.purchaseRate));
  return { goodsLocal, capitalisedLocal, landedLocal: toMoney(goodsLocal.plus(capitalisedLocal)) };
}

/**
 * Every transaction that makes up each order's landed cost — the purchase
 * and the costs capitalised onto it — and every sale from it, each at its
 * own rate, for the FX summary and its breakdown.
 */
export async function getOrderFxTransactions(
  companyId: string,
  contractIds: string[],
): Promise<Map<string, { costs: FxTransaction[]; sales: FxTransaction[] }>> {
  const result = new Map<string, { costs: FxTransaction[]; sales: FxTransaction[] }>();
  if (contractIds.length === 0) return result;

  const [contracts, expenses, sales] = await Promise.all([
    prisma.purchaseContract.findMany({
      where: { companyId, id: { in: contractIds } },
      select: {
        id: true,
        contractDate: true,
        contractReference: true,
        currency: true,
        rateToUsd: true,
        rateLocalPerUsd: true,
        vendor: { select: { vendorName: true } },
        batches: { where: { status: 'ACTIVE' }, select: { purchaseCostUsd: true } },
      },
    }),
    prisma.expense.findMany({
      where: {
        companyId,
        status: 'POSTED',
        capitaliseToLandedCost: true,
        shipment: { purchaseContractId: { in: contractIds } },
      },
      select: {
        id: true,
        expenseDate: true,
        reference: true,
        description: true,
        currency: true,
        amount: true,
        amountUsd: true,
        amountLocal: true,
        rateLocalPerUsd: true,
        expenseCategory: { select: { name: true } },
        shipment: { select: { purchaseContractId: true } },
      },
      orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.$queryRaw<
      Array<{
        contractId: string;
        invoiceId: string;
        invoiceDate: Date;
        customerName: string;
        currency: string;
        amount: string;
        usd: string;
        rateLocalPerUsd: string;
      }>
    >`
      SELECT b."purchaseContractId" AS "contractId", si."id" AS "invoiceId", si."invoiceDate", c."customerName",
             si."currency",
             SUM(sil."lineTotal")::text AS amount,
             SUM(sil."lineTotalUsd")::text AS usd,
             si."rateLocalPerUsd"::text AS "rateLocalPerUsd"
      FROM sales_invoice_lines sil
      JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
      JOIN customers c ON c."id" = si."customerId"
      JOIN batches b ON b."id" = sil."batchId"
      WHERE si."companyId" = ${companyId} AND si."status" = 'POSTED' AND b."purchaseContractId" = ANY(${contractIds})
      GROUP BY b."purchaseContractId", si."id", si."invoiceDate", c."customerName", si."currency", si."rateLocalPerUsd"
      ORDER BY si."invoiceDate"`,
  ]);

  for (const c of contracts) {
    const goodsUsd = toMoney(c.batches.reduce((t, b) => t.plus(dec(b.purchaseCostUsd)), dec(0)));
    const rateToUsd = dec(c.rateToUsd);
    result.set(c.id, {
      costs: [
        {
          kind: 'PURCHASE',
          id: c.id,
          date: c.contractDate,
          label: c.vendor.vendorName,
          reference: c.contractReference,
          currency: c.currency,
          amount: c.currency === 'USD' ? goodsUsd : toMoney(goodsUsd.times(rateToUsd)),
          usd: goodsUsd,
          local: toMoney(goodsUsd.times(dec(c.rateLocalPerUsd))),
          rateLocalPerUsd: dec(c.rateLocalPerUsd),
        },
      ],
      sales: [],
    });
  }
  for (const e of expenses) {
    const bucket = e.shipment ? result.get(e.shipment.purchaseContractId) : undefined;
    if (!bucket) continue;
    bucket.costs.push({
      kind: 'COST',
      id: e.id,
      date: e.expenseDate,
      label: e.expenseCategory.name,
      reference: e.reference ?? e.description,
      currency: e.currency,
      amount: toMoney(e.amount),
      usd: toMoney(e.amountUsd),
      local: toMoney(e.amountLocal),
      rateLocalPerUsd: dec(e.amountUsd).isZero() ? dec(e.rateLocalPerUsd) : dec(e.amountLocal).dividedBy(dec(e.amountUsd)),
    });
  }
  for (const s of sales) {
    const bucket = result.get(s.contractId);
    if (!bucket) continue;
    const usd = toMoney(s.usd);
    const rate = dec(s.rateLocalPerUsd);
    bucket.sales.push({
      kind: 'SALE',
      id: s.invoiceId,
      date: s.invoiceDate,
      label: s.customerName,
      reference: null,
      currency: s.currency,
      amount: toMoney(s.amount),
      usd,
      local: toMoney(usd.times(rate)),
      rateLocalPerUsd: rate,
    });
  }
  return result;
}
