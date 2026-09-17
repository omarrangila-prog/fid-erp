import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, getCashAccount, utcDate } from '../helpers';
import { transaction } from '@/lib/db';
import { postLoan } from '@/lib/services/loan';
import { getCashBankBalance } from '@/lib/services/accounting';
import { getGeneralLedger, getProfitAndLoss } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';
import { dec } from '@/lib/money';

/**
 * A loan from anybody — a director, a friend, the other company.
 *
 * The client borrows from whoever has the money that week. Each lender gets a
 * running account of their own, opened the first time they lend, and the
 * questions are always the same: who gave it to us, how much do we owe them,
 * what reached the bank, and at what rate.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let madBank: string;
let usdBank: string;

async function balance(accountId: string) {
  return dec(await transaction((tx) => getCashBankBalance(tx, companyId, accountId)));
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;

  for (const quoteCurrency of ['MAD']) {
    await prisma.exchangeRate.create({
      data: { companyId, quoteCurrency, rate: '9.85', effectiveDate: utcDate('2026-01-01') },
    });
  }

  madBank = (await getCashAccount(companyId, 'MAD')).id;
  usdBank = (await getCashAccount(companyId, 'USD')).id;
}, 240_000);

describe('Ahmed lends the company dirhams', () => {
  it('opens him a ledger of his own the first time', async () => {
    const before = await balance(madBank);

    const result = await postLoan({
      companyId,
      userId: ctx.admin.id,
      loanDate: utcDate('2026-04-01'),
      direction: 'RECEIVED',
      counterpartyName: 'Ahmed',
      cashBankAccountId: madBank,
      currency: 'MAD',
      amount: '80000',
    });

    expect(result.account.name).toBe('Loan from Ahmed');
    expect(result.account.type).toBe('LIABILITY');
    // A running account with one person holds whatever currency he deals in.
    expect(result.account.currency).toBeNull();

    expect((await balance(madBank)).minus(before).toString()).toBe('80000');
  }, 240_000);

  it('shows on his ledger as money the company owes him', async () => {
    const account = await prisma.account.findFirstOrThrow({
      where: { companyId, name: 'Loan from Ahmed' },
    });
    const ledger = await getGeneralLedger({ companyId, accountId: account.id, currency: 'MAD' });
    expect(ledger.rows).toHaveLength(1);
    // A liability sits credit-side, so the running balance reads negative.
    expect(ledger.closingBalance.toString()).toBe('-80000');
  }, 120_000);

  it('uses the same ledger when he lends again, not a second one', async () => {
    await postLoan({
      companyId,
      userId: ctx.admin.id,
      loanDate: utcDate('2026-04-10'),
      direction: 'RECEIVED',
      counterpartyName: 'Ahmed',
      cashBankAccountId: madBank,
      currency: 'MAD',
      amount: '20000',
    });

    const accounts = await prisma.account.findMany({
      where: { companyId, name: { contains: 'Ahmed' } },
    });
    expect(accounts).toHaveLength(1);

    const ledger = await getGeneralLedger({ companyId, accountId: accounts[0].id, currency: 'MAD' });
    expect(ledger.closingBalance.toString()).toBe('-100000');
  }, 240_000);

  it('is repaid out of the same ledger', async () => {
    const account = await prisma.account.findFirstOrThrow({
      where: { companyId, name: 'Loan from Ahmed' },
    });
    const before = await balance(madBank);

    await postLoan({
      companyId,
      userId: ctx.admin.id,
      loanDate: utcDate('2026-05-01'),
      direction: 'REPAID',
      loanAccountId: account.id,
      counterpartyName: 'Ahmed',
      cashBankAccountId: madBank,
      currency: 'MAD',
      amount: '30000',
    });

    expect(before.minus(await balance(madBank)).toString()).toBe('30000');
    const ledger = await getGeneralLedger({ companyId, accountId: account.id, currency: 'MAD' });
    expect(ledger.closingBalance.toString()).toBe('-70000');
  }, 240_000);
});

describe('a dollar loan that lands as dirhams', () => {
  it('keeps both the dollars owed and the dirhams received', async () => {
    const before = await balance(madBank);

    const result = await postLoan({
      companyId,
      userId: ctx.admin.id,
      loanDate: utcDate('2026-06-01'),
      direction: 'RECEIVED',
      counterpartyName: 'FID Trading LLC Dubai',
      cashBankAccountId: madBank,
      currency: 'USD',
      amount: '50000',
      exchangeRate: '9.22',
    });

    // MAD 461,000 reached the bank.
    expect(result.moved.toString()).toBe('461000');
    expect((await balance(madBank)).minus(before).toString()).toBe('461000');

    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: result.entry.id },
      include: { account: true },
    });

    // The debt is stated in the currency it was struck in.
    const debt = lines.find((l) => l.accountId === result.account.id)!;
    expect(debt.currency).toBe('USD');
    expect(debt.credit.toString()).toBe('50000');
    // …and its dirham value is the historical 461,000, not a fresh conversion.
    expect(debt.creditLocal.toString()).toBe('461000');

    const bank = lines.find((l) => l.cashBankAccountId === madBank)!;
    expect(bank.currency).toBe('MAD');
    expect(bank.debit.toString()).toBe('461000');
    expect(bank.debitUsd.toString()).toBe('50000');
  }, 240_000);

  it('balances in dirhams as well as in dollars', async () => {
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId, description: { contains: 'FID Trading LLC Dubai' } },
      include: { lines: true },
    });
    const drL = entry.lines.reduce((t, l) => t.plus(dec(l.debitLocal)), dec(0));
    const crL = entry.lines.reduce((t, l) => t.plus(dec(l.creditLocal)), dec(0));
    expect(drL.toString()).toBe(crL.toString());

    const drU = entry.lines.reduce((t, l) => t.plus(dec(l.debitUsd)), dec(0));
    const crU = entry.lines.reduce((t, l) => t.plus(dec(l.creditUsd)), dec(0));
    expect(drU.toString()).toBe(crU.toString());
  }, 120_000);
});

describe('the company lends money out', () => {
  it('records it as owed to us, not as a cost', async () => {
    const before = await balance(usdBank);

    const result = await postLoan({
      companyId,
      userId: ctx.admin.id,
      loanDate: utcDate('2026-07-01'),
      direction: 'GIVEN',
      counterpartyName: 'Karim',
      cashBankAccountId: usdBank,
      currency: 'USD',
      amount: '5000',
    });

    expect(result.account.name).toBe('Loan to Karim');
    expect(result.account.type).toBe('ASSET');
    expect(before.minus(await balance(usdBank)).toString()).toBe('5000');

    const ledger = await getGeneralLedger({ companyId, accountId: result.account.id, currency: 'USD' });
    expect(ledger.closingBalance.toString()).toBe('5000');
  }, 240_000);
});

describe('what a loan never does', () => {
  it('touches no income and no expense on the profit and loss', async () => {
    const pnl = await getProfitAndLoss({
      companyId,
      from: utcDate('2026-01-01'),
      to: utcDate('2026-12-31'),
    });
    expect(Number(pnl.totals.revenueUsd)).toBe(0);
    expect(Number(pnl.totals.netProfitUsd)).toBe(0);
  }, 180_000);

  it('refuses a cross-currency loan with no rate', async () => {
    await expect(
      postLoan({
        companyId,
        userId: ctx.admin.id,
        loanDate: utcDate('2026-08-01'),
        direction: 'RECEIVED',
        counterpartyName: 'Someone',
        cashBankAccountId: madBank,
        currency: 'USD',
        amount: '1000',
      }),
    ).rejects.toThrow(/rate used on the day/i);
  }, 120_000);

  it('refuses a loan with nobody on the other side', async () => {
    await expect(
      postLoan({
        companyId,
        userId: ctx.admin.id,
        loanDate: utcDate('2026-08-02'),
        direction: 'RECEIVED',
        cashBankAccountId: madBank,
        currency: 'MAD',
        amount: '1000',
      }),
    ).rejects.toThrow(/who the loan is with/i);
  }, 120_000);

  it('leaves the books reconciling', async () => {
    const health = await reconcile(companyId);
    expect(health.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);
});
