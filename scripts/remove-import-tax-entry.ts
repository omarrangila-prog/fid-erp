import 'dotenv/config';
import fs from 'node:fs';
import { prisma, transaction } from '@/lib/db';
import { foldImportTaxCorrectionIntoOrder } from '@/lib/services/import-tax-correction';
import { getTrialBalanceReport, getBalanceSheet } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';

/**
 * Removes FID-MA-JV-000019 — "Remove import tax from supplier Ideal
 * commodities uganda on FID-MA-PO-000001" — at the client's request, without
 * moving any figure: the order's own posting is redone without the TVA the
 * supplier does not bill, and the separate correction goes. See
 * src/lib/services/import-tax-correction.ts.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/remove-import-tax-entry.ts          # shows what it would do
 *   npx tsx --tsconfig tsconfig.json scripts/remove-import-tax-entry.ts --apply  # does it
 *
 * Writes a backup of the entries and the headline figures to backups/ first,
 * refuses to commit if any account balance would change, and checks the
 * reconciliation afterwards.
 */

const ENTRY = process.env.ENTRY_NUMBER ?? 'FID-MA-JV-000019';
const APPLY = process.argv.includes('--apply');

async function figures(companyId: string) {
  const [tb, bs, rec] = await Promise.all([
    getTrialBalanceReport({ companyId }),
    getBalanceSheet({ companyId, asOf: new Date() }),
    reconcile(companyId),
  ]);
  return {
    trialBalance: `${tb.totals.debitUsd} = ${tb.totals.creditUsd}`,
    assets: bs.assets.totalUsd.toString(),
    liabilities: bs.liabilities.totalUsd.toString(),
    equity: bs.equity.totalUsd.toString(),
    reconciliation: `${rec.checks.filter((c) => c.passed).length}/${rec.checks.length}`,
  };
}

async function main() {
  const entry = await prisma.journalEntry.findFirst({
    where: { entryNumber: ENTRY },
    include: { lines: true },
  });
  if (!entry) throw new Error(`${ENTRY} not found.`);
  if (!entry.sourceId.startsWith('ap-import-tax-correction:')) throw new Error(`${ENTRY} is not an import-tax correction.`);
  const contractId = entry.sourceId.slice('ap-import-tax-correction:'.length);
  const contract = await prisma.purchaseContract.findUniqueOrThrow({
    where: { id: contractId },
    select: { contractNumber: true, contractReference: true, vendor: { select: { vendorName: true } } },
  });
  const admin = await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });

  const before = await figures(entry.companyId);
  console.log(`${ENTRY}: ${entry.description}`);
  console.log(`Order ${contract.contractReference} (${contract.contractNumber}), supplier ${contract.vendor.vendorName}`);
  console.log('Figures now:', before);

  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  if (!APPLY) {
    // Run the whole change and roll it back, so the dry run proves it would commit.
    try {
      await transaction(async (tx) => {
        const result = await foldImportTaxCorrectionIntoOrder(tx, {
          companyId: entry.companyId, contractId, userId: admin.id, today,
          reason: `Removed ${ENTRY} at the client's request`,
        });
        console.log(`Would remove ${result.removed} and repost ${result.replaced} as a new entry without ${result.vat} of TVA; every balance unchanged.`);
        throw new Error('__dry_run__');
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== '__dry_run__') throw error;
    }
    console.log('\nDry run only. Nothing was written. Run again with --apply.');
    return;
  }

  fs.mkdirSync('backups', { recursive: true });
  const posting = await prisma.journalEntry.findMany({ where: { sourceType: 'PURCHASE_CONTRACT', sourceId: contractId }, include: { lines: true } });
  const file = `backups/remove-import-tax-entry-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ entry, posting, figures: before }, null, 2));
  console.log('Backup written to', file);

  const result = await transaction((tx) =>
    foldImportTaxCorrectionIntoOrder(tx, {
      companyId: entry.companyId, contractId, userId: admin.id, today,
      reason: `Removed ${ENTRY} at the client's request`,
    }),
  );
  console.log(`Removed ${result.removed}; ${result.replaced} reposted as ${result.reposted} without the TVA.`);

  const after = await figures(entry.companyId);
  console.log('Figures after:', after);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    console.error('WARNING: a headline figure differs. Compare with the backup at', file);
    process.exitCode = 1;
  } else {
    console.log('Every headline figure is unchanged.');
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
