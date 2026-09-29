import { getItemProfitabilityChecks } from '@/lib/services/item-profitability';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { dec, toMoney, type Decimal } from '@/lib/money';
import { LIVE_ENTRY_SQL } from '@/lib/services/journal-visibility';
import { getOutstandingSummary } from '@/lib/services/outstanding';
import { getAgentSummaries, getAgentControlTotals } from '@/lib/services/agent-account';
import { getAgentStatement } from '@/lib/services/agent-statement';
import { getUnpaidExpenseLedger } from '@/lib/services/unpaid-expenses';
import { getReceivables } from '@/lib/services/receivables';
import { getBalanceSheet, getFinancialPosition, getTrialBalanceReport } from '@/lib/services/reports';
import { getInventoryValuation } from '@/lib/services/stock';

/**
 * One financial truth, checked.
 *
 * The dashboard is a summary of the ledgers; it must never become a second
 * set of books. Each check here puts a figure the dashboard shows beside the
 * screen or ledger it summarises, and says whether they agree. A difference
 * is shown, never hidden — with enough detail to find the posting behind it.
 *
 * Two kinds of check. An "error" should always agree and means a fault. An
 * "info" compares two things that can legitimately differ (an advance on the
 * receivables control, stock at historical rates against today's) and is
 * there so someone looks, not so anyone panics.
 *
 * Read-only.
 */

export type ConsistencyCheck = {
  area: 'Agents' | 'Expenses' | 'Invoices' | 'Loans' | 'Cash & bank' | 'Inventory' | 'Statements';
  label: string;
  left: { label: string; value: Decimal };
  right: { label: string; value: Decimal };
  currency: string;
  difference: Decimal;
  ok: boolean;
  severity: 'error' | 'info';
  note?: string;
};

const TOLERANCE = dec('0.05');

function check(
  input: Omit<ConsistencyCheck, 'difference' | 'ok'>,
): ConsistencyCheck {
  const difference = toMoney(input.left.value.minus(input.right.value));
  return { ...input, difference, ok: difference.abs().lessThanOrEqualTo(TOLERANCE) };
}

