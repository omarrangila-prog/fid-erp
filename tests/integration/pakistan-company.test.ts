import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, utcDate } from '../helpers';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getTrialBalanceReport, getProfitAndLoss } from '@/lib/services/reports';

/**
 * FID Pakistan keeps its books in rupees and trades in rupees and dollars.
 * The company is provisioned like the others — chart, cash and bank accounts
 * in both currencies, warehouse, ports, tax codes switched off — and a rupee
 * cost and a dollar cost each land in the books at their own rate.
 */
let companyId: string;
let adminId: string;

beforeAll(async () => {
  await resetDatabase();
  companyId = (await prisma.company.findUniqueOrThrow({ where: { code: 'FID-PK' } })).id;
  adminId = (await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true } })).id;
}, 300_000);

describe('FID Pakistan', () => {
  it('is set up with rupee and dollar cash and bank accounts, a warehouse and no tax charged', async () => {
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    expect(company).toMatchObject({ localCurrency: 'PKR', baseCurrency: 'USD', docPrefix: 'FID-PK', taxEnabled: false, timezone: 'Asia/Karachi' });
    const cash = await prisma.cashBankAccount.findMany({ where: { companyId }, select: { currency: true, accountType: true } });
    expect(cash.map((c) => `${c.accountType}:${c.currency}`).sort()).toEqual(['BANK:PKR', 'BANK:USD', 'CASH:PKR', 'CASH:USD']);
    expect(await prisma.warehouse.count({ where: { companyId } })).toBe(1);
    expect(await prisma.port.count({ where: { companyId, country: 'Pakistan' } })).toBe(2);
    expect(await prisma.account.count({ where: { companyId } })).toBeGreaterThan(20);
  });

  it('books a rupee cost and a dollar cost, each in rupees at its own rate, and balances', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'GENERAL' } });
    const cashPkr = await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'PKR', accountType: 'CASH' } });
    const bankUsd = await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'USD', accountType: 'BANK' } });
    for (const [currency, amount, cashBankAccountId] of [['PKR', '28000', cashPkr.id], ['USD', '100', bankUsd.id]] as const) {
      const e = await createExpense(
        { companyId, expenseDate: utcDate('2026-11-01'), expenseCategoryId: category.id, currency, amount, rateToUsd: currency === 'USD' ? '1' : '280', rateLocalPerUsd: '280', cashBankAccountId, description: `${currency} cost` },
        adminId,
      );
      await postExpense({ id: e.id, companyId, userId: adminId });
    }
    const pnl = await getProfitAndLoss({ companyId, from: utcDate('2026-01-01'), to: utcDate('2026-12-31') });
    // PKR 28,000 + USD 100 at 280 = PKR 56,000 of costs.
    expect(Number(pnl.totals.netProfitLocal)).toBeCloseTo(-56000, 2);
    const tb = await getTrialBalanceReport({ companyId, to: utcDate('2026-12-31') });
    expect(tb.totals.debitLocal.toFixed(2)).toBe(tb.totals.creditLocal.toFixed(2));
    // Nothing from Pakistan reaches the other companies' books.
    const other = await prisma.journalEntry.count({ where: { companyId: { not: companyId }, description: { contains: 'cost' }, createdAt: { gte: utcDate('2026-01-01') } } });
    expect(other).toBe(0);
  }, 120_000);
});
