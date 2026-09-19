import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '@/lib/db';

/**
 * Rename placeholder lots and batches from the FID number to the reference.
 *
 * A purchase order that named no lot used to get a placeholder called
 * `FID-MA-PO-000002/1`: the system's own contract number and the line. That
 * name then showed on every stock screen — the one thing the client asked
 * never to see. New orders now build the placeholder from the client's
 * reference (`ICUL/FID/002/1`); this brings the existing ones into line.
 *
 * Only names of the exact placeholder shape are touched. A lot the supplier
 * actually named is left alone, and so is anything whose new name is already
 * taken. Nothing is deleted, no quantity or money moves, and the affected rows
 * are written to a backup file first.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/rename-placeholder-lots.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/rename-placeholder-lots.ts --apply   # write
 */

const PLACEHOLDER = /^([A-Z]+-[A-Z]+-PO-\d{6})(\/\d+)$/;
const apply = process.argv.includes('--apply');

type Rename = { table: 'lot' | 'batch'; id: string; from: string; to: string };

async function main() {
  const [lots, batches] = await Promise.all([
    prisma.lot.findMany({
      where: { lotNumber: { contains: '-PO-' } },
      select: { id: true, companyId: true, lotNumber: true },
    }),
    prisma.batch.findMany({
      where: { batchNumber: { contains: '-PO-' } },
      select: { id: true, companyId: true, batchNumber: true, purchaseContractId: true },
    }),
  ]);

  const contracts = await prisma.purchaseContract.findMany({
    select: { id: true, companyId: true, contractNumber: true, contractReference: true },
  });
  const byNumber = new Map(contracts.map((c) => [`${c.companyId}:${c.contractNumber}`, c]));

  const renames: Rename[] = [];
  const skipped: string[] = [];

  for (const lot of lots) {
    const match = lot.lotNumber.match(PLACEHOLDER);
    if (!match) continue;
    const contract = byNumber.get(`${lot.companyId}:${match[1]}`);
    if (!contract) {
      skipped.push(`lot ${lot.lotNumber}: no contract ${match[1]}`);
      continue;
    }
    if (PLACEHOLDER.test(`${contract.contractReference}/1`) || contract.contractReference === contract.contractNumber) {
      skipped.push(`lot ${lot.lotNumber}: the contract's reference is itself the FID number`);
      continue;
    }
    renames.push({ table: 'lot', id: lot.id, from: lot.lotNumber, to: `${contract.contractReference}${match[2]}` });
  }

  for (const batch of batches) {
    const match = batch.batchNumber.match(PLACEHOLDER);
    if (!match) continue;
    const contract = contracts.find((c) => c.id === batch.purchaseContractId);
    if (!contract || contract.contractNumber !== match[1]) {
      skipped.push(`batch ${batch.batchNumber}: contract does not match its number`);
      continue;
    }
    if (contract.contractReference === contract.contractNumber) {
      skipped.push(`batch ${batch.batchNumber}: the contract's reference is itself the FID number`);
      continue;
    }
    renames.push({ table: 'batch', id: batch.id, from: batch.batchNumber, to: `${contract.contractReference}${match[2]}` });
  }

  // A new name that already exists would trip the unique constraint; say so
  // rather than fail half-way.
  for (const rename of [...renames]) {
    const clash =
      rename.table === 'lot'
        ? await prisma.lot.findFirst({ where: { lotNumber: rename.to }, select: { id: true } })
        : await prisma.batch.findFirst({ where: { batchNumber: rename.to }, select: { id: true } });
    if (clash && clash.id !== rename.id) {
      skipped.push(`${rename.table} ${rename.from}: ${rename.to} already exists`);
      renames.splice(renames.indexOf(rename), 1);
    }
  }

  const counts = {
    lots: await prisma.lot.count(),
    batches: await prisma.batch.count(),
    balances: await prisma.inventoryBalance.count(),
    journalLines: await prisma.journalLine.count(),
  };

  console.log(`${renames.length} to rename, ${skipped.length} skipped`);
  for (const r of renames) console.log(`  ${r.table}  ${r.from}  →  ${r.to}`);
  for (const s of skipped) console.log(`  skip  ${s}`);
  console.log(`row counts before: ${JSON.stringify(counts)}`);

  if (!apply) {
    console.log('dry run — pass --apply to write');
    return;
  }
  if (renames.length === 0) return;

  mkdirSync(`${process.cwd()}/backups`, { recursive: true });
  const backup = `${process.cwd()}/backups/placeholder-lots-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(backup, JSON.stringify({ counts, renames }, null, 2));
  console.log(`backup written: ${backup}`);

  await prisma.$transaction(async (tx) => {
    for (const r of renames) {
      if (r.table === 'lot') await tx.lot.update({ where: { id: r.id }, data: { lotNumber: r.to } });
      else await tx.batch.update({ where: { id: r.id }, data: { batchNumber: r.to } });
    }
  });

  const after = {
    lots: await prisma.lot.count(),
    batches: await prisma.batch.count(),
    balances: await prisma.inventoryBalance.count(),
    journalLines: await prisma.journalLine.count(),
  };
  console.log(`row counts after:  ${JSON.stringify(after)}`);
  if (JSON.stringify(after) !== JSON.stringify(counts)) throw new Error('Row counts changed — investigate before doing anything else.');

  const remaining = await prisma.lot.count({ where: { lotNumber: { contains: '-PO-' } } });
  console.log(`placeholder lots still named by FID number: ${remaining}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
