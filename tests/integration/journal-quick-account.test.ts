import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, utcDate, transaction } from '../helpers';
import { quickCreateJournalAccount } from '@/lib/services/chart-of-accounts';
import { postJournalEntry, getSystemAccount } from '@/lib/services/accounting';
import { getGeneralLedger } from '@/lib/services/reports';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { REPORT_GROUPS } from '@/lib/constants';
import { dec } from '@/lib/money';

/**
 * Ahmed as a personal current account, created from a journal voucher and
 * then used both ways — money out, money back — without touching profit.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let cashId: string;
let equityId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  cashId = (
    await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, currency: 'MAD', accountType: 'CASH' },
    })
  ).glAccountId;
  equityId = (await transaction((tx) => getSystemAccount(tx, ctx.morocco.id, ACCOUNT_KEYS.OPENING_BALANCE_EQUITY))).id;
});

describe('quickCreateJournalAccount', () => {
  it('creates Ahmed as one current-account head on the balance sheet', async () => {
    const created = await quickCreateJournalAccount({
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      name: 'Ahmed',
      kind: 'PERSONAL',
      currency: 'MAD',
    });

    expect(created.name).toBe('Ahmed');
    expect(created.type).toBe('ASSET');
    expect(created.reportGroup).toBe(REPORT_GROUPS.CURRENT_ASSET);
    // Ahmed's account holds whatever currency he hands over; none is fixed.
    expect(created.currency).toBeNull();
    expect(created.isSystem).toBe(false);
    expect(created.code).toMatch(/^14/);
  });

  it('refuses a second Ahmed', async () => {
    await expect(
      quickCreateJournalAccount({
        companyId: ctx.morocco.id,
        userId: ctx.admin.id,
        name: 'ahmed',
        kind: 'PERSONAL',
        currency: 'MAD',
      }),
    ).rejects.toThrow(/already has an account/i);
  });
});

describe('Ahmed current account journals', () => {
  it('posts a MAD loan out, a MAD repayment, and a USD movement without mixing the ledgers', async () => {
    const ahmed = await prisma.account.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, name: 'Ahmed' },
    });

    await transaction(async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: ctx.morocco.id },
        select: { localCurrency: true },
      });
      await postJournalEntry(tx, {
        companyId: ctx.morocco.id,
        entryDate: utcDate('2026-09-01'),
        description: 'Temporary loan to Ahmed',
        sourceType: 'MANUAL',
        sourceId: 'JV-AHMED-1',
        createdById: ctx.admin.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: '10',
        lines: [
          {
            accountId: ahmed.id,
            direction: 'DEBIT',
            currency: 'MAD',
            amount: '100000',
            rateToUsd: '10',
          },
          {
            accountId: cashId,
            direction: 'CREDIT',
            currency: 'MAD',
            amount: '100000',
            rateToUsd: '10',
          },
        ],
      });
      await postJournalEntry(tx, {
        companyId: ctx.morocco.id,
        entryDate: utcDate('2026-09-10'),
        description: 'Ahmed repaid part',
        sourceType: 'MANUAL',
        sourceId: 'JV-AHMED-2',
        createdById: ctx.admin.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: '10',
        lines: [
          {
            accountId: cashId,
            direction: 'DEBIT',
            currency: 'MAD',
            amount: '40000',
            rateToUsd: '10',
          },
          {
            accountId: ahmed.id,
            direction: 'CREDIT',
            currency: 'MAD',
            amount: '40000',
            rateToUsd: '10',
          },
        ],
      });
      await postJournalEntry(tx, {
        companyId: ctx.morocco.id,
        entryDate: utcDate('2026-09-12'),
        description: 'USD holding with Ahmed',
        sourceType: 'MANUAL',
        sourceId: 'JV-AHMED-3',
        createdById: ctx.admin.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: '10',
        lines: [
          {
            accountId: ahmed.id,
            direction: 'DEBIT',
            currency: 'USD',
            amount: '1000',
            rateToUsd: '1',
          },
          {
            accountId: equityId,
            direction: 'CREDIT',
            currency: 'USD',
            amount: '1000',
            rateToUsd: '1',
          },
        ],
      });
    });

    const mad = await getGeneralLedger({
      companyId: ctx.morocco.id,
      accountId: ahmed.id,
      currency: 'MAD',
    });
    expect(mad.viewCurrency).toBe('MAD');
    expect(mad.rows.every((row) => row.currency === 'MAD')).toBe(true);
    expect(mad.rows.some((row) => row.currency === 'USD')).toBe(false);
    expect(dec(mad.closingBalance).toString()).toBe('60000');
    expect(mad.rows.some((row) => row.debit.toString() === '100000')).toBe(true);
    expect(mad.rows.some((row) => row.credit.toString() === '40000')).toBe(true);

    const usd = await getGeneralLedger({
      companyId: ctx.morocco.id,
      accountId: ahmed.id,
      currency: 'USD',
    });
    expect(usd.viewCurrency).toBe('USD');
    expect(usd.rows.every((row) => row.currency === 'USD')).toBe(true);
    expect(usd.closingBalance.toString()).toBe('1000');

    const all = await getGeneralLedger({
      companyId: ctx.morocco.id,
      accountId: ahmed.id,
      currency: 'ALL',
    });
    expect(all.mixedCurrencies).toBe(true);
    expect(all.rows.some((row) => row.currency === 'MAD')).toBe(true);
    expect(all.rows.some((row) => row.currency === 'USD')).toBe(true);
  });
});
