import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, utcDate } from '../helpers';
import { transaction } from '@/lib/db';
import { postOpeningBalance } from '@/lib/services/chart-of-accounts';
import { getReceivables, getPayables } from '@/lib/services/receivables';
import { getCustomerLedger, getVendorLedger } from '@/lib/services/ledger';
import { reconcile } from '@/lib/services/reconciliation';
import { toMoney, dec } from '@/lib/money';

/**
 * What a party already owed when the books started here.
 *
 * The figure has to reach the ledger as a journal entry, not as a number on
 * the customer record: a balance held only on the master would move the
 * statement without moving the general ledger, and the control account would
 * disagree with its sub-ledger from the first day.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let customerId: string;
let vendorId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  const customer = await prisma.customer.create({
    data: {
      companyId: ctx.morocco.id,
      customerCode: 'CUS-OPEN',
      customerName: 'Café du Port',
      primaryCurrency: 'MAD',
    },
  });
  customerId = customer.id;
  const vendor = await prisma.vendor.create({
    data: {
      companyId: ctx.morocco.id,
      vendorCode: 'SUP-OPEN',
      vendorName: 'Transitaire Atlas',
      primaryCurrency: 'MAD',
    },
  });
  vendorId = vendor.id;
}, 120_000);

describe('a party opening balance', () => {
  it('reaches receivables, the ledger and the trial balance together', async () => {
    await transaction((tx) =>
      postOpeningBalance(tx, {
        companyId: ctx.morocco.id,
        party: { type: 'CUSTOMER', id: customerId, name: 'Café du Port' },
        currency: 'MAD',
        amount: '48000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        asOf: utcDate('2026-01-01'),
        userId: ctx.admin.id,
      }),
    );

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, sourceType: 'OPENING_BALANCE', sourceId: customerId },
      include: { lines: true },
    });
    const debit = entry.lines.reduce((t, l) => t.plus(dec(l.debit)), dec(0));
    const credit = entry.lines.reduce((t, l) => t.plus(dec(l.credit)), dec(0));
    expect(toMoney(debit).toString()).toBe(toMoney(credit).toString());

    // The customer's own ledger opens on it.
    const ledger = await getCustomerLedger({
      companyId: ctx.morocco.id,
      customerId,
      view: 'TRANSACTION',
      localCurrency: 'MAD',
      partyCurrency: 'MAD',
    });
    expect(ledger.rows.length).toBeGreaterThan(0);

    const receivables = await getReceivables({ companyId: ctx.morocco.id, onlyOutstanding: true });
    expect(receivables.some((r) => r.customerId === customerId)).toBe(true);

    const health = await reconcile(ctx.morocco.id);
    expect(health.healthy, health.checks.filter((c) => !c.passed).map((c) => c.label).join('; ')).toBe(true);
  }, 120_000);

  it('does the same on the payables side', async () => {
    await transaction((tx) =>
      postOpeningBalance(tx, {
        companyId: ctx.morocco.id,
        party: { type: 'VENDOR', id: vendorId, name: 'Transitaire Atlas' },
        currency: 'MAD',
        amount: '17500',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        asOf: utcDate('2026-01-01'),
        userId: ctx.admin.id,
      }),
    );

    const payables = await getPayables({ companyId: ctx.morocco.id });
    expect(payables.some((r) => r.vendorId === vendorId)).toBe(true);

    const ledger = await getVendorLedger({
      companyId: ctx.morocco.id,
      vendorId,
      view: 'TRANSACTION',
      localCurrency: 'MAD',
      partyCurrency: 'MAD',
    });
    expect(ledger.rows.length).toBeGreaterThan(0);

    const health = await reconcile(ctx.morocco.id);
    expect(health.healthy, health.checks.filter((c) => !c.passed).map((c) => c.label).join('; ')).toBe(true);
  }, 120_000);

  it('refuses a negative opening balance rather than inventing a credit', async () => {
    await expect(
      transaction((tx) =>
        postOpeningBalance(tx, {
          companyId: ctx.morocco.id,
          party: { type: 'CUSTOMER', id: customerId, name: 'Café du Port' },
          currency: 'MAD',
          amount: '-100',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
          asOf: utcDate('2026-01-01'),
          userId: ctx.admin.id,
        }),
      ),
    ).rejects.toThrow(/cannot be negative/i);
  }, 120_000);
});
