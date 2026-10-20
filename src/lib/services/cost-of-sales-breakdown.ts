import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { dec, toMoney, toQuantity, type Decimal } from '@/lib/money';
import { getCogsReport } from '@/lib/services/profitability';
import { getBatchCostingIndex } from '@/lib/services/landed-cost';

/**
 * What the cost of goods sold is made of.
 *
 * The profit and loss carries one "Cost of Goods Sold" figure, and the client
 * asked where the shipment expenses went: freight, clearing, port, the lab.
 * They are in that figure — each container's landed cost is its coffee plus
 * its share of the shipment's charges, and the sold KG take both with them.
 *
 * So each sold line is split the way its batch was costed: the coffee at the
 * order's rate, and the charges in the proportions each expense was shared to
 * that batch. The parts add up to the costing's cost of sales exactly; any
 * difference from the ledger's figure for the period (a correction dated on
 * another day) is shown as its own line, so the statement still adds up to
 * the ledger and nothing is hidden.
 */
export type CostOfSalesPart = { key: string; label: string; local: Decimal; usd: Decimal };

export type CostOfSalesBreakdown = {
  purchase: CostOfSalesPart;
  /** One per expense category, largest first. */
  expenses: CostOfSalesPart[];
  expensesTotal: { local: Decimal; usd: Decimal };
  /** The costing's cost of sales: purchase + expenses. */
  totalLocal: Decimal;
  totalUsd: Decimal;
};

export async function getCostOfSalesBreakdown(params: { companyId: string; from?: Date; to?: Date }): Promise<CostOfSalesBreakdown> {
  const lines = await getCogsReport(params);
  const batchIds = [...new Set(lines.map((l) => l.batchId).filter((id): id is string => Boolean(id)))];
  const costing = batchIds.length ? await getBatchCostingIndex({ companyId: params.companyId, batchIds }) : new Map();

  // How each batch's charges divide by category, as the expenses were shared to it.
  const shares = batchIds.length
    ? await prisma.$queryRaw<Array<{ batchId: string; categoryId: string; category: string; usd: string }>>`
        SELECT s."batchId", ec."id" AS "categoryId", ec."name" AS category, SUM(s."amountUsd")::text AS usd
          FROM expense_batch_shares s
          JOIN expenses e ON e."id" = s."expenseId"
          JOIN expense_categories ec ON ec."id" = e."expenseCategoryId"
         WHERE e."companyId" = ${params.companyId} AND e."status" = 'POSTED' AND e."capitaliseToLandedCost" = true
           AND s."batchId" IN (${Prisma.join(batchIds)})
         GROUP BY 1, 2, 3`
    : [];
  const byBatch = new Map<string, Array<{ key: string; label: string; usd: Decimal }>>();
  for (const s of shares) {
    const list = byBatch.get(s.batchId) ?? [];
    list.push({ key: s.categoryId, label: s.category, usd: dec(s.usd) });
    byBatch.set(s.batchId, list);
  }

  const parts = new Map<string, CostOfSalesPart>();
  const add = (key: string, label: string, local: Decimal, usd: Decimal) => {
    const part = parts.get(key) ?? { key, label, local: dec(0), usd: dec(0) };
    part.local = part.local.plus(local);
    part.usd = part.usd.plus(usd);
    parts.set(key, part);
  };

  for (const line of lines) {
    const c = line.batchId ? costing.get(line.batchId) : undefined;
    const kg = toQuantity(line.quantityKg);
    // No costing to split by: the whole line is the coffee.
    if (!c || c.orderedKg.isZero()) continue;
    // The charges' share of this line, per KG as the costing prices it; the
    // coffee is the rest, so the two always make the line's cost exactly.
    const expenseLocal = kg.times(c.allocatedExpenseLocal).dividedBy(c.orderedKg);
    const expenseUsd = kg.times(c.allocatedExpenseUsd).dividedBy(c.orderedKg);

    const cats = byBatch.get(c.batchId) ?? [];
    const whole = cats.reduce((t, x) => t.plus(x.usd), dec(0));
    if (whole.isZero()) {
      add('other', 'Other shipment costs', expenseLocal, expenseUsd);
      continue;
    }
    for (const cat of cats) {
      const share = cat.usd.dividedBy(whole);
      add(cat.key, cat.label, expenseLocal.times(share), expenseUsd.times(share));
    }
  }

  const expenses = [...parts.values()]
    .map((p) => ({ ...p, local: toMoney(p.local), usd: toMoney(p.usd) }))
    .filter((p) => !p.local.isZero() || !p.usd.isZero())
    .sort((a, b) => b.local.comparedTo(a.local));
  const totalLocal = toMoney(lines.reduce((t, l) => t.plus(l.cogsLocal), dec(0)));
  const totalUsd = toMoney(lines.reduce((t, l) => t.plus(l.cogsUsd), dec(0)));
  const expensesLocal = expenses.reduce((t, p) => t.plus(p.local), dec(0));
  const expensesUsd = expenses.reduce((t, p) => t.plus(p.usd), dec(0));
  return {
    // The coffee takes the rounding, so the parts sum to the total to the cent.
    purchase: { key: 'purchase', label: 'Coffee purchase cost', local: toMoney(totalLocal.minus(expensesLocal)), usd: toMoney(totalUsd.minus(expensesUsd)) },
    expenses,
    expensesTotal: { local: toMoney(expensesLocal), usd: toMoney(expensesUsd) },
    totalLocal,
    totalUsd,
  };
}
