import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma, transaction } from '@/lib/db';
import { dec } from '@/lib/money';
import { postJournalEntry } from '@/lib/services/accounting';
import { writeAudit } from '@/lib/services/audit';

/**
 * Two corrections from the live report audit of 20 Oct 2026, approved by the
 * owner ("do it according to you what is correct").
 *
 * 1. The group loan. Morocco charged Sameer and Ali's Tangier trip (USD
 *    3,401.30, MAD 31,360) against the loan from Dubai in FID-MA-JV-000344, so
 *    it owes USD 46,598.70. Dubai never recorded its side and still shows USD
 *    50,000 receivable. Dubai books the same charge: the trip as its travel
 *    expense, the loan receivable down by the same USD 3,401.30, dated as
 *    Morocco dated it.
 *
 * 2. Radouan's loans. JV-000150 (MAD 400,000, "radouan gave loan to fid to pay
 *    vat") and JV-000147 (MAD 490, "LOAN FROM RADOUAN") credited his
 *    collections account instead of his loan account. Each is moved, at its
 *    own rate, to "Loan from RADOUAN MOHAMMED". His net with FID does not move.
 *
 * Nothing is deleted or rewritten; each correction is a new voucher naming the
 * one it answers, with an audit record. Refuses to post twice. Dry run unless
 * --apply.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/correct-loans-oct-2026.ts [--apply]
 */
const apply = process.argv.includes('--apply');
const DUBAI_SOURCE = 'intercompany-match-FID-MA-JV-000344';
const RADOUAN_SOURCE = 'radouan-loans-reclass-JV-000150-JV-000147';

async function local(companyId: string, accountId: string) {
  const [row] = await prisma.$queryRaw<Array<{ local: string; usd: string }>>`
    SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local, COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd
      FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId"
     WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND jl."accountId" = ${accountId}`;
  return { local: dec(row.local).toFixed(2), usd: dec(row.usd).toFixed(2) };
}

async function counts() {
  const [row] = await prisma.$queryRaw<Array<{ entries: bigint; lines: bigint }>>`
    SELECT (SELECT count(*) FROM journal_entries) AS entries, (SELECT count(*) FROM journal_lines) AS lines`;
  return { entries: Number(row.entries), lines: Number(row.lines) };
}

