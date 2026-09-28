import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { transaction } from '@/lib/db';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getExpenseSettlements } from '@/lib/services/expense-settlement';
import { getUnpaidExpenseLedger, settleUnpaidExpense } from '@/lib/services/unpaid-expenses';
import { getOutstandingSummary } from '@/lib/services/outstanding';
import { getCashBankBalance, postJournalEntry } from '@/lib/services/accounting';
import { getAgentStatement } from '@/lib/services/agent-statement';
import { runConsistencyChecks } from '@/lib/services/consistency';
import { getExpenseOutstanding } from '@/lib/services/payment';

/**
 * One financial truth: a cost's status comes from what actually settled it,
 * and the dashboard shows an agent the balance his own ledger shows.
 *
 * The paid / unpaid / part / full run is the brief's own (§34–37). Then the
 * two ways the screens used to disagree: a journal voucher that pays a cost
 * without naming it — the ledger went down, the cost still read Unpaid — and
 * an agent whose collections account is in credit and whose loan account is
 * in debit, which put negative figures on both sides of his dashboard card.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let categoryId: string;
let cashId: string;
let agentId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  await createMasters(companyId, { currency: 'MAD' });
  categoryId = (await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'GENERAL', status: 'ACTIVE' } })).id;
  cashId = (await getCashAccount(companyId, 'MAD')).id;
  agentId = (await prisma.agent.create({ data: { companyId, agentCode: 'AG-TRUTH', agentName: 'Truth Agent' } })).id;
}, 300_000);

async function cost(amount: string, how: { paidFrom?: string; owedToAgent?: string }, memo: string) {
  const expense = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-09-01'), expenseCategoryId: categoryId, currency: 'MAD', amount,
      rateToUsd: '10', rateLocalPerUsd: '10', kind: 'GENERAL', capitaliseToLandedCost: false,
      paymentMethod: 'CASH', description: memo,
      ...(how.paidFrom ? { cashBankAccountId: how.paidFrom } : {}),
      ...(how.owedToAgent ? { payableToAgentId: how.owedToAgent } : {}),
    } as never,
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
  return expense.id;
}

async function statusOf(expenseId: string) {
  const expense = await prisma.expense.findUniqueOrThrow({
    where: { id: expenseId },
    include: { cashBankAccount: { select: { name: true } }, vendor: { select: { country: true } } },
  });
  return (await getExpenseSettlements(companyId, [expense])).get(expenseId)!;
}

async function settle(expenseId: string, amount: string) {
  await settleUnpaidExpense(
    {
      companyId, expenseId, settlementDate: utcDate('2026-09-10'), method: 'CASH', amount,
      rateToUsd: '10', rateLocalPerUsd: '10', cashBankAccountId: cashId,
    },
    ctx.admin.id,
  );
}

let jvCount = 0;
async function journal(lines: Array<{ key?: 'ACCRUED_EXPENSES' | 'AGENT_COMMISSION_PAYABLE' | 'AGENT_CLEARING'; accountId?: string; cash?: boolean; side: 'DEBIT' | 'CREDIT'; amount: string; agentId?: string }>) {
  jvCount += 1;
  await transaction((tx) =>
    postJournalEntry(tx, {
      companyId, entryDate: utcDate('2026-09-15'), description: `Truth JV ${jvCount}`, sourceType: 'MANUAL',
      sourceId: `TRUTH-JV-${jvCount}`, createdById: ctx.admin.id, localCurrency: 'MAD', rateLocalPerUsd: '10',
      lines: lines.map((l) => ({
        ...(l.cash ? { cashBankAccountId: cashId } : l.key ? { accountKey: l.key } : { accountId: l.accountId }),
        direction: l.side, currency: 'MAD', amount: l.amount, rateToUsd: '10', agentId: l.agentId,
      })),
    } as never),
  );
}

const unpaidOnDashboard = async () => Number((await getOutstandingSummary(companyId)).unpaidExpenses.local);
const onUnpaidLedger = async (id: string) => (await getUnpaidExpenseLedger(companyId)).rows.find((r) => r.expenseId === id);

describe('paid, unpaid, part, full — from what settled it (§34–37)', () => {
  it('§34 paid from cash: Paid, nothing outstanding, cash down, not on the unpaid totals', async () => {
    const before = Number(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)));
    const dashBefore = await unpaidOnDashboard();
    const id = await cost('10000', { paidFrom: cashId }, 'Paid on the spot');
    const s = await statusOf(id);
    expect(s.status).toBe('PAID');
    expect(Number(s.outstanding)).toBe(0);
    expect(Number(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)))).toBeCloseTo(before - 10_000, 2);
    expect(await unpaidOnDashboard()).toBeCloseTo(dashBefore, 2);
    expect(await onUnpaidLedger(id)).toBeUndefined();
  }, 300_000);

  let accruedId: string;
  it('§35 unpaid: Unpaid, 20,000 outstanding, on the ledger and the dashboard', async () => {
    const dashBefore = await unpaidOnDashboard();
    accruedId = await cost('20000', {}, 'Accrued, pay later');
    const s = await statusOf(accruedId);
    expect(s.status).toBe('UNPAID');
    expect(Number(s.outstanding)).toBeCloseTo(20_000, 2);
    expect(Number((await onUnpaidLedger(accruedId))!.outstandingLocal)).toBeCloseTo(20_000, 2);
    expect(await unpaidOnDashboard()).toBeCloseTo(dashBefore + 20_000, 2);
  }, 300_000);

  it('§36 5,000 paid: Partially settled, 15,000 left everywhere', async () => {
    const dashBefore = await unpaidOnDashboard();
    await settle(accruedId, '5000');
    const s = await statusOf(accruedId);
    expect(s.status).toBe('PARTIAL');
    expect(Number(s.paid)).toBeCloseTo(5_000, 2);
    expect(Number(s.outstanding)).toBeCloseTo(15_000, 2);
    const row = (await onUnpaidLedger(accruedId))!;
    expect(row.status).toBe('PARTIAL');
    expect(Number(row.outstandingLocal)).toBeCloseTo(15_000, 2);
    expect(await unpaidOnDashboard()).toBeCloseTo(dashBefore - 5_000, 2);
  }, 300_000);

  it('§37 the other 15,000: Paid, and gone from the unpaid totals', async () => {
    const dashBefore = await unpaidOnDashboard();
    await settle(accruedId, '15000');
    const s = await statusOf(accruedId);
    expect(s.status).toBe('PAID');
    expect(Number(s.outstanding)).toBe(0);
    expect((await onUnpaidLedger(accruedId))!.status).toBe('SETTLED');
    expect(await unpaidOnDashboard()).toBeCloseTo(dashBefore - 15_000, 2);
  }, 300_000);
});

describe('a journal voucher that pays a cost pays it on every screen', () => {
  it('Dr Accrued Expenses / Cr Cash: the accrued cost reads Paid, and the ledger agrees', async () => {
    const id = await cost('3000', {}, 'Rent, paid later by JV');
    expect((await statusOf(id)).status).toBe('UNPAID');
    await journal([
      { key: 'ACCRUED_EXPENSES', side: 'DEBIT', amount: '1000' },
      { cash: true, side: 'CREDIT', amount: '1000' },
    ]);
    expect((await statusOf(id)).status).toBe('PARTIAL');
    await journal([
      { key: 'ACCRUED_EXPENSES', side: 'DEBIT', amount: '2000' },
      { cash: true, side: 'CREDIT', amount: '2000' },
    ]);
    const s = await statusOf(id);
    expect(s.status).toBe('PAID');
    expect(s.paidFrom).toMatch(/Journal entry \(JV\)/);
    // And the Payments form has nothing left to pay on it: paying it twice is how books go wrong.
    expect(Number((await transaction((tx) => getExpenseOutstanding(tx, id))).amount)).toBeCloseTo(0, 2);
    await expect(
      settleUnpaidExpense(
        { companyId, expenseId: id, settlementDate: utcDate('2026-09-20'), method: 'CASH', amount: '1', rateToUsd: '10', rateLocalPerUsd: '10', cashBankAccountId: cashId },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
    const ledger = await getUnpaidExpenseLedger(companyId);
    for (const row of ledger.reconciliation) if (row.agrees !== null) expect(row.agrees, row.control).toBe(true);

    // A cost booked afterwards — even dated months earlier — was not paid by
    // that voucher: the paid one stays Paid, the new one reads Unpaid.
    const later = await createExpense(
      {
        companyId, expenseDate: utcDate('2026-07-01'), expenseCategoryId: categoryId, currency: 'MAD', amount: '2500',
        rateToUsd: '10', rateLocalPerUsd: '10', kind: 'GENERAL', capitaliseToLandedCost: false, paymentMethod: 'CASH',
        description: 'Back-dated, booked after the JV',
      } as never,
      ctx.admin.id,
    );
    await postExpense({ id: later.id, companyId, userId: ctx.admin.id });
    expect((await statusOf(id)).status).toBe('PAID');
    expect((await statusOf(later.id)).status).toBe('UNPAID');
    expect(Number((await statusOf(later.id)).outstanding)).toBeCloseTo(2_500, 2);
    await settle(later.id, '2500');
    expect((await statusOf(later.id)).status).toBe('PAID');
  }, 300_000);

  it('Dr his commission payable / Cr Cash: the commission owed to the agent reads Paid', async () => {
    const id = await cost('4000', { owedToAgent: agentId }, 'Commission, paid by JV');
    expect((await statusOf(id)).status).toBe('UNPAID');
    await journal([
      { key: 'AGENT_COMMISSION_PAYABLE', side: 'DEBIT', amount: '4000', agentId },
      { cash: true, side: 'CREDIT', amount: '4000' },
    ]);
    expect((await statusOf(id)).status).toBe('PAID');
    const statement = await getAgentStatement({ companyId, agentId });
    expect(statement.events.find((e) => e.status && e.typeLabel && e.lines.some((l) => l.accountKey === 'AGENT_COMMISSION_PAYABLE' && l.creditLocal.greaterThan(0)))?.status).toBe('Settled');
  }, 300_000);
});

describe('the agent card and the agent ledger are one calculation', () => {
  it('with his collections account in credit and his loan account in debit, both sides stay positive and net to the ledger', async () => {
    const loan = await prisma.account.create({
      data: { companyId, code: '2390', name: 'Loan from Truth Agent', type: 'LIABILITY' } as never,
    });
    // He lends FID 27,468.50; FID repays 250,000 on that account; he hands over
    // 400,000 more than he ever collected. The client's own postings, as they were.
    await journal([
      { cash: true, side: 'DEBIT', amount: '27468.50' },
      { accountId: loan.id, side: 'CREDIT', amount: '27468.50', agentId },
    ]);
    await journal([
      { accountId: loan.id, side: 'DEBIT', amount: '250000', agentId },
      { cash: true, side: 'CREDIT', amount: '250000' },
    ]);
    await journal([
      { cash: true, side: 'DEBIT', amount: '400000' },
      { key: 'AGENT_CLEARING', side: 'CREDIT', amount: '400000', agentId },
    ]);

    const statement = await getAgentStatement({ companyId, agentId });
    const ledgerBalance = Number(statement.events.at(-1)!.runningNetLocal);
    const card = (await getOutstandingSummary(companyId)).agents.find((a) => a.agentId === agentId)!;

    expect(Number(card.owesFidLocal)).toBeGreaterThanOrEqual(0);
    expect(Number(card.fidOwesLocal)).toBeGreaterThanOrEqual(0);
    expect(Number(card.netLocal)).toBeCloseTo(ledgerBalance, 2);
    expect(Number(card.owesFidLocal) - Number(card.fidOwesLocal)).toBeCloseTo(ledgerBalance, 2);
    // Loan account in debit: he owes FID on it. Collections in credit: FID owes him.
    expect(card.parts.find((p) => p.key === 'loanFrom')!.direction).toBe('OWES_FID');
    expect(card.parts.find((p) => p.key === 'holding')!.direction).toBe('FID_OWES');
    // The ledger page's header is the same calculation.
    expect(Number(statement.relationship.owesFidLocal)).toBeCloseTo(Number(card.owesFidLocal), 2);
    expect(Number(statement.relationship.fidOwesLocal)).toBeCloseTo(Number(card.fidOwesLocal), 2);

    // Loans: this agent's loan account is never netted against another lender.
    const summary = await getOutstandingSummary(companyId);
    const party = summary.loanParties.find((p) => p.accountId === loan.id)!;
    expect(party.side).toBe('receivable');
    expect(Number(party.amountLocal)).toBeCloseTo(250_000 - 27_468.5, 2);
  }, 300_000);

  it('the consistency checks find nothing out of line', async () => {
    const result = await runConsistencyChecks(companyId);
    const failing = result.checks.filter((c) => !c.ok && c.severity === 'error');
    expect(failing.map((c) => `${c.label}: ${c.left.value} vs ${c.right.value}`)).toEqual([]);
  }, 300_000);
});
