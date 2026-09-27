import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { dec, toMoney, type Decimal } from '@/lib/money';
import { getReceivables, getPayables } from '@/lib/services/receivables';
import { getExpenseSettlements } from '@/lib/services/expense-settlement';
import { getAgentSummaries } from '@/lib/services/agent-account';
import { LIVE_ENTRY_SQL } from '@/lib/services/journal-visibility';

/**
 * What is still to be paid or collected, for the dashboard.
 *
 * Every figure comes from the calculation its own screen uses — the invoice
 * list, the payables, the expense list, the agent ledger — so a card and the
 * list it opens can never disagree, and nothing is added up twice. Amounts are
 * in the company's currency: each document's own amount when it is in that
 * currency, otherwise its outstanding dollars at its own rate.
 */

/** `usd` is the sum of each document's own dollar equivalent; null where none is kept. */
export type OutstandingFigure = { count: number; local: Decimal; usd: Decimal | null };

export type AgentOutstanding = {
  agentId: string;
  agentName: string;
  /** Customer money he holds for the company. */
  holdingLocal: Decimal;
  /** Commission the company owes him. */
  commissionLocal: Decimal;
  /** What the company borrowed from him. */
  loanFromLocal: Decimal;
  /** What the company lent him. */
  loanToLocal: Decimal;
};

export type OutstandingSummary = {
  localCurrency: string;
  invoicesUnpaid: OutstandingFigure;
  invoicesPartial: OutstandingFigure;
  supplierPayables: OutstandingFigure;
  shipmentExpensesUnpaid: OutstandingFigure;
  generalExpensesUnpaid: OutstandingFigure;
  /** Every cost still owed — shipment and general, and those owed to an agent — as on the Unpaid Expenses ledger. */
  unpaidExpenses: OutstandingFigure;
  agentCollections: OutstandingFigure;
  agentCommission: OutstandingFigure;
  loansPayable: OutstandingFigure;
  loansReceivable: OutstandingFigure;
  agents: AgentOutstanding[];
};

const zero = (): OutstandingFigure => ({ count: 0, local: dec(0), usd: null });
const bump = (figure: OutstandingFigure, amount: Decimal, usd?: Decimal) => {
  figure.count += 1;
  figure.local = toMoney(figure.local.plus(amount));
  if (usd) figure.usd = toMoney((figure.usd ?? dec(0)).plus(usd));
};

