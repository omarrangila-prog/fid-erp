import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { transaction } from '@/lib/db';
import { createExpense, postExpense } from '@/lib/services/expense';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyProfitSummary, getMonthlyProfitability } from '@/lib/services/profitability';
import {
  getProfitAndLoss,
  getExpenseReport,
  getExpenseSplit,
  getJournalExpenseReport,
  mergeExpenseRows,
} from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';

/**
 * The same figure on different pages.
 *
 * Morocco's live books showed it: costs entered as journal entries (fuel,
 * bank charges, a permit) were on the Profit and Loss but not on the Expense
 * Report, and the dashboard's Net Profit — built from expense vouchers only —
 * read MAD 90,531.84 more than the statement it links to. Here one voucher
 * and one journal-entry cost are posted, and every page must give the same
 * answer: the Expense Report holds both once, the dashboard's net profit is
 * the statement's, and the reconciliation monitor's report checks pass.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let fuelAccountId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  await createMasters(companyId, { currency: 'MAD' });
  const categoryId = (await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'GENERAL', status: 'ACTIVE' } })).id;
  const cashId = (await getCashAccount(companyId, 'MAD')).id;

  // A voucher: MAD 1,000 of general expense, paid in cash.
  const expense = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-09-01'), expenseCategoryId: categoryId, currency: 'MAD', amount: '1000',
      rateToUsd: '10', rateLocalPerUsd: '10', kind: 'GENERAL', capitaliseToLandedCost: false,
      paymentMethod: 'CASH', description: 'Voucher cost', cashBankAccountId: cashId,
    } as never,
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

  // A journal entry: MAD 350 of fuel, paid in cash, no voucher.
  const opex = await prisma.account.findFirstOrThrow({ where: { companyId, type: 'EXPENSE', reportGroup: 'OPERATING' }, select: { id: true } });
  fuelAccountId = opex.id;
  await transaction((tx) =>
    postJournalEntry(tx, {
      companyId, entryDate: utcDate('2026-09-02'), description: 'Fuel by journal', sourceType: 'MANUAL',
      sourceId: 'RECON-FUEL-1', createdById: ctx.admin.id, localCurrency: 'MAD', rateLocalPerUsd: '10',
      lines: [
        { accountId: fuelAccountId, direction: 'DEBIT', currency: 'MAD', amount: '350', rateToUsd: '10' },
        { cashBankAccountId: cashId, direction: 'CREDIT', currency: 'MAD', amount: '350', rateToUsd: '10' },
      ],
    } as never),
  );
}, 300_000);

const range = { from: utcDate('2026-01-01'), to: utcDate('2026-12-31') };

describe('one figure, every page', () => {
  it('the Expense Report holds the voucher and the journal-entry cost, each once', async () => {
    const vouchers = await getExpenseReport({ companyId, ...range, groupBy: 'type' });
    const journals = await getJournalExpenseReport({ companyId, ...range, groupBy: 'type' });
    const rows = mergeExpenseRows(vouchers, journals);
    const total = rows.reduce((t, r) => t + Number(r.amountLocal), 0);
    expect(total).toBeCloseTo(1350, 2);
    expect(journals.find((r) => r.key === 'JOURNAL')?.amountLocal.toNumber()).toBeCloseTo(350, 2);

    // The voucher's own journal is not counted again as a journal-entry cost.
    expect(journals.reduce((t, r) => t + r.count, 0)).toBe(1);

    const split = await getExpenseSplit({ companyId, ...range });
    expect(Number(split.journalLocal)).toBeCloseTo(350, 2);
    expect(Number(split.periodChargeLocal)).toBeCloseTo(1350, 2);
    const pnl = await getProfitAndLoss({ companyId, ...range });
    expect(Number(split.periodChargeLocal)).toBeCloseTo(Number(pnl.totals.operatingExpensesLocal), 2);
  }, 120_000);

  it('the dashboard net profit is the Profit and Loss net profit', async () => {
    const summary = await getCompanyProfitSummary({ companyId, ...range });
    const pnl = await getProfitAndLoss({ companyId, ...range });
    expect(Number(summary.netProfitLocal)).toBeCloseTo(Number(pnl.totals.netProfitLocal), 2);
    expect(Number(summary.netProfitUsd)).toBeCloseTo(Number(pnl.totals.netProfitUsd), 2);
    expect(Number(summary.netProfitLocal)).toBeCloseTo(-1350, 2);
  }, 120_000);

  it('the monthly profit counts the journal-entry cost too', async () => {
    const months = await getMonthlyProfitability({ companyId, months: 120 });
    const september = months.find((m) => m.month === '2026-09');
    expect(Number(september?.expensesUsd ?? 0)).toBeCloseTo(135, 2);
  }, 120_000);

  it('the reconciliation monitor passes every report check', async () => {
    const result = await reconcile(companyId);
    const reports = result.checks.filter((c) => c.group === 'Reports');
    expect(reports.map((c) => c.id)).toEqual(
      expect.arrayContaining(['dashboard-net-profit', 'expense-report-ledger']),
    );
    expect(reports.filter((c) => !c.passed)).toEqual([]);
  }, 300_000);
});
