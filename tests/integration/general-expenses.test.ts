import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { quickCreateExpenseCategory } from '@/lib/services/expense-category';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createPayment, postPayment } from '@/lib/services/payment';
import { getExpenseSettlements } from '@/lib/services/expense-settlement';
import { getOrderCostSheets } from '@/lib/services/order-cost';
import { getProfitAndLoss } from '@/lib/services/reports';
import { getCashBankBalance } from '@/lib/services/accounting';
import { reconcile } from '@/lib/services/reconciliation';
import { transaction } from '@/lib/db';

/**
 * General company expenses, the five cases the client checks before daily
 * entry: fuel paid in cash, rent paid from the bank, a category added from
 * the form, a bill left unpaid, and that bill paid later.
 *
 * A general expense is a cost of the company, not of a shipment: it reaches
 * the profit and loss under its own name and never a shipment's costing.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let cashId: string;
let bankId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '10', effectiveDate: utcDate('2026-01-01') } });
  bankId = (await getCashAccount(companyId, 'MAD')).id;
  cashId = (
    (await prisma.cashBankAccount.findFirst({ where: { companyId, currency: 'MAD', accountType: 'CASH' } })) ??
    (await getCashAccount(companyId, 'MAD'))
  ).id;
}, 300_000);

const balance = (id: string) => transaction((tx) => getCashBankBalance(tx, companyId, id)).then(Number);

async function general(categoryId: string, amount: string, paidFrom: string | null, memo: string) {
  const expense = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-09-10'), expenseCategoryId: categoryId, currency: 'MAD', amount,
      rateToUsd: '10', rateLocalPerUsd: '10', kind: 'GENERAL', capitaliseToLandedCost: false,
      paymentMethod: 'CASH', description: memo, ...(paidFrom ? { cashBankAccountId: paidFrom } : {}),
    } as never,
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
  return expense.id;
}

async function ledgerFor(categoryId: string) {
  const category = await prisma.expenseCategory.findUniqueOrThrow({ where: { id: categoryId }, include: { glAccount: true } });
  return category.glAccount;
}

async function pnlLine(accountId: string) {
  const pnl = await getProfitAndLoss({ companyId, from: utcDate('2026-09-01'), to: utcDate('2026-09-30') });
  return pnl.operatingExpenses.find((l) => l.accountId === accountId);
}

describe('C — a category added from the form has a ledger of its own', () => {
  // The built-in categories (Office Rent, Travel, …) already have ledgers of
  // their own. These are the ones a user adds from the form.
  it('creates Vehicle Fuel with a Vehicle Fuel Expense account in operating expenses', async () => {
    const fuel = await quickCreateExpenseCategory({ companyId, userId: ctx.admin.id, name: 'Vehicle Fuel', kind: 'GENERAL' });
    const ledger = await ledgerFor(fuel.id);
    expect(ledger?.name).toBe('Vehicle Fuel Expense');
    expect(ledger?.type).toBe('EXPENSE');
    expect(ledger?.reportGroup).toBe('OPERATING');
  }, 300_000);

  it('reuses an expense account that already carries the name', async () => {
    const existing = await prisma.account.create({
      data: { companyId, code: '6990', name: 'Parking Expense', type: 'EXPENSE', reportGroup: 'OPERATING' },
    });
    const before = await prisma.account.count({ where: { companyId } });
    const parking = await quickCreateExpenseCategory({ companyId, userId: ctx.admin.id, name: 'Parking', kind: 'GENERAL' });
    expect(await prisma.account.count({ where: { companyId } })).toBe(before);
    expect((await ledgerFor(parking.id))?.id).toBe(existing.id);
  }, 300_000);
});

describe('A — MAD 2,000 fuel paid in cash', () => {
  it('Dr Fuel Expense, Cr cash; the P&L shows it; no shipment is touched', async () => {
    const fuel = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, name: 'Vehicle Fuel' } });
    const cashBefore = await balance(cashId);
    const shipmentsBefore = JSON.stringify((await getOrderCostSheets(companyId)).map((s) => s.landedUsd.toString()));

    const id = await general(fuel.id, '2000', cashId, 'Fuel for the delivery van');

    expect(await balance(cashId)).toBeCloseTo(cashBefore - 2_000, 2);
    const ledger = (await ledgerFor(fuel.id))!;
    const line = await pnlLine(ledger.id);
    expect(Number(line?.amountLocal)).toBeCloseTo(2_000, 2);
    expect(JSON.stringify((await getOrderCostSheets(companyId)).map((s) => s.landedUsd.toString()))).toBe(shipmentsBefore);

    const expense = await prisma.expense.findUniqueOrThrow({ where: { id }, include: { cashBankAccount: true, vendor: true } });
    expect((await getExpenseSettlements(companyId, [expense])).get(id)?.status).toBe('PAID');
  }, 300_000);
});

describe('B — MAD 10,000 office rent paid from the bank', () => {
  it('Dr Office Rent Expense, Cr the bank', async () => {
    const rent = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, name: 'Office Rent' } });
    const bankBefore = await balance(bankId);
    await general(rent.id, '10000', bankId, 'September office rent');
    expect(await balance(bankId)).toBeCloseTo(bankBefore - 10_000, 2);
    const line = await pnlLine((await ledgerFor(rent.id))!.id);
    expect(Number(line?.amountLocal)).toBeCloseTo(10_000, 2);
  }, 300_000);
});

describe('D and E — MAD 5,000 unpaid, then paid', () => {
  let billId: string;
  let ledgerId: string;

  it('D: is a cost now, and no cash has moved', async () => {
    const phone = await quickCreateExpenseCategory({ companyId, userId: ctx.admin.id, name: 'Telephone', kind: 'GENERAL' });
    ledgerId = (await ledgerFor(phone.id))!.id;
    const bankBefore = await balance(bankId);
    billId = await general(phone.id, '5000', null, 'Telephone and internet, September');
    expect(await balance(bankId)).toBeCloseTo(bankBefore, 2);
    expect(Number((await pnlLine(ledgerId))?.amountLocal)).toBeCloseTo(5_000, 2);
    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: billId }, include: { cashBankAccount: true, vendor: true } });
    expect((await getExpenseSettlements(companyId, [expense])).get(billId)?.status).toBe('UNPAID');
  }, 300_000);

  it('E: paying it moves the bank, and the expense is still MAD 5,000, not 10,000', async () => {
    const bankBefore = await balance(bankId);
    const payment = await createPayment(
      {
        companyId, paymentDate: utcDate('2026-09-20'), vendorId: null, currency: 'MAD', amount: '5000',
        rateToUsd: '10', rateLocalPerUsd: '10', paymentMethod: 'BANK_TRANSFER', cashBankAccountId: bankId,
        allocations: [{ expenseId: billId, amount: '5000' }],
      } as never,
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });

    expect(await balance(bankId)).toBeCloseTo(bankBefore - 5_000, 2);
    expect(Number((await pnlLine(ledgerId))?.amountLocal)).toBeCloseTo(5_000, 2);
    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: billId }, include: { cashBankAccount: true, vendor: true } });
    expect((await getExpenseSettlements(companyId, [expense])).get(billId)?.status).toBe('PAID');
  }, 300_000);

  it('leaves the books whole', async () => {
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
  }, 300_000);
});