export async function getOutstandingSummary(companyId: string): Promise<OutstandingSummary> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { localCurrency: true } });
  const local = company.localCurrency;
  const inLocal = (currency: string, amount: Decimal, usd: Decimal, rate: Decimal) =>
    currency === local ? amount : toMoney(usd.times(rate));

  const [receivables, payables, owedExpenses, agents, loans] = await Promise.all([
    getReceivables({ companyId, onlyOutstanding: true }),
    getPayables({ companyId, onlyOutstanding: true }),
    // Only costs booked as owed can be unpaid; those paid on the spot never are.
    prisma.expense.findMany({
      where: { companyId, status: 'POSTED', cashBankAccountId: null, ledgerAccountId: null, ledgerAgentId: null },
      include: { cashBankAccount: { select: { name: true } }, vendor: { select: { country: true } } },
    }),
    getAgentSummaries(companyId),
    /*
     * Loans by the accounts loans were actually posted to: the system and
     * "Loan from / Loan to" accounts, and any account the loan form was
     * pointed at — the Moroccan side of the loan from Dubai sits in an
     * account named after the lender, which a name match alone missed. A
     * liability is what FID owes; an asset is what it is owed. Balances in
     * the company's currency, live entries only; the cash side of a loan is
     * never counted.
     */
    prisma.$queryRaw<Array<{ side: string; accounts: bigint; balance: string }>>(Prisma.sql`
      WITH loan_accounts AS (
        SELECT a."id" FROM accounts a
        WHERE a."companyId" = ${companyId}
          AND (a."systemKey" IN ('INTERCOMPANY_LOAN_PAYABLE', 'INTERCOMPANY_LOAN_RECEIVABLE')
               OR lower(a."name") LIKE 'loan from%' OR lower(a."name") LIKE 'loan to%')
        UNION
        SELECT jl."accountId" FROM journal_lines jl
        JOIN journal_entries je ON je."id" = jl."journalEntryId"
        WHERE je."companyId" = ${companyId} AND je."sourceType" = 'MANUAL' AND je."sourceId" LIKE 'LOAN%'
          AND jl."cashBankAccountId" IS NULL
      )
      SELECT CASE WHEN a."type" = 'LIABILITY' THEN 'payable' ELSE 'receivable' END AS side,
             COUNT(DISTINCT a."id") AS accounts,
             COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS balance
      FROM accounts a
      JOIN loan_accounts la ON la."id" = a."id"
      JOIN journal_lines jl ON jl."accountId" = a."id"
      JOIN journal_entries je ON je."id" = jl."journalEntryId" AND ${LIVE_ENTRY_SQL}
      WHERE a."type" IN ('LIABILITY', 'ASSET')
      GROUP BY 1`),
  ]);

  const summary: OutstandingSummary = {
    localCurrency: local,
    invoicesUnpaid: zero(),
    invoicesPartial: zero(),
    supplierPayables: zero(),
    shipmentExpensesUnpaid: zero(),
    generalExpensesUnpaid: zero(),
    unpaidExpenses: zero(),
    agentCollections: zero(),
    agentCommission: zero(),
    loansPayable: zero(),
    loansReceivable: zero(),
    agents: [],
  };

  for (const row of receivables) {
    const amount = inLocal(row.currency, dec(row.outstandingAmount), dec(row.outstandingAmountUsd), dec(row.rateLocalPerUsd));
    if (row.status === 'UNPAID') bump(summary.invoicesUnpaid, amount, dec(row.outstandingAmountUsd));
    else if (row.status === 'PARTIAL') bump(summary.invoicesPartial, amount, dec(row.outstandingAmountUsd));
  }

  // Supplier bills booked as costs are counted with the costs, not twice here.
  for (const row of payables) {
    if (row.kind === 'EXPENSE') continue;
    const amount = inLocal(row.currency, dec(row.outstandingAmount), dec(row.outstandingAmountUsd), dec(row.rateLocalPerUsd));
    if (amount.greaterThan('0.005')) bump(summary.supplierPayables, amount, dec(row.outstandingAmountUsd));
  }

  const settlements = await getExpenseSettlements(companyId, owedExpenses);
  for (const expense of owedExpenses) {
    const settled = settlements.get(expense.id);
    if (!settled || settled.status === 'PAID') continue;
    // The share still owed, in dollars at the cost's own rate.
    const usd = settled.gross.isZero()
      ? dec(0)
      : toMoney(dec(expense.amountUsd).plus(dec(expense.taxAmountUsd)).times(settled.outstanding).dividedBy(settled.gross));
    bump(summary.unpaidExpenses, settled.outstandingLocal, usd);
    // Costs owed to an agent are also on his commission card; the two
    // shipment/general figures keep to the costs nobody else counts.
    if (expense.payableToAgentId) continue;
    bump(expense.kind === 'SHIPMENT' ? summary.shipmentExpensesUnpaid : summary.generalExpensesUnpaid, settled.outstandingLocal, usd);
  }

  for (const agent of agents) {
    const s = agent.summary;
    const row: AgentOutstanding = {
      agentId: agent.agentId,
      agentName: agent.agentName,
      holdingLocal: toMoney(s.holdingLocal),
      commissionLocal: toMoney(s.commissionLocal),
      loanFromLocal: toMoney(s.loanFromAgentLocal),
      loanToLocal: toMoney(s.loanToAgentLocal),
    };
    if (row.holdingLocal.greaterThan('0.005')) bump(summary.agentCollections, row.holdingLocal);
    if (row.commissionLocal.greaterThan('0.005')) bump(summary.agentCommission, row.commissionLocal);
    const any = [row.holdingLocal, row.commissionLocal, row.loanFromLocal, row.loanToLocal].some((v) => v.abs().greaterThan('0.005'));
    if (any) summary.agents.push(row);
  }

  for (const row of loans) {
    const balance = dec(row.balance);
    // A payable carries a credit balance: what is owed is its negative.
    const owed = row.side === 'payable' ? balance.negated() : balance;
    if (owed.greaterThan('0.005')) {
      const target = row.side === 'payable' ? summary.loansPayable : summary.loansReceivable;
      target.count = Number(row.accounts);
      target.local = toMoney(owed);
    }
  }

  summary.agents.sort((a, b) => b.holdingLocal.plus(b.loanFromLocal).comparedTo(a.holdingLocal.plus(a.loanFromLocal)));
  return summary;
}
