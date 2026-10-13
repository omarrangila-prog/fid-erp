import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { postJournalEntry, getTrialBalance } from '@/lib/services/accounting';
import { transaction } from '@/lib/db';
import { dec } from '@/lib/money';

/**
 * A MAD payment reducing a USD loan.
 *
 * The client pays Sameer & Ali in dirhams to settle part of what Morocco owes
 * the Dubai company, and the Dubai loan is kept in dollars. Both sides are
 * real amounts in their own currency — MAD 2,100 out, USD 218.75 off the loan
 * — and the books balance in dollars, which is what they are kept in.
 *
 * The form used to offer one currency for the whole entry and filter both
 * account lists by it, so the MAD account and the USD loan could never both
 * be chosen: one side stayed empty and nothing could be posted.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let sameerId: string;
let dubaiLoanId: string;
let n = 0;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  await createMasters(companyId, { currency: 'MAD' });

  // The client's own two accounts: an asset held in MAD, a liability in USD.
  sameerId = (
    await prisma.account.create({
      data: {
        companyId, code: '1901', name: 'SAMEER & ALI TRIP', type: 'ASSET',
        currency: 'MAD', reportGroup: 'CURRENT_ASSET', status: 'ACTIVE',
      },
    })
  ).id;
  dubaiLoanId = (
    await prisma.account.create({
      data: {
        companyId, code: '1600', name: 'F I D TRADING LLC DUBAI', type: 'LIABILITY',
        currency: 'USD', reportGroup: 'CURRENT_LIABILITY', status: 'ACTIVE',
      },
    })
  ).id;
}, 300_000);

/** What the form now sends: each side in its own currency, at its own rate. */
async function post(lines: Array<{ accountId: string; direction: 'DEBIT' | 'CREDIT'; currency: string; amount: string; rateToUsd: string }>, memo = 'Paid to Sameer against the Dubai loan') {
  n += 1;
  return transaction((tx) =>
    postJournalEntry(tx, {
      companyId,
      entryDate: utcDate('2026-10-05'),
      description: memo,
      sourceType: 'MANUAL',
      sourceId: `JV-TEST-${n}`,
      createdById: ctx.admin.id,
      localCurrency: 'MAD',
      rateLocalPerUsd: '9.6',
      lines,
    } as never),
  );
}

const balanceOf = async (accountId: string) => {
  const rows = await prisma.$queryRaw<Array<{ usd: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND jl."accountId" = ${accountId}`;
  return dec(rows[0]?.usd ?? 0);
};

describe('a MAD payment against a USD loan', () => {
  it('posts both sides in their own currency and balances in dollars', async () => {
    // MAD 2,100 at 9.6 to the dollar is USD 218.75.
    const entry = await post([
      { accountId: dubaiLoanId, direction: 'DEBIT', currency: 'USD', amount: '218.75', rateToUsd: '1' },
      { accountId: sameerId, direction: 'CREDIT', currency: 'MAD', amount: '2100.00', rateToUsd: '9.6' },
    ]);
    expect(entry.id).toBeTruthy();

    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: entry.id },
      select: { currency: true, debit: true, credit: true, debitUsd: true, creditUsd: true },
      orderBy: { lineNumber: 'asc' },
    });

    // Each side kept its own currency and its own amount — no fake USD
    // transaction, no raw mixing of dirhams and dollars.
    expect(lines.map((l) => l.currency).sort()).toEqual(['MAD', 'USD']);
    // The dirhams that actually left, in dirhams.
    const mad = lines.find((l) => l.currency === 'MAD')!;
    expect(dec(mad.credit).toFixed(2)).toBe('2100.00');
    // And the dollars the loan lost, in dollars.
    const usd = lines.find((l) => l.currency === 'USD')!;
    expect(dec(usd.debit).toFixed(2)).toBe('218.75');

    // And it balances where the books balance: in dollars.
    const debit = lines.reduce((t, l) => t.plus(dec(l.debitUsd)), dec(0));
    const credit = lines.reduce((t, l) => t.plus(dec(l.creditUsd)), dec(0));
    expect(debit.toFixed(2)).toBe('218.75');
    expect(debit.minus(credit).toFixed(2)).toBe('0.00');
  }, 120_000);

  it('reduces what Morocco owes Dubai by the dollars paid', async () => {
    // The loan starts at USD 5,000 owed.
    await post([
      { accountId: dubaiLoanId, direction: 'CREDIT', currency: 'USD', amount: '5000', rateToUsd: '1' },
      { accountId: sameerId, direction: 'DEBIT', currency: 'MAD', amount: '48000', rateToUsd: '9.6' },
    ], 'Opening the Dubai loan');
    const before = await balanceOf(dubaiLoanId);

    await post([
      { accountId: dubaiLoanId, direction: 'DEBIT', currency: 'USD', amount: '218.75', rateToUsd: '1' },
      { accountId: sameerId, direction: 'CREDIT', currency: 'MAD', amount: '2100.00', rateToUsd: '9.6' },
    ]);

    // A liability is a credit balance, so paying it off moves it towards zero.
    expect((await balanceOf(dubaiLoanId)).minus(before).toFixed(2)).toBe('218.75');
  }, 120_000);

  it('refuses an entry whose two sides are not worth the same in dollars', async () => {
    // MAD 2,100 is USD 218.75, not USD 500: a wrong rate must not post.
    await expect(
      post([
        { accountId: dubaiLoanId, direction: 'DEBIT', currency: 'USD', amount: '500', rateToUsd: '1' },
        { accountId: sameerId, direction: 'CREDIT', currency: 'MAD', amount: '2100.00', rateToUsd: '9.6' },
      ]),
    ).rejects.toThrow(/does not balance/i);
  }, 120_000);

  it('posts a same-currency entry as before', async () => {
    const entry = await post([
      { accountId: sameerId, direction: 'DEBIT', currency: 'MAD', amount: '1000', rateToUsd: '9.6' },
      { accountId: dubaiLoanId, direction: 'CREDIT', currency: 'USD', amount: '104.17', rateToUsd: '1' },
    ], 'MAD to MAD');
    expect(entry.id).toBeTruthy();
  }, 120_000);

  it('leaves the trial balance square', async () => {
    const rows = await transaction((tx) => getTrialBalance(tx, companyId));
    const debit = rows.reduce((t, r) => t.plus(dec(r.debitUsd ?? 0)), dec(0));
    const credit = rows.reduce((t, r) => t.plus(dec(r.creditUsd ?? 0)), dec(0));
    expect(debit.minus(credit).abs().lessThanOrEqualTo('0.01')).toBe(true);
  }, 120_000);
});
