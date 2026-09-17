import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, getCashAccount, utcDate } from '../helpers';
import { transaction } from '@/lib/db';
import { postCashBankTransfer } from '@/lib/services/cash-transfer';
import { postAccountOpeningBalance } from '@/lib/services/chart-of-accounts';
import { getCashBankBalance } from '@/lib/services/accounting';
import { reconcile } from '@/lib/services/reconciliation';
import { dec, toMoney } from '@/lib/money';

/**
 * Moving money between the company's own accounts.
 *
 * Within one currency nothing is converted and nothing is earned. Between two,
 * the bank decides what arrives, so both sides are stated — what left and what
 * landed — and the difference against the book rate is a realised exchange
 * gain or loss rather than money that quietly vanishes.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;

async function control(systemKey: string) {
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
  companyId = ctx.morocco.id;
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.85', effectiveDate: utcDate('2026-01-01') },
  });

  // Put real money in the USD account so there is something to move.
  const usd = await getCashAccount(companyId, 'USD');
  await postAccountOpeningBalance({
    accountId: usd.glAccountId,
    companyId,
    userId: ctx.admin.id,
    amount: '5000',
    asOf: utcDate('2026-01-01'),
    currency: 'USD',
    rateToUsd: '1',
    rateLocalPerUsd: '9.85',
  });
}, 180_000);

describe('a transfer within one currency', () => {
  it('moves the amount across untouched and earns nothing', async () => {
    const from = await getCashAccount(companyId, 'USD');
    const to = await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId, currency: 'USD', id: { not: from.id } },
    });
    const fxBefore = await control('FX_GAIN_LOSS');

    await postCashBankTransfer({
      companyId,
      userId: ctx.admin.id,
      transferDate: utcDate('2026-02-01'),
      fromAccountId: from.id,
      toAccountId: to.id,
      amount: '500',
    });

    const fromAfter = await transaction((tx) => getCashBankBalance(tx, companyId, from.id));
    const toAfter = await transaction((tx) => getCashBankBalance(tx, companyId, to.id));
    expect(toMoney(dec(4500)).toString()).toBe(toMoney(fromAfter).toString());
    expect(toMoney(toAfter).toString()).toBe('500');
    expect((await control('FX_GAIN_LOSS')).toString()).toBe(fxBefore.toString());
  }, 180_000);
});

describe('a transfer that converts USD into MAD', () => {
  it('moves each account by what really moved through it', async () => {
    const usd = await getCashAccount(companyId, 'USD');
    const mad = await getCashAccount(companyId, 'MAD');
    const usdBefore = await transaction((tx) => getCashBankBalance(tx, companyId, usd.id));
    const madBefore = await transaction((tx) => getCashBankBalance(tx, companyId, mad.id));

    // USD 1,000 left; the bank credited MAD 9,800, not the book rate's 9,850.
    await postCashBankTransfer({
      companyId,
      userId: ctx.admin.id,
      transferDate: utcDate('2026-02-05'),
      fromAccountId: usd.id,
      toAccountId: mad.id,
      amount: '1000',
      receivedAmount: '9800',
      reference: 'FX-1',
    });

    const usdAfter = await transaction((tx) => getCashBankBalance(tx, companyId, usd.id));
    const madAfter = await transaction((tx) => getCashBankBalance(tx, companyId, mad.id));
    expect(toMoney(dec(usdBefore).minus(usdAfter)).toString()).toBe('1000');
    expect(toMoney(dec(madAfter).minus(madBefore)).toString()).toBe('9800');
  }, 180_000);

  it('books the shortfall against the book rate as a realised exchange difference', async () => {
    const fx = await control('FX_GAIN_LOSS');
    // USD 1,000 out, MAD 9,800 in — worth USD 994.92 at 9.85, so about five
    // dollars of the conversion was lost to the bank's rate.
    expect(Number(fx)).toBeGreaterThan(4);
    expect(Number(fx)).toBeLessThan(6);
  }, 120_000);

  it('leaves the books reconciling', async () => {
    const health = await reconcile(companyId);
    expect(
      health.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.left.value} vs ${c.right.value}`),
      health.checks.filter((c) => !c.passed).map((c) => c.label).join('; '),
    ).toEqual([]);
  }, 180_000);

  it('will not guess what arrived', async () => {
    const usd = await getCashAccount(companyId, 'USD');
    const mad = await getCashAccount(companyId, 'MAD');
    await expect(
      postCashBankTransfer({
        companyId,
        userId: ctx.admin.id,
        transferDate: utcDate('2026-02-06'),
        fromAccountId: usd.id,
        toAccountId: mad.id,
        amount: '100',
      }),
    ).rejects.toThrow(/how much MAD actually arrived/i);
  }, 120_000);

  it('still refuses to send money to the same account', async () => {
    const usd = await getCashAccount(companyId, 'USD');
    await expect(
      postCashBankTransfer({
        companyId,
        userId: ctx.admin.id,
        transferDate: utcDate('2026-02-07'),
        fromAccountId: usd.id,
        toAccountId: usd.id,
        amount: '100',
      }),
    ).rejects.toThrow(/two different accounts/i);
  }, 120_000);
});
