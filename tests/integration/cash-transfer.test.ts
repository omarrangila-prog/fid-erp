import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, getCashAccount, utcDate } from '../helpers';
import { transaction } from '@/lib/db';
import { postCashBankTransfer } from '@/lib/services/cash-transfer';
import { postAccountOpeningBalance } from '@/lib/services/chart-of-accounts';
import { getCashBankBalance, postJournalEntry } from '@/lib/services/accounting';
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

describe('a journal voucher that mixes currencies', () => {
  it('posts a line in MAD against a line in USD, balancing in USD', async () => {
    const madBank = await getCashAccount(companyId, 'MAD');
    // A plain ledger account, the kind a user makes for a loan from the other
    // company: no drawer, so no currency of its own.
    const loanAccount = await prisma.account.create({
      data: {
        companyId,
        code: '1600',
        name: 'F I D TRADING LLC DUBAI',
        type: 'ASSET',
        reportGroup: 'CURRENT_ASSET',
      },
    });

    const madBefore = await transaction((tx) => getCashBankBalance(tx, companyId, madBank.id));

    const entry = await transaction((tx) =>
      postJournalEntry(tx, {
        companyId,
        entryDate: utcDate('2026-04-01'),
        description: 'Loan received from FID Trading LLC Dubai',
        sourceType: 'MANUAL',
        sourceId: `JV-MIXED-${Date.now()}`,
        createdById: ctx.admin.id,
        localCurrency: 'MAD',
        rateLocalPerUsd: '9.85',
        lines: [
          // MAD 98,500 into the Moroccan bank …
          {
            cashBankAccountId: madBank.id,
            direction: 'DEBIT',
            currency: 'MAD',
            amount: '98500',
            rateToUsd: '9.85',
            description: 'Received from Dubai',
          },
          // … against USD 10,000 owed, on a line in dollars.
          {
            accountId: loanAccount.id,
            direction: 'CREDIT',
            currency: 'USD',
            amount: '10000',
            rateToUsd: '1',
            description: 'Owed to Dubai',
          },
        ],
      }),
    );

    expect(entry.status).toBe('POSTED');

    // Each line kept its own currency; the entry balances in USD.
    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: entry.id },
      select: { currency: true, debit: true, credit: true, debitUsd: true, creditUsd: true },
      orderBy: { lineNumber: 'asc' },
    });
    expect(lines.map((l) => l.currency).sort()).toEqual(['MAD', 'USD']);
    const dr = lines.reduce((t, l) => t.plus(dec(l.debitUsd)), dec(0));
    const cr = lines.reduce((t, l) => t.plus(dec(l.creditUsd)), dec(0));
    expect(toMoney(dr.minus(cr)).abs().lessThanOrEqualTo('0.005')).toBe(true);

    // The MAD bank moved in MAD, by the MAD amount.
    const madAfter = await transaction((tx) => getCashBankBalance(tx, companyId, madBank.id));
    expect(toMoney(dec(madAfter).minus(madBefore)).toString()).toBe('98500');

    const health = await reconcile(companyId);
    expect(health.healthy, health.checks.filter((c) => !c.passed).map((c) => c.label).join('; ')).toBe(true);
  }, 240_000);

  it('still refuses a MAD drawer asked to hold USD', async () => {
    const madBank = await getCashAccount(companyId, 'MAD');
    const usdBank = await getCashAccount(companyId, 'USD');
    await expect(
      transaction((tx) =>
        postJournalEntry(tx, {
          companyId,
          entryDate: utcDate('2026-04-02'),
          description: 'USD through the MAD till',
          sourceType: 'MANUAL',
          sourceId: `JV-BAD-${Date.now()}`,
          createdById: ctx.admin.id,
          localCurrency: 'MAD',
          rateLocalPerUsd: '9.85',
          lines: [
            { cashBankAccountId: madBank.id, direction: 'DEBIT', currency: 'USD', amount: '100', rateToUsd: '1' },
            { cashBankAccountId: usdBank.id, direction: 'CREDIT', currency: 'USD', amount: '100', rateToUsd: '1' },
          ],
        }),
      ),
    ).rejects.toThrow(/held in MAD|cannot be recorded through it/i);
  }, 120_000);
});
