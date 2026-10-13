import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '@/lib/db';

/**
 * A logical backup of everything re-costing can touch.
 *
 * `pg_dump` here is version 16 against a version 17 server, which it refuses,
 * so this reads the affected tables through Prisma instead and writes them as
 * JSON. It is not a whole-database dump — it is the rows that would have to be
 * put back if a costing repair went wrong, with the row counts and the
 * financial totals recorded alongside so the result can be checked.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/backup-costing-tables.ts
 */
async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = `backups/costing-${stamp}`;
  mkdirSync(dir, { recursive: true });

  const tables: Record<string, unknown[]> = {
    companies: await prisma.company.findMany(),
    accounts: await prisma.account.findMany(),
    expenses: await prisma.expense.findMany(),
    expenseBatchShares: await prisma.expenseBatchShare.findMany(),
    batches: await prisma.batch.findMany(),
    containers: await prisma.container.findMany(),
    journalEntries: await prisma.journalEntry.findMany(),
    journalLines: await prisma.journalLine.findMany(),
    salesInvoices: await prisma.salesInvoice.findMany(),
    salesInvoiceLines: await prisma.salesInvoiceLine.findMany(),
    purchaseContracts: await prisma.purchaseContract.findMany(),
    purchaseContractLines: await prisma.purchaseContractLine.findMany(),
    paymentAllocations: await prisma.paymentAllocation.findMany(),
    receiptAllocations: await prisma.receiptAllocation.findMany(),
  };

  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(tables)) {
    counts[name] = rows.length;
    writeFileSync(
      `${dir}/${name}.json`,
      // Decimals and dates both stringify cleanly; BigInt needs telling.
      JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    );
  }

  // The figures that must still agree afterwards.
  const totals = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT c."code" AS company,
            (SELECT COALESCE(SUM(b."capitalisedCostUsd"),0)::text FROM batches b WHERE b."companyId"=c."id") AS capitalised_usd,
            (SELECT COALESCE(SUM(b."purchaseCostUsd"),0)::text FROM batches b WHERE b."companyId"=c."id") AS purchase_usd,
            (SELECT COALESCE(SUM(jl."debitUsd"),0)::text FROM journal_lines jl
              JOIN journal_entries je ON je."id"=jl."journalEntryId"
              WHERE je."companyId"=c."id" AND je."status"='POSTED') AS posted_debits_usd,
            (SELECT COALESCE(SUM(jl."creditUsd"),0)::text FROM journal_lines jl
              JOIN journal_entries je ON je."id"=jl."journalEntryId"
              WHERE je."companyId"=c."id" AND je."status"='POSTED') AS posted_credits_usd
     FROM companies c ORDER BY c."code"`);

  writeFileSync(`${dir}/MANIFEST.json`, JSON.stringify({ takenAt: new Date().toISOString(), counts, totals }, null, 2));

  console.log(`Backup written to ${dir}\n`);
  for (const [name, count] of Object.entries(counts)) console.log(`  ${String(count).padStart(7)}  ${name}`);
  console.log('\nFinancial totals recorded:');
  for (const t of totals) console.log(`  ${t.company}: capitalised ${t.capitalised_usd}, purchases ${t.purchase_usd}, debits ${t.posted_debits_usd}, credits ${t.posted_credits_usd}`);
}

main().finally(() => prisma.$disconnect());
