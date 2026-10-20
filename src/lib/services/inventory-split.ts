import { Prisma } from '@prisma/client';
import { prisma, transaction } from '@/lib/db';
import { dec, sum, toMoney, type Decimal } from '@/lib/money';
import { postJournalEntry } from '@/lib/services/accounting';
import { writeAudit } from '@/lib/services/audit';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { getBatchCostingIndex } from '@/lib/services/landed-cost';
import { getInventoryValuation } from '@/lib/services/stock';

/**
 * Keep the ledger's line between stock and cost of sales where the costing
 * puts it.
 *
 * The ledger and the costing always agree on what the coffee cost; they can
 * disagree on how much of it has been sold. A shipment cost posted after part
 * of a shipment had sold sends the sold share to cost of sales at that moment,
 * by the KG sold then and in dollars; the costing measures each container in
 * dirhams by what is sold now, at the order's current rate. Each such posting
 * leaves a small difference, and over months they add up (MAD 167,578.90 by
 * 20 Oct 2026, corrected as FID-MA-JV-000366).
 *
 * After every posting that moves cost, this compares the two and — when they
 * differ — posts one dirham-only restatement, a line pair per order tagged to
 * its shipment. It never posts when the ledger and the costing disagree on the
 * total (that is not a split, and needs a person), and it re-reads the ledger
 * under a lock before writing, so two runs at once post once.
 */
export type InventorySplit = {
  glInventory: Decimal;
  glCogs: Decimal;
  costingStock: Decimal;
  costingCogs: Decimal;
  /** Ledger (stock + cost of sales) less costing (stock + cost of sales): must be nil. */
  totalGap: Decimal;
  /** Costing stock less ledger stock: what goes from cost of sales back to stock. */
  difference: Decimal;
  corrections: Array<{ contractId: string; reference: string; amount: Decimal }>;
  /** What no order can take: ledger lines with nothing to place them by. */
  unattributed: Decimal;
};

const TOLERANCE = dec('0.05');

async function ledgerOf(companyId: string, key: string): Promise<Decimal> {
  const [row] = await prisma.$queryRaw<Array<{ local: string }>>`
    SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local
      FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId" JOIN accounts a ON a."id" = jl."accountId"
     WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${key}`;
  return dec(row?.local ?? 0);
}

export async function computeInventorySplit(companyId: string): Promise<InventorySplit> {
  const [glInventory, glCogs, valuation, pnl] = await Promise.all([
    ledgerOf(companyId, 'INVENTORY'),
    ledgerOf(companyId, 'COST_OF_GOODS_SOLD'),
    getInventoryValuation(companyId),
    getShipmentProfitability({ companyId }),
  ]);
  const costingStock = sum(valuation.map((l) => l.valueLocal));
  const costingCogs = sum(pnl.map((r) => r.allocatedLandedCostLocal));
  const totalGap = toMoney(glInventory.plus(glCogs).minus(costingStock.plus(costingCogs)));
  const difference = toMoney(costingStock.minus(glInventory));

  // Each invoice's cost, shared over the orders its lines came from.
  const lines = await prisma.$queryRaw<Array<{ invoiceId: string; batchId: string; contractId: string; kg: string }>>`
    SELECT si."id" AS "invoiceId", sil."batchId", b."purchaseContractId" AS "contractId", sil."quantityKg"::text AS kg
      FROM sales_invoice_lines sil JOIN sales_invoices si ON si."id" = sil."salesInvoiceId" JOIN batches b ON b."id" = sil."batchId"
     WHERE si."companyId" = ${companyId} AND si."status" = 'POSTED'`;
  const costing = lines.length ? await getBatchCostingIndex({ companyId, batchIds: [...new Set(lines.map((l) => l.batchId))] }) : new Map();
  const shareOf = new Map<string, Map<string, Decimal>>();
  for (const l of lines) {
    const value = dec(l.kg).times(costing.get(l.batchId)?.landedPerKgLocal ?? 0);
    const m = shareOf.get(l.invoiceId) ?? new Map<string, Decimal>();
    m.set(l.contractId, (m.get(l.contractId) ?? dec(0)).plus(value));
    shareOf.set(l.invoiceId, m);
  }

  // The ledger's cost of sales, order by order: tagged lines by their shipment,
  // the rest through the invoice they belong to.
  const glByOrder = new Map<string, Decimal>();
  const addTo = (contractId: string, v: Decimal) => glByOrder.set(contractId, (glByOrder.get(contractId) ?? dec(0)).plus(v));
  let unplaced = dec(0);
  const entries = await prisma.$queryRaw<Array<{ sourceId: string; contractId: string | null; net: string }>>`
    SELECT je."sourceId", COALESCE(s."purchaseContractId", jl."purchaseContractId") AS "contractId", SUM(jl."debitLocal" - jl."creditLocal")::text AS net
      FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId" JOIN accounts a ON a."id" = jl."accountId"
      LEFT JOIN shipments s ON s."id" = jl."shipmentId"
     WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = 'COST_OF_GOODS_SOLD'
     GROUP BY 1, 2`;
  for (const e of entries) {
    const net = dec(e.net);
    if (net.isZero()) continue;
    if (e.contractId) {
      addTo(e.contractId, net);
      continue;
    }
    const invoiceId = e.sourceId.startsWith('sale-later-cost:') ? e.sourceId.split(':')[1] : e.sourceId;
    const parts = shareOf.get(invoiceId);
    const whole = parts ? sum([...parts.values()]) : dec(0);
    if (parts && whole.greaterThan(0)) for (const [cid, v] of parts) addTo(cid, net.times(v).dividedBy(whole));
    else unplaced = unplaced.plus(net);
  }
  const costingByOrder = new Map<string, Decimal>();
  for (const r of pnl) costingByOrder.set(r.contractId, (costingByOrder.get(r.contractId) ?? dec(0)).plus(r.allocatedLandedCostLocal));
  const reference = new Map(pnl.map((r) => [r.contractId, r.contractReference]));

  const corrections = [...new Set([...glByOrder.keys(), ...costingByOrder.keys()])]
    .map((cid) => ({ contractId: cid, reference: reference.get(cid) ?? cid, amount: toMoney((glByOrder.get(cid) ?? dec(0)).minus(costingByOrder.get(cid) ?? dec(0))) }))
    .filter((c) => !c.amount.abs().lessThan('0.01'));
  const unattributed = toMoney(difference.minus(sum(corrections.map((c) => c.amount))));
  return { glInventory, glCogs, costingStock, costingCogs, totalGap, difference, corrections, unattributed: unattributed.abs().lessThan('0.01') ? dec(0) : unattributed };
}

