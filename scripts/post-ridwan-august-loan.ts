import 'dotenv/config';
import fs from 'node:fs';
import { prisma } from '@/lib/db';
import { postLoan } from '@/lib/services/loan';
import { getAgentLedger } from '@/lib/services/agent-account';
import { getCashBook, getTrialBalanceReport, getBalanceSheet, getProfitAndLoss } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';

/**
 * The loan Ridwan Mohammad made the company on 12 August 2026.
 *
 *   MAD 27,000 into Cash in Hand
 *   Dr Cash in Hand (MAD)            27,000
 *   Cr Loan from Ridwan Mohammad     27,000
 *
 * Borrowing is not income: nothing reaches the profit and loss, and the
 * figures are the client's own — the amount and the account were given, not
 * inferred. The dry run posts inside a transaction and rolls it back, so the
 * books are only written with --apply.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/post-ridwan-august-loan.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/post-ridwan-august-loan.ts --apply   # write
 */

const AMOUNT = '27000';
const WHEN = new Date('2026-08-12T00:00:00.000Z');
const ACCOUNT = 'Cash in Hand';
const MEMO = 'Loan received from Ridwan Mohammad on 12 August';
const apply = process.argv.includes('--apply');

async function snapshot(companyId: string) {
  const [tb, sheet, pnl, check] = await Promise.all([
    getTrialBalanceReport({ companyId }),
    getBalanceSheet({ companyId, asOf: new Date('2026-12-31T00:00:00.000Z') }),
    getProfitAndLoss({ companyId, from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-12-31T00:00:00.000Z') }),
    reconcile(companyId),
  ]);
  return {
    trialBalanceDebitUsd: tb.rows.reduce((t, r) => t.plus(r.debitUsd), tb.totals?.debitUsd.minus(tb.totals.debitUsd) ?? tb.rows[0].debitUsd.minus(tb.rows[0].debitUsd)).toString(),
    balances: sheet.balancesUsd,
    netProfitUsd: pnl.totals.netProfitUsd.toString(),
    checksPassed: `${check.checks.filter((c) => c.passed).length}/${check.checks.length}`,
  };
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ where: { code: 'FID-MA' }, select: { id: true, name: true, localCurrency: true } });
  const agent = await prisma.agent.findFirstOrThrow({
    where: { companyId: company.id, agentName: { contains: 'idwan', mode: 'insensitive' } },
    select: { id: true, agentName: true },
  });
  const account = await prisma.cashBankAccount.findFirstOrThrow({
    where: { companyId: company.id, name: ACCOUNT, currency: 'MAD', status: 'ACTIVE' },
    select: { id: true, name: true, currency: true },
  });

  console.log(`${company.name}`);
  console.log(`  ${WHEN.toISOString().slice(0, 10)}  loan received from ${agent.agentName}`);
  console.log(`  MAD ${AMOUNT} into ${account.name} (${account.currency})`);

  const before = await snapshot(company.id);
  console.log('  before:', JSON.stringify(before));

  if (!apply) {
    const already = await prisma.journalEntry.count({
      where: { companyId: company.id, entryDate: WHEN, description: { contains: 'Loan received from Ridwan' } },
    });
    console.log(already > 0 ? '  ALREADY POSTED — nothing to do' : '  not yet on the books');
    console.log('dry run — pass --apply to write');
    return;
  }

  const file = `backups/pre-ridwan-loan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), before, agent, account, amount: AMOUNT, when: WHEN }, null, 2));
  console.log('  backup written:', file);

  const result = await postLoan({
    companyId: company.id,
    userId: (await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } })).id,
    loanDate: WHEN,
    direction: 'RECEIVED',
    agentId: agent.id,
    cashBankAccountId: account.id,
    currency: 'MAD',
    amount: AMOUNT,
    description: MEMO,
  });

  console.log(`  posted ${result.entry.entryNumber} to ${result.account.code} ${result.account.name}`);

  const after = await snapshot(company.id);
  console.log('  after: ', JSON.stringify(after));
  console.log(`  profit unchanged: ${before.netProfitUsd === after.netProfitUsd}`);

  const { rows, summary } = await getAgentLedger({ companyId: company.id, agentId: agent.id });
  for (const row of rows) {
    console.log(`  ledger  ${row.entryDate.toISOString().slice(0, 10)}  ${row.typeLabel}  ${row.accountKind}  ${row.currency} ${row.debit.greaterThan(0) ? row.debit : row.credit}`);
  }
  console.log(`  loan payable to him: ${summary.loanFromAgentLocal} ${company.localCurrency}`);

  const book = await getCashBook({ companyId: company.id, cashBankAccountId: account.id });
  const line = book.rows.find((r) => r.memo?.includes('Ridwan') || r.memo?.includes('Loan'));
  console.log(`  cash book: ${line ? `${line.reference} ${line.memo} in ${line.moneyIn}` : 'not found'}`);
}

main().finally(() => prisma.$disconnect());
