import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { transaction } from '@/lib/db';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getExpenseSettlements } from '@/lib/services/expense-settlement';
import { getSetOffSources, getUnpaidExpenseLedger, settleUnpaidExpense } from '@/lib/services/unpaid-expenses';
import { getOutstandingSummary } from '@/lib/services/outstanding';
import { getCashBankBalance, postJournalEntry } from '@/lib/services/accounting';
import { getAgentStatement } from '@/lib/services/agent-statement';
import { runConsistencyChecks } from '@/lib/services/consistency';
import { getBalanceSheet, getFinancialPosition, getTrialBalanceReport } from '@/lib/services/reports';

/**
 * The P0 reconciliation, on the client's own figures.
 *
 * Radouan's account is rebuilt exactly as the live books hold it: a loan of
 * 27,468.50 booked to his loan account, two more loans (490 and 400,000)
 * booked to his collections account, 373,721.20 collected from customers,
 * 46,000 handed over, and 250,000 paid to him on his loan account. His net is
 * 149,762.70 owed to FID, though his collections read −72,768.80 and his loan
 * account is in debit. Then the unpaid commission of MAD 31,190.40 is settled
 * every way the brief names — set-off in full and in part, cash, bank — and a
 * reclassification is shown not to be a payment.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let categoryId: string;
let cashId: string;
let bankId: string;
let agentId: string;
let loanId: string;

let jv = 0;
type Line = { key?: string; accountId?: string; cashBankAccountId?: string; side: 'DEBIT' | 'CREDIT'; amount: string; agentId?: string };
async function journal(lines: Line[], date = '2026-09-01') {
  jv += 1;
  await transaction((tx) =>
    postJournalEntry(tx, {
      companyId, entryDate: utcDate(date), description: `P0 JV ${jv}`, sourceType: 'MANUAL',
      sourceId: `P0-JV-${jv}`, createdById: ctx.admin.id, localCurrency: 'MAD', rateLocalPerUsd: '9.6',
      lines: lines.map((l) => ({
        ...(l.cashBankAccountId ? { cashBankAccountId: l.cashBankAccountId } : l.key ? { accountKey: l.key } : { accountId: l.accountId }),
        direction: l.side, currency: 'MAD', amount: l.amount, rateToUsd: '9.6', agentId: l.agentId,
      })),
    } as never),
  );
}

async function commission(amount = '31190.40', memo = 'COMMISSION FOR 1ST SHIPMENT MSC 2 CONTAINERS') {
  const expense = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-08-12'), expenseCategoryId: categoryId, currency: 'MAD', amount,
      rateToUsd: '9.6', rateLocalPerUsd: '9.6', kind: 'GENERAL', capitaliseToLandedCost: false,
      paymentMethod: 'CASH', description: memo,
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

async function glLocal(where: { systemKey?: string; id?: string }) {
  const [row] = await prisma.$queryRawUnsafe<Array<{ b: string | null }>>(
    `SELECT SUM(jl."debitLocal" - jl."creditLocal")::text b FROM journal_lines jl
       JOIN journal_entries je ON je."id" = jl."journalEntryId" JOIN accounts a ON a."id" = jl."accountId"
      WHERE je."companyId" = $1 AND je."status" = 'POSTED' AND je."isReversal" = false
        AND NOT EXISTS (SELECT 1 FROM journal_entries rv WHERE rv."reversalOfId" = je."id")
        AND ${where.systemKey ? `a."systemKey" = $2` : `a."id" = $2`}`,
    companyId,
    where.systemKey ?? where.id,
  );
  return Number(row?.b ?? 0);
}
const agentNet = async () => Number((await getAgentStatement({ companyId, agentId })).events.at(-1)?.runningNetLocal ?? 0);
const cash = async () => Number(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)));
const bank = async () => Number(await transaction((tx) => getCashBankBalance(tx, companyId, bankId)));

async function settle(expenseId: string, method: 'CASH' | 'BANK' | 'SET_OFF', amount: string) {
  await settleUnpaidExpense(
    {
      companyId, expenseId, settlementDate: utcDate('2026-09-28'), method, amount, rateToUsd: '9.6', rateLocalPerUsd: '9.6',
      cashBankAccountId: method === 'CASH' ? cashId : method === 'BANK' ? bankId : null,
      setOffAgainst: method === 'SET_OFF' ? `agent:${agentId}` : null,
    },
    ctx.admin.id,
  );
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  await createMasters(companyId, { currency: 'MAD' });
  categoryId = (await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'GENERAL', status: 'ACTIVE' } })).id;
  bankId = (await getCashAccount(companyId, 'MAD')).id;
  cashId = (await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'MAD', accountType: 'CASH' } })).id;
  agentId = (await prisma.agent.create({ data: { companyId, agentCode: 'AG-RADOUAN', agentName: 'RADOUAN MOHAMMED' } })).id;
  loanId = (await prisma.account.create({ data: { companyId, code: '2401', name: 'Loan from RADOUAN MOHAMMED', type: 'LIABILITY', agentId } as never })).id;

  // His account, as the live books hold it.
  await journal([{ cashBankAccountId: cashId, side: 'DEBIT', amount: '27468.50' }, { accountId: loanId, side: 'CREDIT', amount: '27468.50', agentId }], '2026-08-12');
  await journal([{ cashBankAccountId: cashId, side: 'DEBIT', amount: '490' }, { key: 'AGENT_CLEARING', side: 'CREDIT', amount: '490', agentId }], '2026-08-28');
  await journal([{ cashBankAccountId: bankId, side: 'DEBIT', amount: '400000' }, { key: 'AGENT_CLEARING', side: 'CREDIT', amount: '400000', agentId }], '2026-08-28');
  await journal([{ key: 'AGENT_CLEARING', side: 'DEBIT', amount: '373721.20', agentId }, { key: 'SALES_REVENUE', side: 'CREDIT', amount: '373721.20' }], '2026-09-08');
  await journal([{ accountId: loanId, side: 'DEBIT', amount: '250000', agentId }, { cashBankAccountId: cashId, side: 'CREDIT', amount: '250000' }], '2026-09-22');
  await journal([{ cashBankAccountId: cashId, side: 'DEBIT', amount: '46000' }, { key: 'AGENT_CLEARING', side: 'CREDIT', amount: '46000', agentId }], '2026-09-23');
}, 300_000);

describe('Radouan, as the live books hold him', () => {
  it('nets to MAD 149,762.70 owed to FID, with collections −72,768.80 and his loan account 222,531.50 in debit', async () => {
    expect(await agentNet()).toBeCloseTo(149_762.7, 2);
    const card = (await getOutstandingSummary(companyId)).agents.find((a) => a.agentId === agentId)!;
    expect(Number(card.netLocal)).toBeCloseTo(149_762.7, 2);
    expect(Number(card.parts.find((p) => p.key === 'holding')!.balanceLocal)).toBeCloseTo(-72_768.8, 2);
    expect(Number(card.parts.find((p) => p.key === 'loanFrom')!.balanceLocal)).toBeCloseTo(222_531.5, 2);
  });

  it('his loan account is shown once — in his card, not again under loans receivable', async () => {
    const summary = await getOutstandingSummary(companyId);
    expect(summary.loanParties.find((p) => p.accountId === loanId)).toBeUndefined();
    expect(Number(summary.loansReceivable.local)).toBe(0);
  });

  it('can be set off against: what he owes FID across his accounts, not only the collections in his hands', async () => {
    const source = (await getSetOffSources(companyId, 'MAD')).find((s) => s.value === `agent:${agentId}`);
    expect(source).toBeTruthy();
    expect(Number(source!.available)).toBeCloseTo(149_762.7, 2);
  });
});

describe('the unpaid commission of MAD 31,190.40', () => {
  it('when booked: the cost and the liability go up; cash and bank do not move', async () => {
    const [c0, b0, acc0] = [await cash(), await bank(), await glLocal({ systemKey: 'ACCRUED_EXPENSES' })];
    const id = await commission();
    expect(await cash()).toBeCloseTo(c0, 2);
    expect(await bank()).toBeCloseTo(b0, 2);
    expect(await glLocal({ systemKey: 'ACCRUED_EXPENSES' })).toBeCloseTo(acc0 - 31_190.4, 2);
    expect((await statusOf(id)).status).toBe('UNPAID');
  });

  it('full set-off against Radouan: settled, accrued down to nothing, his net 149,762.70 → 118,572.30, no cash or bank, cost unchanged', async () => {
    const id = await commission();
    const cost = (await prisma.expenseCategory.findUniqueOrThrow({ where: { id: categoryId }, select: { glAccountId: true } })).glAccountId;
    const [c0, b0, acc0, net0, cost0] = [await cash(), await bank(), await glLocal({ systemKey: 'ACCRUED_EXPENSES' }), await agentNet(), cost ? await glLocal({ id: cost }) : 0];
    await settle(id, 'SET_OFF', '31190.40');
    const s = await statusOf(id);
    expect(s.status).toBe('PAID');
    expect(Number(s.outstanding)).toBe(0);
    expect(await glLocal({ systemKey: 'ACCRUED_EXPENSES' })).toBeCloseTo(acc0 + 31_190.4, 2);
    expect(await agentNet()).toBeCloseTo(net0 - 31_190.4, 2);
    expect(net0 - 31_190.4).toBeCloseTo(118_572.3, 2);
    expect(await cash()).toBeCloseTo(c0, 2);
    expect(await bank()).toBeCloseTo(b0, 2);
    if (cost) expect(await glLocal({ id: cost })).toBeCloseTo(cost0, 2);
    // Once on his ledger — one event, one effect.
    const events = (await getAgentStatement({ companyId, agentId })).events.filter((e) => e.lines.some((l) => l.accountKey === 'AGENT_CLEARING' && Number(l.creditLocal) === 31_190.4));
    expect(events).toHaveLength(1);
  });

  it('partial set-off: 20,000 of 31,190.40 — Partially Settled, 11,190.40 outstanding, his net down by 20,000 only', async () => {
    const id = await commission();
    const net0 = await agentNet();
    await settle(id, 'SET_OFF', '20000');
    const s = await statusOf(id);
    expect(s.status).toBe('PARTIAL');
    expect(Number(s.outstanding)).toBeCloseTo(11_190.4, 2);
    expect(await agentNet()).toBeCloseTo(net0 - 20_000, 2);
    const row = (await getUnpaidExpenseLedger(companyId)).rows.find((r) => r.expenseId === id)!;
    expect(row.status).toBe('PARTIAL');
    expect(Number(row.outstandingLocal)).toBeCloseTo(11_190.4, 2);
  });

  it('cash settlement: liability and cash down by the same amount; the cost is not booked again', async () => {
    const id = await commission();
    const [c0, acc0] = [await cash(), await glLocal({ systemKey: 'ACCRUED_EXPENSES' })];
    await settle(id, 'CASH', '31190.40');
    expect((await statusOf(id)).status).toBe('PAID');
    expect(await cash()).toBeCloseTo(c0 - 31_190.4, 2);
    expect(await glLocal({ systemKey: 'ACCRUED_EXPENSES' })).toBeCloseTo(acc0 + 31_190.4, 2);
  });

  it('bank settlement: the same, through the bank', async () => {
    const id = await commission();
    const [b0, acc0] = [await bank(), await glLocal({ systemKey: 'ACCRUED_EXPENSES' })];
    await settle(id, 'BANK', '31190.40');
    expect((await statusOf(id)).status).toBe('PAID');
    expect(await bank()).toBeCloseTo(b0 - 31_190.4, 2);
    expect(await glLocal({ systemKey: 'ACCRUED_EXPENSES' })).toBeCloseTo(acc0 + 31_190.4, 2);
  });
});

/** Every cost owed to nobody in particular, with what settled or moved it — the costs a voucher that names no cost applies to, oldest first. */
async function openGeneralCosts() {
  const costs = await prisma.expense.findMany({
    where: { companyId, status: 'POSTED', cashBankAccountId: null, ledgerAccountId: null, ledgerAgentId: null, vendorId: null, payableToAgentId: null },
    include: { cashBankAccount: { select: { name: true } }, vendor: { select: { country: true } } },
  });
  const settled = await getExpenseSettlements(companyId, costs);
  const all = [...settled.entries()].map(([id, s]) => ({ id, ...s }));
  const total = (pick: (s: (typeof all)[number]) => number) => all.reduce((t, s) => t + pick(s), 0);
  return {
    all,
    paid: all.filter((s) => s.status === 'PAID').length,
    outstandingLocal: total((s) => Number(s.outstandingLocal)),
    transferredLocal: total((s) => Number(s.transferredLocal)),
    journalLocal: total((s) => Number(s.journalLocal)),
  };
}

