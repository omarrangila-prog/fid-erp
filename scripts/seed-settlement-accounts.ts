import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma, transaction } from '@/lib/db';
import { ensureChartOfAccounts } from '@/lib/services/chart-of-accounts';
import { ACCOUNT_KEYS } from '@/lib/constants';

/**
 * Add the settlement accounts the write-off and tip features need.
 *
 *   6910  Discounts, Tips & Round-Off Allowed   (expense)
 *   6911  Settlement Adjustments                (expense)
 *   4910  Tips & Round-Off Received             (income)
 *
 * These were added to the standard chart after both live companies were
 * provisioned, so they are missing there and the posting engine throws when a
 * receipt tries to use one.
 *
 * Additive only. `ensureChartOfAccounts` creates the codes a company does not
 * have and leaves every existing row alone: no balance moves, no account is
 * renamed or merged, and nothing is posted. Safe to run more than once.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/seed-settlement-accounts.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/seed-settlement-accounts.ts --apply   # write
 */
const apply = process.argv.includes('--apply');

const WANTED = [
  ACCOUNT_KEYS.SETTLEMENT_ROUNDING,
  ACCOUNT_KEYS.SETTLEMENT_ADJUSTMENT,
  ACCOUNT_KEYS.TIPS_RECEIVED,
] as const;

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, code: true, name: true } });
  const before: unknown[] = [];

  console.log(apply ? 'Creating the missing settlement accounts.\n' : 'Dry run — nothing is written.\n');

  for (const company of companies) {
    // Row counts before, so the write can be shown to have added only what it
    // should have.
    const accountCount = await prisma.account.count({ where: { companyId: company.id } });
    const found = await prisma.account.findMany({
      where: { companyId: company.id, systemKey: { in: [...WANTED] } },
      select: { code: true, name: true, systemKey: true },
      orderBy: { code: 'asc' },
    });
    const missing = WANTED.filter((key) => !found.some((a) => a.systemKey === key));

    console.log(`${company.code} — ${company.name}`);
    console.log(`  accounts: ${accountCount}`);
    for (const a of found) console.log(`  ✓ ${a.code} ${a.name}`);
    for (const key of missing) console.log(`  ✗ missing: ${key}`);
    before.push({ company: company.code, accountCount, present: found, missing });

    if (!apply || missing.length === 0) {
      console.log(missing.length === 0 ? '  nothing to do\n' : '  (dry run)\n');
      continue;
    }

    await transaction((tx) => ensureChartOfAccounts(tx, company.id));

    const after = await prisma.account.findMany({
      where: { companyId: company.id, systemKey: { in: [...WANTED] } },
      select: { code: true, name: true, systemKey: true },
      orderBy: { code: 'asc' },
    });
    const afterCount = await prisma.account.count({ where: { companyId: company.id } });
    console.log(`  accounts now: ${afterCount} (+${afterCount - accountCount})`);
    for (const a of after) console.log(`  ✓ ${a.code} ${a.name}`);
    const stillMissing = WANTED.filter((key) => !after.some((a) => a.systemKey === key));
    if (stillMissing.length) {
      console.log(`  ✗ STILL MISSING: ${stillMissing.join(', ')}`);
      process.exitCode = 1;
    }
    console.log();
  }

  if (apply) {
    mkdirSync('backups', { recursive: true });
    const file = `backups/settlement-accounts-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), before }, null, 2));
    console.log(`State before the change: ${file}`);
  } else {
    console.log('Re-run with --apply to create them.');
  }
}

main().finally(() => prisma.$disconnect());
