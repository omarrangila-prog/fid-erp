import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma, transaction } from '@/lib/db';
import { dec, sum, toMoney, type Decimal } from '@/lib/money';
import { postJournalEntry } from '@/lib/services/accounting';
import { writeAudit } from '@/lib/services/audit';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { getBatchCostingIndex, getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getInventoryValuation } from '@/lib/services/stock';
import { runConsistencyChecks } from '@/lib/services/consistency';

/**
 * Put the cost of the coffee on the right side of the line between stock and
 * cost of sales (approved by the client on 20 Oct 2026).
 *
 * The ledger and the costing agree to the dirham on what all the coffee cost.
 * They disagree on how much of it is sold: a shipment cost posted after part
 * of the shipment had sold sent the sold share to cost of sales at that
 * moment, measured in dollars by the KG sold then; the costing measures each
 * container in dirhams by what is sold now, at the order's current rate. Over
 * many late costs and rate edits the two drifted — the ledger carrying more in
 * cost of sales and less in stock than the coffee on the shelf.
 *
 * This posts one dated correction: for each order, the dirhams the ledger has
 * in cost of sales beyond what the costing says was sold go back to stock
 * (or the other way), dirham-only, tagged to the order's shipment. Nothing is
 * deleted and no earlier entry is touched. Every amount is derived — the
 * ledger against the costing — and the script refuses unless the totals agree
 * and the per-order amounts add up to the company difference.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/repair-inventory-split.ts               # dry run, FID-MA
 *   npx tsx --tsconfig tsconfig.json scripts/repair-inventory-split.ts --apply       # post
 */
const apply = process.argv.includes('--apply');
const companyCode = process.argv.find((a) => a.startsWith('--company='))?.slice(10) ?? 'FID-MA';
const TOLERANCE = dec('0.05');