async function main() {
  const ma = await prisma.company.findUniqueOrThrow({ where: { code: 'FID-MA' }, select: { id: true, localCurrency: true } });
  const dx = await prisma.company.findUniqueOrThrow({ where: { code: 'FID-DXB' }, select: { id: true, localCurrency: true } });
  const admin = await prisma.user.findFirstOrThrow({ where: { name: { contains: 'Ali Raza' } }, select: { id: true, name: true } });

  const already = await prisma.journalEntry.findMany({ where: { sourceId: { in: [DUBAI_SOURCE, RADOUAN_SOURCE] } }, select: { entryNumber: true } });
  if (already.length) throw new Error(`Already posted: ${already.map((e) => e.entryNumber).join(', ')}`);

  // --- what is being answered, read from the books, not typed in -----------
  const jv344 = await prisma.journalEntry.findFirstOrThrow({
    where: { companyId: ma.id, entryNumber: 'FID-MA-JV-000344', status: 'POSTED', reversedBy: { is: null } },
    select: { entryDate: true, lines: { select: { debit: true, currency: true, account: { select: { code: true } } } } },
  });
  const charge = jv344.lines.find((l) => l.account.code === '1600' && l.currency === 'USD');
  if (!charge || !dec(charge.debit).equals('3401.3')) throw new Error('JV-000344 is not as audited');
  const dxLoan = await prisma.account.findFirstOrThrow({ where: { companyId: dx.id, code: '1700' }, select: { id: true, name: true } });
  const dxTravel = await prisma.account.findFirstOrThrow({ where: { companyId: dx.id, code: '6108', type: 'EXPENSE' }, select: { id: true, name: true } });
  const dxRate = (await prisma.journalLine.findFirstOrThrow({ where: { accountId: dxLoan.id }, select: { rateLocalPerUsd: true } })).rateLocalPerUsd;

  const misposted = await prisma.journalLine.findMany({
    where: {
      journalEntry: { companyId: ma.id, entryNumber: { in: ['FID-MA-JV-000150', 'FID-MA-JV-000147'] }, status: 'POSTED', reversedBy: { is: null } },
      account: { systemKey: 'AGENT_CLEARING' },
    },
    select: { credit: true, currency: true, rateToUsd: true, rateLocalPerUsd: true, agentId: true, journalEntry: { select: { entryNumber: true, description: true } } },
  });
  if (misposted.length !== 2 || misposted.some((l) => l.currency !== 'MAD' || !l.agentId)) throw new Error('JV-000150 / JV-000147 are not as audited');
  const loanAcc = await prisma.account.findFirstOrThrow({ where: { companyId: ma.id, code: '2401' }, select: { id: true, name: true, agentId: true } });
  const clearing = await prisma.account.findFirstOrThrow({ where: { companyId: ma.id, systemKey: 'AGENT_CLEARING' }, select: { id: true } });
  const dxBefore = { loanReceivable: await local(dx.id, dxLoan.id), travel: await local(dx.id, dxTravel.id) };
  const maBefore = { agentClearing: await local(ma.id, clearing.id), loanFromRadouan: await local(ma.id, loanAcc.id) };
  const before = await counts();

  console.log('1. Dubai:', `Dr ${dxTravel.name} / Cr ${dxLoan.name}  USD 3,401.30 at ${dxRate} AED, dated ${jv344.entryDate.toISOString().slice(0, 10)}`);
  for (const l of misposted) console.log('2. Morocco:', `Dr Agent Clearing / Cr ${loanAcc.name}  MAD ${dec(l.credit).toFixed(2)} (${l.journalEntry.entryNumber}, rate ${l.rateToUsd})`);
  console.log('before', { dxBefore, maBefore, rows: before });
  if (!apply) {
    console.log('\nDry run — nothing was written. Re-run with --apply.');
    return;
  }

  const posted = await transaction(async (tx) => {
    const dubai = await postJournalEntry(tx, {
      companyId: dx.id,
      entryDate: jv344.entryDate,
      description: 'SAMEER AND ALI TANGIER TRIP EXP & SHOPPING — charged by FID Trading International SARL against the group loan (their FID-MA-JV-000344)',
      reference: 'FID-MA-JV-000344',
      sourceType: 'MANUAL',
      sourceId: DUBAI_SOURCE,
      createdById: admin.id,
      localCurrency: dx.localCurrency,
      rateLocalPerUsd: dxRate,
      lines: [
        { accountId: dxTravel.id, direction: 'DEBIT', currency: 'USD', amount: '3401.30', rateToUsd: 1, description: 'Tangier trip, Sameer and Ali' },
        { accountId: dxLoan.id, direction: 'CREDIT', currency: 'USD', amount: '3401.30', rateToUsd: 1, description: 'Set against the loan to FID Morocco' },
      ],
    });
    await writeAudit(tx, {
      companyId: dx.id,
      userId: admin.id,
      action: 'INTERCOMPANY_MATCHED',
      entityType: 'JournalEntry',
      entityId: dubai.id,
      before: dxBefore,
      after: { matches: 'FID-MA-JV-000344', amountUsd: '3401.30', loanReceivableUsd: '46598.70' },
    });

    const morocco = await postJournalEntry(tx, {
      companyId: ma.id,
      entryDate: new Date(Date.UTC(2026, 9, 20)),
      description: "Radouan's loans to FID moved from his collections account to his loan account (FID-MA-JV-000150, FID-MA-JV-000147)",
      reference: 'FID-MA-JV-000150 / FID-MA-JV-000147',
      sourceType: 'MANUAL',
      sourceId: RADOUAN_SOURCE,
      createdById: admin.id,
      localCurrency: ma.localCurrency,
      rateLocalPerUsd: misposted[0].rateLocalPerUsd,
      lines: misposted.flatMap((l) => [
        { accountId: clearing.id, direction: 'DEBIT' as const, currency: 'MAD', amount: l.credit, rateToUsd: l.rateToUsd, agentId: l.agentId, description: `Not a collection: ${l.journalEntry.description} (${l.journalEntry.entryNumber})` },
        { accountId: loanAcc.id, direction: 'CREDIT' as const, currency: 'MAD', amount: l.credit, rateToUsd: l.rateToUsd, agentId: loanAcc.agentId ?? l.agentId, description: `Loan from Radouan (${l.journalEntry.entryNumber})` },
      ]),
    });
    await writeAudit(tx, {
      companyId: ma.id,
      userId: admin.id,
      action: 'AGENT_LOAN_RECLASSIFIED',
      entityType: 'JournalEntry',
      entityId: morocco.id,
      before: maBefore,
      after: { moved: '400490.00', from: 'Agent Clearing', to: loanAcc.name, answers: ['FID-MA-JV-000150', 'FID-MA-JV-000147'] },
    });
    return { dubai: dubai.entryNumber, morocco: morocco.entryNumber };
  }, 60_000);

  const after = {
    dx: { loanReceivable: await local(dx.id, dxLoan.id), travel: await local(dx.id, dxTravel.id) },
    ma: { agentClearing: await local(ma.id, clearing.id), loanFromRadouan: await local(ma.id, loanAcc.id) },
    rows: await counts(),
  };
  console.log('posted', posted, 'after', after);
  mkdirSync('backups', { recursive: true });
  const file = `backups/loan-corrections-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ posted, before: { dxBefore, maBefore, rows: before }, after }, null, 2));
  console.log('record', file);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