export async function runConsistencyChecks(companyId: string): Promise<{
  localCurrency: string;
  checks: ConsistencyCheck[];
  failures: number;
}> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { localCurrency: true } });
  const local = company.localCurrency;
  const checks: ConsistencyCheck[] = [];

  const [outstanding, agents, control, unpaid, receivables, position, valuation] = await Promise.all([
    getOutstandingSummary(companyId),
    getAgentSummaries(companyId),
    getAgentControlTotals(companyId),
    getUnpaidExpenseLedger(companyId),
    getReceivables({ companyId, onlyOutstanding: true }),
    getFinancialPosition({ companyId }),
    getInventoryValuation(companyId),
  ]);

  // --- Agents: the dashboard card against each agent's own ledger ----------
  for (const agent of agents) {
    const statement = await getAgentStatement({ companyId, agentId: agent.agentId });
    const ledger = statement.events.at(-1)?.runningNetLocal ?? dec(0);
    const card = outstanding.agents.find((a) => a.agentId === agent.agentId);
    checks.push(
      check({
        area: 'Agents',
        label: `${agent.agentName}: dashboard balance = agent ledger balance`,
        left: { label: 'Dashboard card', value: card?.netLocal ?? dec(0) },
        right: { label: 'Agent ledger, closing balance', value: ledger },
        currency: local,
        severity: 'error',
        note: 'Positive: the agent owes FID (Dr).',
      }),
    );
    if (card) {
      checks.push(
        check({
          area: 'Agents',
          label: `${agent.agentName}: owes FID − FID owes = balance`,
          left: { label: 'Owes FID − FID owes', value: card.owesFidLocal.minus(card.fidOwesLocal) },
          right: { label: 'Balance', value: card.netLocal },
          currency: local,
          severity: 'error',
        }),
      );
    }
  }
  checks.push(
    check({
      area: 'Agents',
      label: 'Agent Clearing control = the agents’ own balances',
      left: { label: 'Agent Clearing (GL)', value: control.clearingLocal },
      right: { label: 'Named to an agent', value: control.clearingTaggedLocal },
      currency: local,
      severity: 'error',
      note: 'A difference is a posting on the control account without an agent’s name — a gap in the subledger, not extra money.',
    }),
    check({
      area: 'Agents',
      label: 'Agent Commission Payable control = the agents’ own balances',
      left: { label: 'Commission Payable (GL)', value: control.commissionLocal },
      right: { label: 'Named to an agent', value: control.commissionTaggedLocal },
      currency: local,
      severity: 'error',
    }),
  );

  // --- Unpaid expenses: dashboard, ledger, and the accounts that hold them --
  checks.push(
    check({
      area: 'Expenses',
      label: 'Dashboard unpaid expenses = Unpaid Expenses ledger',
      left: { label: 'Dashboard', value: outstanding.unpaidExpenses.local },
      right: { label: 'Unpaid Expenses ledger', value: unpaid.totals.outstandingLocal },
      currency: local,
      severity: 'error',
    }),
  );
  for (const row of unpaid.reconciliation) {
    if (row.ledgerLocal === null) continue;
    checks.push(
      check({
        area: 'Expenses',
        label: `Costs still owed = ${row.control} in the ledger`,
        left: { label: 'Outstanding costs', value: row.scheduleLocal },
        right: { label: `${row.control} (GL)`, value: row.ledgerLocal },
        currency: local,
        severity: 'error',
        note: 'A difference is something on the account that is not a cost, or a cost settled outside it.',
      }),
    );
  }

  // --- Invoices: the dashboard, the invoice list, and the control account ---
  const invoicesLocal = receivables
    .filter((r) => r.status !== 'PAID')
    .reduce(
      (t, r) =>
        t.plus(r.currency === local ? dec(r.outstandingAmount) : toMoney(dec(r.outstandingAmountUsd).times(dec(r.rateLocalPerUsd)))),
      dec(0),
    );
  checks.push(
    check({
      area: 'Invoices',
      label: 'Dashboard outstanding invoices = invoice list (unpaid + part paid, what is left)',
      left: { label: 'Dashboard', value: outstanding.invoicesOutstanding.local },
      right: { label: 'Invoice list', value: toMoney(invoicesLocal) },
      currency: local,
      severity: 'error',
    }),
  );
  const [ar] = await prisma.$queryRaw<Array<{ balance: string }>>(Prisma.sql`
    SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS balance
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND ${LIVE_ENTRY_SQL} AND a."systemKey" = 'ACCOUNTS_RECEIVABLE'`);
  checks.push(
    check({
      area: 'Invoices',
      label: 'Invoices still owed against the Accounts Receivable control',
      left: { label: 'Invoice list', value: toMoney(invoicesLocal) },
      right: { label: 'Accounts Receivable (GL)', value: dec(ar?.balance ?? 0) },
      currency: local,
      severity: 'info',
      note: 'Can differ by money received but not yet matched to an invoice, credit notes not yet applied, and dollar invoices restated at their own rates.',
    }),
  );

  // --- Loans: each party's line on the dashboard against its own account ---
  const loanAccounts = await prisma.$queryRaw<Array<{ id: string; balance: string }>>(Prisma.sql`
    SELECT a."id", COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS balance
    FROM accounts a
    JOIN journal_lines jl ON jl."accountId" = a."id"
    JOIN journal_entries je ON je."id" = jl."journalEntryId" AND ${LIVE_ENTRY_SQL}
    WHERE a."companyId" = ${companyId} AND a."id" = ANY(${outstanding.loanParties.map((p) => p.accountId)})
    GROUP BY a."id"`);
  for (const party of outstanding.loanParties) {
    const gl = dec(loanAccounts.find((a) => a.id === party.accountId)?.balance ?? 0);
    checks.push(
      check({
        area: 'Loans',
        label: `${party.name}: dashboard = its own ledger (${party.side === 'payable' ? 'FID owes' : 'owed to FID'})`,
        left: { label: 'Dashboard', value: party.amountLocal },
        right: { label: 'Account balance', value: gl.abs() },
        currency: local,
        severity: 'error',
      }),
    );
  }

  // --- Cash and bank: the dashboard's drawers against their GL accounts ----
  const byGl = new Map<string, { names: string[]; currency: string; balance: Decimal; mixed: boolean }>();
  for (const account of position.accounts) {
    const entry = byGl.get(account.glAccountId) ?? { names: [], currency: account.currency, balance: dec(0), mixed: false };
    entry.names.push(account.name);
    entry.mixed ||= entry.currency !== account.currency;
    entry.balance = entry.balance.plus(account.balance);
    byGl.set(account.glAccountId, entry);
  }
  const glRows = byGl.size
    ? await prisma.$queryRaw<Array<{ id: string; name: string; balance: string }>>(Prisma.sql`
        SELECT a."id", a."name", COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS balance
        FROM accounts a
        LEFT JOIN journal_lines jl ON jl."accountId" = a."id"
          AND EXISTS (SELECT 1 FROM journal_entries je WHERE je."id" = jl."journalEntryId" AND ${LIVE_ENTRY_SQL})
        WHERE a."id" = ANY(${[...byGl.keys()]})
        GROUP BY a."id", a."name"`)
    : [];
  for (const [glId, entry] of byGl) {
    if (entry.mixed) continue;
    const gl = glRows.find((r) => r.id === glId);
    checks.push(
      check({
        area: 'Cash & bank',
        label: `${entry.names.join(', ')}: dashboard = ${gl?.name ?? 'GL account'}`,
        left: { label: 'Dashboard (cash/bank ledger)', value: toMoney(entry.balance) },
        right: { label: 'GL account', value: toMoney(dec(gl?.balance ?? 0)) },
        currency: entry.currency,
        severity: 'error',
        note: 'In the account’s own currency. The dashboard adds the opening balance typed on the account; the GL has it only if it was posted.',
      }),
    );
  }

  // --- Inventory: the dashboard's stock value against the valuation report --
  const valuationUsd = valuation.reduce((t, line) => t.plus(line.valueUsd), dec(0));
  checks.push(
    check({
      area: 'Inventory',
      label: 'Dashboard stock value = Inventory Valuation report (USD)',
      left: { label: 'Dashboard', value: toMoney(position.inventoryValueUsd) },
      right: { label: 'Inventory Valuation', value: toMoney(valuationUsd) },
      currency: 'USD',
      severity: 'error',
    }),
  );

  // --- Customer receivables: the control account against its customers ----
  // A line on the control with no customer on it would be receivable nobody owes —
  // the one way the control and the customer ledgers could quietly part company.
  const [arSplit] = await prisma.$queryRaw<Array<{ tagged: string; untagged: string }>>(Prisma.sql`
    SELECT COALESCE(SUM(CASE WHEN jl."customerId" IS NOT NULL THEN jl."debitLocal" - jl."creditLocal" ELSE 0 END), 0)::text AS tagged,
           COALESCE(SUM(CASE WHEN jl."customerId" IS NULL THEN jl."debitLocal" - jl."creditLocal" ELSE 0 END), 0)::text AS untagged
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND ${LIVE_ENTRY_SQL} AND a."systemKey" = 'ACCOUNTS_RECEIVABLE'`);
  checks.push(
    check({
      area: 'Invoices',
      label: 'Accounts Receivable control = the customers’ own ledgers (added once, never twice)',
      left: { label: 'Accounts Receivable (GL)', value: toMoney(dec(ar?.balance ?? 0)) },
      right: { label: 'Sum of customer ledgers', value: toMoney(dec(arSplit?.tagged ?? 0)) },
      currency: local,
      severity: 'error',
      note: 'The control and the customer ledgers are one balance seen twice; the dashboard shows it once.',
    }),
  );

  // --- The books themselves -------------------------------------------------
  const [unbalanced] = await prisma.$queryRaw<Array<{ entries: string }>>(Prisma.sql`
    SELECT COUNT(*)::text AS entries FROM (
      SELECT je."id"
      FROM journal_entries je
      JOIN journal_lines jl ON jl."journalEntryId" = je."id"
      WHERE je."companyId" = ${companyId} AND ${LIVE_ENTRY_SQL}
      GROUP BY je."id"
      HAVING ABS(SUM(jl."debitLocal" - jl."creditLocal")) > 0.004 OR ABS(SUM(jl."debitUsd" - jl."creditUsd")) > 0.004
    ) x`);
  checks.push(
    check({
      area: 'Statements',
      label: `Every posted journal entry balances, in ${local} and in USD`,
      left: { label: 'Unbalanced entries', value: dec(unbalanced?.entries ?? 0) },
      right: { label: 'Expected', value: dec(0) },
      currency: 'entries',
      severity: 'error',
    }),
  );
  const [sheet, trial] = await Promise.all([
    // Every dated entry, as the Cash & Bank page counts them — including any dated later than today.
    getBalanceSheet({ companyId, asOf: new Date('9999-12-31T00:00:00.000Z') }),
    getTrialBalanceReport({ companyId }),
  ]);
  checks.push(
    check({
      area: 'Statements',
      label: `Balance Sheet: assets = liabilities + equity (${local})`,
      left: { label: 'Assets', value: sheet.assets.totalLocal },
      right: { label: 'Liabilities + equity', value: toMoney(sheet.liabilities.totalLocal.plus(sheet.equity.totalLocal)) },
      currency: local,
      severity: 'error',
    }),
    check({
      area: 'Statements',
      label: 'Balance Sheet: assets = liabilities + equity (USD equivalent)',
      left: { label: 'Assets', value: sheet.assets.totalUsd },
      right: { label: 'Liabilities + equity', value: toMoney(sheet.liabilities.totalUsd.plus(sheet.equity.totalUsd)) },
      currency: 'USD',
      severity: 'error',
    }),
    check({
      area: 'Statements',
      label: `Trial Balance: debits = credits (${local})`,
      left: { label: 'Debits', value: trial.totals.debitLocal },
      right: { label: 'Credits', value: trial.totals.creditLocal },
      currency: local,
      severity: 'error',
    }),
  );
  // The same drawer, read by the Cash & Bank page and by the Balance Sheet, in the currency it is kept in.
  for (const account of position.accounts) {
    if (account.currency !== local) continue;
    const line = sheet.assets.lines.find((l) => l.accountId === account.glAccountId);
    if (!line && account.balance.isZero()) continue;
    if ((byGl.get(account.glAccountId)?.names.length ?? 0) > 1) continue;
    checks.push(
      check({
        area: 'Cash & bank',
        label: `${account.name}: Cash & Bank page = Balance Sheet line (${local})`,
        left: { label: 'Cash & Bank page', value: account.balance },
        right: { label: 'Balance Sheet', value: line?.amountLocal ?? dec(0) },
        currency: local,
        severity: 'error',
        note: 'Both in the account’s own currency; the USD shown under each is the equivalent at every movement’s own rate.',
      }),
    );
  }

  // --- Stock on Hand by item: against Current Stock, the invoices, Shipment
  // Profitability and Outstanding Invoices -----------------------------------
  for (const item of await getItemProfitabilityChecks(companyId)) {
    // The identities that hold by construction are the item page's business; these are the cross-checks.
    if (['stock-equation', 'profit', 'collected'].includes(item.key)) continue;
    checks.push(
      check({
        area: 'Inventory',
        label: `Stock on Hand by item: ${item.label}`,
        left: { label: 'Stock on Hand', value: item.shownValue },
        right: { label: item.sourceLabel, value: item.sourceValue },
        currency: item.unit === 'KG' ? 'KG' : item.unit === 'USD' ? 'USD' : local,
        severity: 'error',
      }),
    );
  }

  return { localCurrency: local, checks, failures: checks.filter((c) => !c.ok && c.severity === 'error').length };
}
