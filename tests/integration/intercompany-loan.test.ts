import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, getCashAccount, utcDate } from '../helpers';
import { transaction } from '@/lib/db';
import { postIntercompanyLoan } from '@/lib/services/cash-transfer';
import { postAccountOpeningBalance } from '@/lib/services/chart-of-accounts';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getCashBankBalance } from '@/lib/services/accounting';
import { reconcile } from '@/lib/services/reconciliation';
import { getProfitAndLoss } from '@/lib/services/reports';
import { dec, toMoney } from '@/lib/money';

/**
 * Dubai lends to Morocco, and Morocco spends it.
 *
 * The whole trail the client asked for, in one test: dollars leave a Dubai
 * bank, dirhams land in a Moroccan one, Dubai is owed and Morocco owes, and
 * the costs Morocco then pays come out of that Moroccan bank. The principal
 * is a debt on both sides and touches neither company's profit and loss —
 * lending money is not a cost and receiving it is not income.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let dubaiBank: string;
let moroccoBank: string;

/** A GL balance in USD for one company, straight from the posted journal. */
async function control(companyId: string, systemKey: string) {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return toMoney(rows[0]?.bal ?? 0);
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();

  for (const company of [ctx.dubai, ctx.morocco]) {
    await prisma.exchangeRate.create({
      data: { companyId: company.id, quoteCurrency: 'MAD', rate: '10', effectiveDate: utcDate('2026-01-01') },
    });
  }

  const dubai = await getCashAccount(ctx.dubai.id, 'USD');
  const morocco = await getCashAccount(ctx.morocco.id, 'MAD');
  dubaiBank = dubai.id;
  moroccoBank = morocco.id;

  // Dubai has money to lend.
  await postAccountOpeningBalance({
    accountId: dubai.glAccountId,
    companyId: ctx.dubai.id,
    userId: ctx.admin.id,
    amount: '100000',
    asOf: utcDate('2026-01-01'),
    currency: 'USD',
    rateToUsd: '1',
    rateLocalPerUsd: '3.6725',
  });
}, 240_000);

describe('Dubai lends USD and Morocco receives MAD', () => {
  it('moves each bank by what really moved, at the rate entered', async () => {
    const dubaiBefore = await transaction((tx) => getCashBankBalance(tx, ctx.dubai.id, dubaiBank));

    // USD 50,000 at 10 MAD to the dollar → MAD 500,000.
    const loan = await postIntercompanyLoan({
      fromCompanyId: ctx.dubai.id,
      toCompanyId: ctx.morocco.id,
      userId: ctx.admin.id,
      transferDate: utcDate('2026-02-01'),
      fromAccountId: dubaiBank,
      toAccountId: moroccoBank,
      amount: '50000',
      exchangeRate: '10',
      reference: 'LOAN-2026-01',
    });

    expect(loan.received.toString()).toBe('500000');

    const dubaiAfter = await transaction((tx) => getCashBankBalance(tx, ctx.dubai.id, dubaiBank));
    const moroccoAfter = await transaction((tx) => getCashBankBalance(tx, ctx.morocco.id, moroccoBank));
    expect(toMoney(dec(dubaiBefore).minus(dubaiAfter)).toString()).toBe('50000');
    expect(toMoney(moroccoAfter).toString()).toBe('500000');
  }, 240_000);

  it('leaves Dubai owed and Morocco owing, for the same money', async () => {
    const owedToDubai = await control(ctx.dubai.id, 'INTERCOMPANY_LOAN_RECEIVABLE');
    const owedByMorocco = await control(ctx.morocco.id, 'INTERCOMPANY_LOAN_PAYABLE');
    expect(Number(owedToDubai)).toBeCloseTo(50000, 2);
    // A liability sits credit-side, so the same debt reads negative here.
    expect(Number(owedByMorocco)).toBeCloseTo(-50000, 2);
  }, 120_000);

  it('does not touch either company’s profit and loss', async () => {
    for (const company of [ctx.dubai, ctx.morocco]) {
      const pl = await getProfitAndLoss({
        companyId: company.id,
        from: utcDate('2026-01-01'),
        to: utcDate('2026-12-31'),
      });
      // Lending money is not a cost and receiving it is not revenue, so the
      // principal must leave the whole statement untouched.
      expect(Number(pl.totals.revenueUsd), `${company.code} revenue`).toBe(0);
      expect(Number(pl.totals.netProfitUsd), `${company.code} net profit`).toBe(0);
    }
  }, 180_000);

  it('keeps each company’s entry out of the other’s books', async () => {
    const strays = await prisma.journalEntry.count({
      where: { companyId: ctx.dubai.id, description: { contains: 'Loan from' } },
    });
    expect(strays).toBe(0);
  }, 120_000);
});

describe('Morocco spends what it borrowed', () => {
  it('takes the expense out of the Moroccan bank and leaves the rest', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, kind: 'GENERAL', status: 'ACTIVE' },
    });
    const expense = await createExpense(
      {
        companyId: ctx.morocco.id,
        expenseDate: utcDate('2026-02-10'),
        expenseCategoryId: category.id,
        currency: 'MAD',
        amount: '20000',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: moroccoBank,
        kind: 'GENERAL',
        description: 'Paid from the borrowed money',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    // 500,000 borrowed, 20,000 spent, 480,000 left — the client's own sum.
    const balance = await transaction((tx) => getCashBankBalance(tx, ctx.morocco.id, moroccoBank));
    expect(toMoney(balance).toString()).toBe('480000');

    // The debt is untouched by spending: it is still the whole 50,000.
    const owed = await control(ctx.morocco.id, 'INTERCOMPANY_LOAN_PAYABLE');
    expect(Number(owed)).toBeCloseTo(-50000, 2);
  }, 240_000);

  it('leaves both sets of books reconciling', async () => {
    for (const company of [ctx.dubai, ctx.morocco]) {
      const health = await reconcile(company.id);
      expect(
        health.checks.filter((c) => !c.passed).map((c) => c.label),
        `${company.code}`,
      ).toEqual([]);
    }
  }, 300_000);
});

describe('what a loan will not do', () => {
  it('refuses an account that belongs to the other company', async () => {
    await expect(
      postIntercompanyLoan({
        fromCompanyId: ctx.dubai.id,
        toCompanyId: ctx.morocco.id,
        userId: ctx.admin.id,
        transferDate: utcDate('2026-03-01'),
        fromAccountId: moroccoBank,
        toAccountId: moroccoBank,
        amount: '100',
        exchangeRate: '10',
      }),
    ).rejects.toThrow(/Lending account/i);
  }, 120_000);

  it('refuses a company lending to itself', async () => {
    await expect(
      postIntercompanyLoan({
        fromCompanyId: ctx.morocco.id,
        toCompanyId: ctx.morocco.id,
        userId: ctx.admin.id,
        transferDate: utcDate('2026-03-02'),
        fromAccountId: moroccoBank,
        toAccountId: moroccoBank,
        amount: '100',
        exchangeRate: '1',
      }),
    ).rejects.toThrow(/cannot lend to itself/i);
  }, 120_000);

  it('refuses a missing exchange rate', async () => {
    await expect(
      postIntercompanyLoan({
        fromCompanyId: ctx.dubai.id,
        toCompanyId: ctx.morocco.id,
        userId: ctx.admin.id,
        transferDate: utcDate('2026-03-03'),
        fromAccountId: dubaiBank,
        toAccountId: moroccoBank,
        amount: '100',
        exchangeRate: '0',
      }),
    ).rejects.toThrow(/exchange rate/i);
  }, 120_000);
});