async function main() {
  const company = await prisma.company.findUniqueOrThrow({ where: { code: companyCode }, select: { id: true, code: true, localCurrency: true } });
  const companyId = company.id;

  // --- The two sides, company-wide --------------------------------------------
  const ledgerOf = async (key: string) => {
    const [row] = await prisma.$queryRaw<Array<{ local: string }>>`
      SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local
        FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId" JOIN accounts a ON a."id" = jl."accountId"
       WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${key}`;
    return dec(row?.local ?? 0);
  };
  const [glInventory, glCogs, valuation, pnl] = await Promise.all([
    ledgerOf('INVENTORY'),
    ledgerOf('COST_OF_GOODS_SOLD'),
    getInventoryValuation(companyId),
    getShipmentProfitability({ companyId }),
  ]);
  const costingStock = sum(valuation.map((l) => l.valueLocal));
  const contracts = [...new Set(pnl.map((r) => r.contractId))];
  let costingLanded = dec(0);
  for (const cid of contracts) {
    const first = pnl.find((r) => r.contractId === cid)!;
    costingLanded = costingLanded.plus((await getShipmentCostSheet(companyId, first.shipmentId, { wholeOrder: true })).totalShipmentCostLocal);
  }
  const costingCogs = sum(pnl.map((r) => r.allocatedLandedCostLocal));
  const companyDiff = toMoney(costingStock.minus(glInventory)); // + : stock short in the ledger
  console.log(`${company.code}: ledger Inventory ${glInventory.toFixed(2)} + COGS ${glCogs.toFixed(2)} = ${glInventory.plus(glCogs).toFixed(2)}`);
  console.log(`${company.code}: costing stock ${costingStock.toFixed(2)} + COGS ${costingCogs.toFixed(2)} = ${costingStock.plus(costingCogs).toFixed(2)} (landed ${costingLanded.toFixed(2)})`);
  const totalGap = glInventory.plus(glCogs).minus(costingStock.plus(costingCogs));
  if (totalGap.abs().greaterThan(TOLERANCE)) {
    throw new Error(`Refusing: the totals differ by ${totalGap.toFixed(2)} — this is not only a split between stock and cost of sales.`);
  }
  console.log(`${company.code}: split difference ${companyDiff.toFixed(2)} (stock ${companyDiff.isNegative() ? 'over' : 'short'} in the ledger)`);
  if (companyDiff.abs().lessThan('0.01')) {
    console.log('Nothing to correct.');
    return;
  }

  // --- Per order: the ledger's cost of sales against the costing's -------------
  const lines = await prisma.$queryRaw<Array<{ invoiceId: string; batchId: string; contractId: string; kg: string }>>`
    SELECT si."id" AS "invoiceId", sil."batchId", b."purchaseContractId" AS "contractId", sil."quantityKg"::text AS kg
      FROM sales_invoice_lines sil JOIN sales_invoices si ON si."id" = sil."salesInvoiceId" JOIN batches b ON b."id" = sil."batchId"
     WHERE si."companyId" = ${companyId} AND si."status" = 'POSTED'`;
  const costing = await getBatchCostingIndex({ companyId, batchIds: [...new Set(lines.map((l) => l.batchId))] });
  // Each invoice's cost, shared over the orders its lines came from.
  const shareOf = new Map<string, Map<string, Decimal>>();
  for (const l of lines) {
    const value = dec(l.kg).times(costing.get(l.batchId)?.landedPerKgLocal ?? 0);
    const m = shareOf.get(l.invoiceId) ?? new Map<string, Decimal>();
    m.set(l.contractId, (m.get(l.contractId) ?? dec(0)).plus(value));
    shareOf.set(l.invoiceId, m);
  }
  const glByOrder = new Map<string, Decimal>();
  const addTo = (contractId: string, v: Decimal) => glByOrder.set(contractId, (glByOrder.get(contractId) ?? dec(0)).plus(v));
  let unplaced = dec(0);
  const cogsEntries = await prisma.$queryRaw<Array<{ src: string; sourceId: string; contractId: string | null; net: string }>>`
    SELECT je."sourceType"::text AS src, je."sourceId", s."purchaseContractId" AS "contractId", SUM(jl."debitLocal" - jl."creditLocal")::text AS net
      FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId" JOIN accounts a ON a."id" = jl."accountId"
      LEFT JOIN shipments s ON s."id" = jl."shipmentId"
     WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = 'COST_OF_GOODS_SOLD'
     GROUP BY 1, 2, 3`;
  for (const e of cogsEntries) {
    const net = dec(e.net);
    if (net.isZero()) continue;
    if (e.contractId) {
      addTo(e.contractId, net);
      continue;
    }
    // Untagged: placed through the invoice it belongs to, by the invoice's
    // lines. A later-cost entry names its invoice inside its reference.
    const invoiceId = e.sourceId.startsWith('sale-later-cost:') ? e.sourceId.split(':')[1] : e.sourceId;
    const parts = shareOf.get(invoiceId);
    const whole = parts ? sum([...parts.values()]) : dec(0);
    if (parts && whole.greaterThan(0)) {
      for (const [cid, v] of parts) addTo(cid, net.times(v).dividedBy(whole));
    } else {
      unplaced = unplaced.plus(net);
    }
  }
  const costingByOrder = new Map<string, Decimal>();
  for (const r of pnl) costingByOrder.set(r.contractId, (costingByOrder.get(r.contractId) ?? dec(0)).plus(r.allocatedLandedCostLocal));

  const refs = new Map(
    (await prisma.purchaseContract.findMany({ where: { companyId }, select: { id: true, contractReference: true, rateLocalPerUsd: true, actualRateLocalPerUsd: true } })).map((c) => [c.id, c]),
  );
  // Ledger COGS above the costing's goes back to stock.
  const corrections = [...new Set([...glByOrder.keys(), ...costingByOrder.keys()])]
    .map((cid) => ({ contractId: cid, amount: toMoney((glByOrder.get(cid) ?? dec(0)).minus(costingByOrder.get(cid) ?? dec(0))) }))
    .filter((c) => !c.amount.abs().lessThan('0.01'));
  const placed = sum(corrections.map((c) => c.amount));
  const remainder = toMoney(companyDiff.minus(placed));
  for (const c of corrections) console.log(`  ${refs.get(c.contractId)?.contractReference ?? c.contractId}: ${c.amount.toFixed(2)} from cost of sales back to stock`);
  console.log(`  not attributable to an order: ${remainder.toFixed(2)} (unplaced ledger lines ${toMoney(unplaced).toFixed(2)})`);
  // What no order can take is exactly the ledger lines nothing could place.
  if (remainder.minus(toMoney(unplaced)).abs().greaterThan(TOLERANCE)) {
    throw new Error(`Refusing: the unattributed ${remainder.toFixed(2)} is not the unplaced ledger lines ${toMoney(unplaced).toFixed(2)}.`);
  }
  console.log(`  total ${toMoney(placed.plus(remainder)).toFixed(2)} = company difference ${companyDiff.toFixed(2)}`);

  if (!apply) {
    console.log('\nDry run — nothing was written. Re-run with --apply.');
    return;
  }

  // --- Post ---------------------------------------------------------------------
  const actor =
    (process.env.INITIAL_ADMIN_EMAIL ? await prisma.user.findFirst({ where: { email: process.env.INITIAL_ADMIN_EMAIL }, select: { id: true } }) : null) ??
    (await prisma.user.findFirstOrThrow({ select: { id: true } }));
  const shipmentOf = new Map(
    (await prisma.shipment.findMany({ where: { companyId, purchaseContractId: { in: corrections.map((c) => c.contractId) } }, orderBy: { createdAt: 'asc' }, select: { id: true, purchaseContractId: true } })).map((s) => [
      s.purchaseContractId,
      s.id,
    ]),
  );
  type Line = Parameters<typeof postJournalEntry>[1]['lines'][number];
  const pair = (amount: Decimal, label: string, contractId?: string): Line[] => {
    const c = contractId ? refs.get(contractId) : undefined;
    const rate = c ? dec(c.actualRateLocalPerUsd ?? c.rateLocalPerUsd) : dec(1);
    const tag = contractId ? { purchaseContractId: contractId, shipmentId: shipmentOf.get(contractId) } : {};
    return [
      { accountKey: ACCOUNT_KEYS.INVENTORY, direction: amount.greaterThan(0) ? 'DEBIT' : 'CREDIT', currency: company.localCurrency, amount: amount.abs(), rateToUsd: rate, description: label, localOnly: true, ...tag } as Line,
      { accountKey: ACCOUNT_KEYS.COST_OF_GOODS_SOLD, direction: amount.greaterThan(0) ? 'CREDIT' : 'DEBIT', currency: company.localCurrency, amount: amount.abs(), rateToUsd: rate, description: label, localOnly: true, ...tag } as Line,
    ];
  };
  const journalLines: Line[] = [
    ...corrections.flatMap((c) => pair(c.amount, `Stock/cost of sales split restated to the costing — ${refs.get(c.contractId)?.contractReference ?? ''}`, c.contractId)),
    ...(remainder.abs().lessThan('0.01') ? [] : pair(remainder, 'Stock/cost of sales split restated to the costing — no order on the original lines')),
  ];
  const day = new Date().toISOString().slice(0, 10);
  await transaction(
    async (tx) => {
      await postJournalEntry(tx, {
        companyId,
        entryDate: new Date(),
        description:
          'Correction approved by the client on 20 Oct 2026: cost of sales and stock restated to the shipment costing. Late shipment costs had sent more of the coffee to cost of sales than has been sold; the total cost is unchanged.',
        sourceType: 'INVENTORY_ADJUSTMENT',
        sourceId: `inventory-split-${day}-${companyId}`,
        createdById: actor.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: 1,
        lines: journalLines,
      });
      await writeAudit(tx, {
        companyId,
        userId: actor.id,
        action: 'INVENTORY_SPLIT_CORRECTED',
        entityType: 'Company',
        entityId: companyId,
        before: { ledgerInventory: glInventory.toFixed(2), ledgerCogs: glCogs.toFixed(2) },
        after: {
          costingStock: costingStock.toFixed(2),
          costingCogs: costingCogs.toFixed(2),
          correction: companyDiff.toFixed(2),
          byOrder: corrections.map((c) => ({ order: refs.get(c.contractId)?.contractReference, amount: c.amount.toFixed(2) })),
          unattributed: remainder.toFixed(2),
        },
      });
    },
    60_000,
  );

  const after = await ledgerOf('INVENTORY');
  console.log(`\nPosted. Ledger Inventory now ${after.toFixed(2)} vs Inventory Valuation ${costingStock.toFixed(2)}: difference ${toMoney(costingStock.minus(after)).toFixed(2)}`);
  const { checks, failures } = await runConsistencyChecks(companyId);
  console.log(`Consistency: ${failures} failing of ${checks.length}`);
  mkdirSync('backups', { recursive: true });
  const file = `backups/inventory-split-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(
    file,
    JSON.stringify(
      { company: company.code, before: { inventory: glInventory.toFixed(2), cogs: glCogs.toFixed(2) }, after: { inventory: after.toFixed(2) }, corrections: corrections.map((c) => ({ order: refs.get(c.contractId)?.contractReference, amount: c.amount.toFixed(2) })), remainder: remainder.toFixed(2) },
      null,
      2,
    ),
  );
  console.log(`Record written to ${file}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