export type RestateResult = { posted: false; reason: string; split?: InventorySplit } | { posted: true; entryId: string; split: InventorySplit };

/** Compares and, when the split has drifted, posts the restatement. */
export async function restateInventorySplit(params: { companyId: string; userId: string; trigger: string }): Promise<RestateResult> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: params.companyId }, select: { id: true, localCurrency: true } });
  const split = await computeInventorySplit(params.companyId);
  if (split.difference.abs().lessThan('0.01')) return { posted: false, reason: 'in step', split };
  if (split.totalGap.abs().greaterThan(TOLERANCE)) {
    return { posted: false, reason: `the ledger and the costing differ on the total by ${split.totalGap.toFixed(2)}; not a split — left for review`, split };
  }

  const contracts = await prisma.purchaseContract.findMany({
    where: { companyId: params.companyId, id: { in: split.corrections.map((c) => c.contractId) } },
    select: { id: true, rateLocalPerUsd: true, actualRateLocalPerUsd: true, shipments: { orderBy: { createdAt: 'asc' }, take: 1, select: { id: true } } },
  });
  const byId = new Map(contracts.map((c) => [c.id, c]));
  type Line = Parameters<typeof postJournalEntry>[1]['lines'][number];
  const pair = (amount: Decimal, label: string, contractId?: string): Line[] => {
    const c = contractId ? byId.get(contractId) : undefined;
    const rate = c ? dec(c.actualRateLocalPerUsd ?? c.rateLocalPerUsd) : dec(1);
    const tag = c ? { purchaseContractId: c.id, shipmentId: c.shipments[0]?.id } : {};
    const up = amount.greaterThan(0);
    const base = { currency: company.localCurrency, amount: amount.abs(), rateToUsd: rate, description: label, localOnly: true, ...tag };
    return [
      { ...base, accountKey: ACCOUNT_KEYS.INVENTORY, direction: up ? 'DEBIT' : 'CREDIT' } as Line,
      { ...base, accountKey: ACCOUNT_KEYS.COST_OF_GOODS_SOLD, direction: up ? 'CREDIT' : 'DEBIT' } as Line,
    ];
  };
  const lines: Line[] = [
    ...split.corrections.flatMap((c) => pair(c.amount, `Stock / cost of sales restated to the costing — ${c.reference}`, c.contractId)),
    ...(split.unattributed.isZero() ? [] : pair(split.unattributed, 'Stock / cost of sales restated to the costing — no order on the original lines')),
  ];
  if (lines.length === 0) return { posted: false, reason: 'nothing to post', split };

  const entryId = await transaction(async (tx) => {
    // One restatement at a time per company, and only against the ledger it was worked out from.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory-split:${params.companyId}`}))`);
    const [now] = await tx.$queryRaw<Array<{ local: string }>>`
      SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local
        FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId" JOIN accounts a ON a."id" = jl."accountId"
       WHERE je."companyId" = ${params.companyId} AND je."status" = 'POSTED' AND a."systemKey" = 'INVENTORY'`;
    if (!dec(now?.local ?? 0).minus(split.glInventory).abs().lessThan('0.005')) return null;
    const entry = await postJournalEntry(tx, {
      companyId: params.companyId,
      entryDate: new Date(),
      description: `Stock and cost of sales restated to the shipment costing after ${params.trigger}. The total cost of the coffee is unchanged.`,
      sourceType: 'INVENTORY_ADJUSTMENT',
      sourceId: `inventory-split-${new Date().toISOString()}-${params.companyId}`,
      createdById: params.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: 1,
      lines,
    });
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'INVENTORY_SPLIT_RESTATED',
      entityType: 'Company',
      entityId: params.companyId,
      before: { ledgerInventory: split.glInventory.toFixed(2), ledgerCogs: split.glCogs.toFixed(2) },
      after: {
        costingStock: split.costingStock.toFixed(2),
        restated: split.difference.toFixed(2),
        byOrder: split.corrections.map((c) => ({ order: c.reference, amount: c.amount.toFixed(2) })),
        unattributed: split.unattributed.toFixed(2),
        trigger: params.trigger,
      },
    });
    return entry.id;
  }, 60_000);
  return entryId ? { posted: true, entryId, split } : { posted: false, reason: 'the ledger moved while this was worked out; the next posting will restate it', split };
}
