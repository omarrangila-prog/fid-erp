import { prisma } from '@/lib/db';

/**
 * Where a landed-cost entry leads. These entries correct the cost of coffee
 * already received, and their source is the document that caused it: an
 * expense, the purchase order, or a goods receipt (which opens its shipment).
 * The id alone does not say which, so it is looked up — in this company only.
 */
export async function landedCostSourceHrefs(companyId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const hrefs = new Map<string, string>();
  if (unique.length === 0) return hrefs;
  const [expenses, contracts, receipts] = await Promise.all([
    prisma.expense.findMany({ where: { companyId, id: { in: unique } }, select: { id: true } }),
    prisma.purchaseContract.findMany({ where: { companyId, id: { in: unique } }, select: { id: true } }),
    prisma.goodsReceipt.findMany({ where: { companyId, id: { in: unique } }, select: { id: true, shipmentId: true, purchaseContractId: true } }),
  ]);
  for (const e of expenses) hrefs.set(e.id, `/finance/expenses/${e.id}`);
  for (const c of contracts) hrefs.set(c.id, `/purchases/${c.id}`);
  for (const r of receipts) hrefs.set(r.id, r.shipmentId ? `/shipments/${r.shipmentId}` : `/purchases/${r.purchaseContractId}`);
  return hrefs;
}