describe('reclassification is not payment; set-off by journal is', () => {
  it('Dr Accrued Expenses / Cr his commission due: the debt moved to him — nothing reads Paid, nothing less is owed, the move is shown, the ledger reconciles', async () => {
    const id = await commission('5000', 'Reclassified commission');
    const before = await openGeneralCosts();
    await journal([{ key: 'ACCRUED_EXPENSES', side: 'DEBIT', amount: '5000' }, { key: 'AGENT_COMMISSION_PAYABLE', side: 'CREDIT', amount: '5000', agentId }], '2026-09-28');
    const after = await openGeneralCosts();
    expect(after.paid).toBe(before.paid);
    expect(after.outstandingLocal).toBeCloseTo(before.outstandingLocal, 2);
    expect(after.transferredLocal - before.transferredLocal).toBeCloseTo(5_000, 2);
    expect(after.journalLocal).toBeCloseTo(before.journalLocal, 2);
    expect((await statusOf(id)).status).toBe('UNPAID');
    const moved = after.all.find((s) => Number(s.transferredLocal) > 0)!;
    expect(moved.transferredTo.join(' ')).toMatch(/Commission/i);
    expect(moved.transferredToKeys).toEqual(['AGENT_COMMISSION_PAYABLE']);
    const ledger = await getUnpaidExpenseLedger(companyId);
    for (const row of ledger.reconciliation) if (row.agrees !== null) expect(row.agrees, row.control).toBe(true);
    // The moved part is settled where it now sits, not here a second time.
    await expect(settle(moved.id, 'CASH', moved.outstanding.toFixed(2))).rejects.toThrow(/moved to/);
  });

  it('Dr Accrued Expenses / Cr his collections: a genuine set-off — 7,000 more is settled, 7,000 less owed, nothing moved', async () => {
    const before = await openGeneralCosts();
    await journal([{ key: 'ACCRUED_EXPENSES', side: 'DEBIT', amount: '7000' }, { key: 'AGENT_CLEARING', side: 'CREDIT', amount: '7000', agentId }], '2026-09-29');
    const after = await openGeneralCosts();
    expect(after.journalLocal - before.journalLocal).toBeCloseTo(7_000, 2);
    expect(before.outstandingLocal - after.outstandingLocal).toBeCloseTo(7_000, 2);
    expect(after.transferredLocal).toBeCloseTo(before.transferredLocal, 2);
  });
});

