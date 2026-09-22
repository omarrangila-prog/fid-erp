import 'dotenv/config';
import fs from 'node:fs';
import { prisma } from '@/lib/db';

/**
 * The old spelling, left behind in the words of posted entries.
 *
 * A posting keeps the sentence it was written with — "Collected by RADOUAN
 * MOHAMMED, not yet handed over" — so renaming the agent left the old
 * spelling on his own ledger. These are descriptions, not figures: the
 * amounts, accounts, dates and links are untouched, the previous text is
 * kept in the backup and in the audit trail, and nothing else on the books
 * moves.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/rename-ridwan-wording.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/rename-ridwan-wording.ts --apply   # write
 */

const CORRECT = 'Ridwan Mohammad';
const VARIANT = /\b(radouan|ridwan|redouan|ridouan)\s+moh?amm?[ae]d\b/gi;
const apply = process.argv.includes('--apply');

async function main() {
  const company = await prisma.company.findFirstOrThrow({ where: { code: 'FID-MA' }, select: { id: true } });

  const lines = await prisma.journalLine.findMany({
    where: { journalEntry: { companyId: company.id }, description: { contains: 'mohamm', mode: 'insensitive' } },
    select: { id: true, description: true, journalEntry: { select: { entryNumber: true } } },
  });
  const entries = await prisma.journalEntry.findMany({
    where: { companyId: company.id, description: { contains: 'mohamm', mode: 'insensitive' } },
    select: { id: true, entryNumber: true, description: true },
  });
  const receipts = await prisma.receipt.findMany({
    where: { companyId: company.id, description: { contains: 'mohamm', mode: 'insensitive' } },
    select: { id: true, receiptNumber: true, description: true },
  });

  const change = (text: string | null) => (text ? text.replace(VARIANT, CORRECT) : text);
  const lineEdits = lines.filter((l) => change(l.description) !== l.description);
  const entryEdits = entries.filter((e) => change(e.description) !== e.description);
  const receiptEdits = receipts.filter((r) => change(r.description) !== r.description);

  for (const l of lineEdits) console.log(`  line     ${l.journalEntry.entryNumber}  ${l.description}  →  ${change(l.description)}`);
  for (const e of entryEdits) console.log(`  entry    ${e.entryNumber}  ${e.description}  →  ${change(e.description)}`);
  for (const r of receiptEdits) console.log(`  receipt  ${r.receiptNumber}  ${r.description}  →  ${change(r.description)}`);
  if (lineEdits.length + entryEdits.length + receiptEdits.length === 0) {
    console.log('  nothing to reword');
    return;
  }
  if (!apply) {
    console.log('dry run — pass --apply to write');
    return;
  }

  const file = `backups/rename-ridwan-wording-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), lines: lineEdits, entries: entryEdits, receipts: receiptEdits }, null, 2));
  console.log('backup written:', file);

  for (const l of lineEdits) await prisma.journalLine.update({ where: { id: l.id }, data: { description: change(l.description) } });
  for (const e of entryEdits) await prisma.journalEntry.update({ where: { id: e.id }, data: { description: change(e.description)! } });
  for (const r of receiptEdits) await prisma.receipt.update({ where: { id: r.id }, data: { description: change(r.description) } });

  await prisma.auditLog.create({
    data: {
      companyId: company.id,
      action: 'AGENT_WORDING_CORRECTED',
      entityType: 'Agent',
      entityId: CORRECT,
      before: { lines: lineEdits.length, entries: entryEdits.length, receipts: receiptEdits.length },
      after: { spelling: CORRECT, note: 'Descriptions only; no amount, account, date or link changed' },
    },
  });
  console.log(`reworded ${lineEdits.length} line(s), ${entryEdits.length} entry line(s), ${receiptEdits.length} receipt(s)`);
}

main().finally(() => prisma.$disconnect());
