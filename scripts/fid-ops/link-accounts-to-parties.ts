import 'dotenv/config';
import fs from 'node:fs';
import { prisma } from '@/lib/db';

/**
 * Tell the accounts opened in somebody's name whose they are.
 *
 * "Loan from RADOUAN MOHAMMED" has always been his account; the software
 * only knew it by reading the name. Matching on words is fine once and wrong
 * for ever after — the day somebody corrects a spelling the account comes
 * loose — so the link is made here, by hand, once, and from then on the
 * software carries it.
 *
 * Names are read. Nothing is renamed, no amount moves, and an account that
 * does not clearly belong to exactly one person is left alone and reported.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/link-accounts-to-parties.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/link-accounts-to-parties.ts --apply   # write
 */

const apply = process.argv.includes('--apply');

/** "Loan from X", "Loan to X", "X Current Account" — the X in each. */
function partyInName(accountName: string): string | null {
  const loan = accountName.match(/^loan\s+(?:from|to)\s+(.+)$/i);
  if (loan) return loan[1].trim();
  const current = accountName.match(/^(.+?)\s+current account$/i);
  if (current) return current[1].trim();
  return null;
}

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true, code: true } });
  const planned: Array<{ company: string; account: string; code: string; agent: string; agentId: string }> = [];
  const skipped: string[] = [];

  for (const company of companies) {
    const [accounts, agents] = await Promise.all([
      prisma.account.findMany({
        where: { companyId: company.id, agentId: null, status: 'ACTIVE' },
        select: { id: true, code: true, name: true },
      }),
      prisma.agent.findMany({ where: { companyId: company.id }, select: { id: true, agentName: true } }),
    ]);

    for (const account of accounts) {
      const party = partyInName(account.name);
      if (!party) continue;

      const matches = agents.filter((a) => a.agentName.trim().toLowerCase() === party.toLowerCase());
      if (matches.length === 0) {
        skipped.push(`${company.code} ${account.code} ${account.name} — no agent by that name`);
        continue;
      }
      if (matches.length > 1) {
        // Two people with the same name: a machine must not pick one.
        skipped.push(`${company.code} ${account.code} ${account.name} — ${matches.length} agents share that name`);
        continue;
      }
      planned.push({
        company: company.code,
        account: account.name,
        code: account.code,
        agent: matches[0].agentName,
        agentId: matches[0].id,
      });
    }
  }

  for (const row of planned) console.log(`  ${row.company}  ${row.account}  →  ${row.agent}`);
  for (const line of skipped) console.log(`  · left alone: ${line}`);

  if (planned.length === 0) {
    console.log('  nothing to link — every account in a person’s name already points at them');
    return;
  }
  if (!apply) {
    console.log(`dry run — ${planned.length} account(s) to link. Pass --apply to write.`);
    return;
  }

  const file = `backups/link-accounts-to-parties-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), planned, skipped }, null, 2));
  console.log('  backup written:', file);

  for (const row of planned) {
    const account = await prisma.account.findFirstOrThrow({
      where: { code: row.code, company: { code: row.company } },
      select: { id: true, companyId: true },
    });
    await prisma.account.update({ where: { id: account.id }, data: { agentId: row.agentId } });
    await prisma.auditLog.create({
      data: {
        companyId: account.companyId,
        action: 'ACCOUNT_LINKED_TO_PARTY',
        entityType: 'Account',
        entityId: account.id,
        after: { account: row.account, agent: row.agent, note: 'Link only; no name, amount or classification changed' },
      },
    });
  }

  console.log(`  linked ${planned.length} account(s); no figure touched`);
}

main().finally(() => prisma.$disconnect());
