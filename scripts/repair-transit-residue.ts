import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '@/lib/db';
import { postJournalEntry } from '@/lib/services/accounting';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { dec, sum, toMoney } from '@/lib/money';
import { reconcile } from '@/lib/services/reconciliation';

/**
 * Move dirhams stuck in Inventory in Transit to where the coffee is.
 *
 * Before the fix of 16 Oct, correcting the rate on an order whose coffee had
 * already been received re-posted the order into transit at the new rate,
 * while its goods receipts had taken the coffee out at the old one. The
 * dollars cancelled; the dirhams did not, and stayed in transit for coffee
 * long since in the warehouse. The code now moves that difference as it
 * happens. This moves what was left behind before it did.
 *
 * Only an order with nothing left at sea qualifies: its transit balance is
 * zero in dollars, so any dirhams left there belong to coffee received. They
 * go to stock for the share still on hand and to cost of sales for the share
 * sold, weighted by each container's purchase cost — dirham-only lines, so no
 * dollar figure, supplier balance or document changes. One entry per order,
 * through the posting engine, so it carries the usual period and balance
 * checks and appears in the journal like any other correction.
 *
 * The amounts are read from the ledger, never typed in.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/repair-transit-residue.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/repair-transit-residue.ts --apply   # post
 */
const apply = process.argv.includes('--apply');

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, code: true, name: true, localCurrency: true } });
  const record: unknown[] = [];

  for (const company of companies) {
    const residues = await prisma.$queryRaw<Array<{ contractId: string; usd: string; local: string }>>`
      SELECT jl."purchaseContractId" AS "contractId",
             SUM(jl."debitUsd" - jl."creditUsd")::text AS usd,
             SUM(jl."debitLocal" - jl."creditLocal")::text AS local
        FROM journal_lines jl
        JOIN journal_entries je ON je."id" = jl."journalEntryId"
        JOIN accounts a ON a."id" = jl."accountId"
       WHERE je."companyId" = ${company.id} AND je."status" = 'POSTED'
         AND a."systemKey" = 'INVENTORY_IN_TRANSIT' AND jl."purchaseContractId" IS NOT NULL
       GROUP BY jl."purchaseContractId"`;

    for (const r of residues) {
      const residue = toMoney(r.local);
      if (!dec(r.usd).abs().lessThan('0.005') || residue.abs().lessThan('0.01')) continue;

      const contract = await prisma.purchaseContract.findUniqueOrThrow({
        where: { id: r.contractId },
        select: {
          contractReference: true,
          contractNumber: true,
          rateLocalPerUsd: true,
          // The correction is recorded against whoever approved the order.
          createdById: true,
          postedById: true,
          batches: {
            where: { status: 'ACTIVE' },
            select: { shipmentId: true, orderedQuantityKg: true, receivedQuantityKg: true, soldQuantityKg: true, purchaseCostUsd: true },
          },
        },
      });
      // Nothing may still be at sea: then every dirham in transit is a received container's.
      if (contract.batches.some((b) => dec(b.receivedQuantityKg).lessThan(dec(b.orderedQuantityKg)))) {
        console.log(`${company.code} ${contract.contractReference}: coffee still at sea — left alone`);
        continue;
      }

      // Each container's share, sold and on hand, by its purchase cost.
      const shares = contract.batches
        .filter((b) => dec(b.orderedQuantityKg).greaterThan(0))
        .map((b) => {
          const perKg = dec(b.purchaseCostUsd).dividedBy(dec(b.orderedQuantityKg));
          const sold = dec(b.soldQuantityKg).greaterThan(dec(b.receivedQuantityKg)) ? dec(b.receivedQuantityKg) : dec(b.soldQuantityKg);
          return { shipmentId: b.shipmentId, sold: perKg.times(sold), shelf: perKg.times(dec(b.receivedQuantityKg).minus(sold)) };
        });
      const weight = sum(shares.map((s) => s.sold.plus(s.shelf)));
      if (weight.isZero()) continue;
      const soldLocal = toMoney(residue.times(sum(shares.map((s) => s.sold))).dividedBy(weight));
      const shelfLocal = toMoney(residue.minus(soldLocal));
      const shipmentId = contract.batches[0]?.shipmentId;

      console.log(
        `${company.code} ${contract.contractReference} (${contract.contractNumber}): ${company.localCurrency} ${residue.toFixed(2)} in transit, USD 0.00` +
          ` → Inventory ${shelfLocal.toFixed(2)}, Cost of Goods Sold ${soldLocal.toFixed(2)}`,
      );
      record.push({ company: company.code, contract: contract.contractReference, residue: residue.toFixed(2), shelfLocal: shelfLocal.toFixed(2), soldLocal: soldLocal.toFixed(2) });
      if (!apply) continue;

      type Line = Parameters<typeof postJournalEntry>[1]['lines'][number];
      const line = (accountKey: string, amount: typeof residue, description: string): Line | null =>
        amount.isZero()
          ? null
          : ({
              accountKey,
              direction: amount.greaterThan(0) ? 'DEBIT' : 'CREDIT',
              currency: company.localCurrency,
              amount: amount.abs(),
              rateToUsd: contract.rateLocalPerUsd,
              description,
              purchaseContractId: r.contractId,
              shipmentId,
              localOnly: true,
            } as Line);
      await prisma.$transaction(
        (tx) =>
          postJournalEntry(tx, {
            companyId: company.id,
            entryDate: new Date(),
            description: `${contract.contractReference}: rate correction on coffee already received, moved out of transit`,
            sourceType: 'LANDED_COST',
            sourceId: r.contractId,
            createdById: contract.postedById ?? contract.createdById,
            localCurrency: company.localCurrency,
            rateLocalPerUsd: contract.rateLocalPerUsd,
            lines: [
              line(ACCOUNT_KEYS.INVENTORY, shelfLocal, 'Rate correction on coffee in stock'),
              line(ACCOUNT_KEYS.COST_OF_GOODS_SOLD, soldLocal, 'Rate correction on coffee already sold'),
              line(ACCOUNT_KEYS.INVENTORY_IN_TRANSIT, residue.negated(), 'Rate correction moved out of transit'),
            ].filter((l): l is Line => l !== null),
          }),
        { timeout: 60_000 },
      );
    }

    if (apply) {
      const result = await reconcile(company.id);
      console.log(`${company.code}: reconciliation ${result.checks.filter((c) => c.passed).length}/${result.checks.length}`);
    }
  }

  if (apply && record.length) {
    mkdirSync('backups', { recursive: true });
    const file = `backups/repair-transit-residue-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(file, JSON.stringify(record, null, 2));
    console.log(`Record written to ${file}`);
  }
  if (!apply) console.log('\nDry run — nothing was written. Re-run with --apply.');
}
main().finally(() => prisma.$disconnect());
