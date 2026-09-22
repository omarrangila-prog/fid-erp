import 'dotenv/config';
import { prisma } from '@/lib/db';
import { reconcile } from '@/lib/services/reconciliation';
import { getTrialBalanceReport, getBalanceSheet, getProfitAndLoss } from '@/lib/services/reports';
import { getAgentSummaries, getAgentControlTotals, getAgentLedger } from '@/lib/services/agent-account';
import { getReceivables } from '@/lib/services/receivables';
import { dec } from '@/lib/money';

/**
 * Read the client's live books and say whether they hold together.
 *
 * Nothing here writes. Every figure is read through the same services the
 * screens use, so what this prints is what the client would see, and a
 * failure here is a failure they would have found.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/audit-live.ts
 */

let failures = 0;
function check(label: string, passed: boolean, detail = '') {
  console.log(`  ${passed ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures += 1;
}

async function auditCompany(code: string) {
  const company = await prisma.company.findUniqueOrThrow({
    where: { code },
    select: { id: true, name: true, localCurrency: true },
  });
  const companyId = company.id;
  console.log(`\n${company.name} (${company.localCurrency})`);

  const [checks, tb, sheet, pnl] = await Promise.all([
    reconcile(companyId),
    getTrialBalanceReport({ companyId }),
    getBalanceSheet({ companyId, asOf: new Date('2026-12-31T00:00:00.000Z') }),
    getProfitAndLoss({
      companyId,
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T00:00:00.000Z'),
    }),
  ]);

  const failed = checks.checks.filter((c) => !c.passed);
  check(
    `reconciliation ${checks.checks.length - failed.length}/${checks.checks.length}`,
    failed.length === 0,
    failed.map((f) => f.label).join(', '),
  );

  const debit = tb.rows.reduce((total, row) => total.plus(row.debitUsd), dec(0));
  const credit = tb.rows.reduce((total, row) => total.plus(row.creditUsd), dec(0));
  check('trial balance balances', debit.minus(credit).abs().lessThan('0.01'), `USD ${debit.toFixed(2)}`);
  check('balance sheet balances', sheet.balancesUsd);
  console.log(`    net profit USD ${pnl.totals.netProfitUsd.toFixed(2)}`);

  // The agents explain the clearing account exactly, and nothing is left over.
  const control = await getAgentControlTotals(companyId);
  const agents = await getAgentSummaries(companyId);
  const held = agents.reduce((total, a) => total.plus(a.summary.holdingLocal), dec(0));
  check(
    'agent subledger = Agent Clearing',
    control.clearingTaggedLocal.minus(held).abs().lessThan('0.01') &&
      control.clearingLocal.minus(held).abs().lessThan('0.01'),
    `${company.localCurrency} ${control.clearingLocal.toFixed(2)} vs ${held.toFixed(2)}`,
  );
  check('no untagged clearing balance', control.untaggedLocal.abs().lessThan('0.01'), control.untaggedLocal.toString());

  // No customer has paid more than they were invoiced.
  const receivables = await getReceivables({ companyId });
  const overpaid = receivables.filter((r) => dec(r.outstandingAmount).lessThan('-0.01'));
  check('no invoice overpaid', overpaid.length === 0, overpaid.map((r) => r.invoiceNumber).join(', '));

  // No account carries a balance labelled in a currency it was never posted in.
  const mislabelled = await prisma.$queryRaw<Array<{ name: string; currencies: string }>>`
    SELECT a."name", string_agg(DISTINCT jl."currency", ', ') AS currencies
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId}
      AND je."status" = 'POSTED'
      AND a."currency" IS NOT NULL
      AND jl."currency" <> a."currency"
    GROUP BY a."name"`;
  check('no account posted outside its own currency', mislabelled.length === 0, mislabelled.map((m) => m.name).join(', '));

  for (const agent of agents) {
    const { summary } = await getAgentLedger({ companyId, agentId: agent.agentId });
    const owed = summary.netLocal;
    console.log(
      `    ${agent.agentName}: holding ${summary.holdingLocal.toFixed(2)}, ` +
        `loan payable ${summary.loanFromAgentLocal.toFixed(2)}, ` +
        `invoiced to him ${summary.tradeReceivableLocal.toFixed(2)} → ` +
        `${owed.isZero() ? 'square' : owed.isPositive() ? `he owes ${owed.toFixed(2)}` : `FID owes ${owed.abs().toFixed(2)}`} ${company.localCurrency}`,
    );
  }
}

async function main() {
  console.log('Reading the live books. Nothing is written.');
  for (const code of ['FID-DXB', 'FID-MA']) await auditCompany(code);
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