describe('the statements, in the currency the books are kept in', () => {
  it('balance in MAD and in USD, and each MAD drawer reads the same on Cash & Bank and on the Balance Sheet', async () => {
    const [sheet, trial, position] = await Promise.all([
      getBalanceSheet({ companyId, asOf: utcDate('2026-12-31') }),
      getTrialBalanceReport({ companyId }),
      getFinancialPosition({ companyId }),
    ]);
    expect(sheet.balancesLocal).toBe(true);
    expect(sheet.balancesUsd).toBe(true);
    expect(trial.isBalancedLocal).toBe(true);
    expect(trial.isBalanced).toBe(true);
    for (const account of position.accounts.filter((a) => a.currency === 'MAD' && !a.balance.isZero())) {
      const line = sheet.assets.lines.find((l) => l.accountId === account.glAccountId)!;
      expect(Number(line.amountLocal), account.name).toBeCloseTo(Number(account.balance), 2);
    }
  });

  it('the consistency checks find nothing out of line', async () => {
    const result = await runConsistencyChecks(companyId);
    const failing = result.checks.filter((c) => !c.ok && c.severity === 'error');
    expect(failing.map((c) => `${c.label}: ${c.left.value} vs ${c.right.value}`)).toEqual([]);
    expect(result.checks.some((c) => c.area === 'Statements')).toBe(true);
  });
});
