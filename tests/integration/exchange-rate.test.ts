import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, utcDate } from '../helpers';
import { getRate, getRateDefaults } from '@/lib/services/exchange-rate';

/**
 * The rate a document defaults to.
 *
 * It used to be a literal in eight files while the database held a table of
 * them, so a rate the business had already recorded still had to be typed onto
 * every voucher.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
});

describe('getRate', () => {
  it('reads the rate the business recorded', async () => {
    const rate = await getRate({ companyId: ctx.dubai.id, quoteCurrency: 'AED' });
    expect(Number(rate)).toBeCloseTo(3.6725, 4);
  });

  it('is always exactly 1 for USD', async () => {
    const rate = await getRate({ companyId: ctx.dubai.id, quoteCurrency: 'USD' });
    expect(Number(rate)).toBe(1);
  });

  it('offers the rate that applied on the document date, not today’s', async () => {
    await prisma.exchangeRate.create({
      data: { companyId: null, quoteCurrency: 'MAD', rate: '9.20', effectiveDate: utcDate('2020-01-01') },
    });

    // Back-dating a voucher should offer the rate of that day.
    const then = await getRate({ companyId: ctx.morocco.id, quoteCurrency: 'MAD', asOf: utcDate('2020-06-01') });
    expect(Number(then)).toBeCloseTo(9.2, 4);

    const now = await getRate({ companyId: ctx.morocco.id, quoteCurrency: 'MAD' });
    expect(Number(now)).toBeCloseTo(9.85, 4);
  });

  it('prefers a company’s own rate over the shared one', async () => {
    await prisma.exchangeRate.create({
      data: {
        companyId: ctx.dubai.id,
        quoteCurrency: 'AED',
        rate: '3.7000',
        effectiveDate: utcDate('2026-01-01'),
      },
    });

    const dubai = await getRate({ companyId: ctx.dubai.id, quoteCurrency: 'AED', asOf: utcDate('2026-06-01') });
    expect(Number(dubai)).toBeCloseTo(3.7, 4);

    // Morocco is unaffected by a rate Dubai set for itself. Asked as at today,
    // because the shared rate is seeded with today's date and a June query
    // would correctly find nothing at all.
    const morocco = await getRate({ companyId: ctx.morocco.id, quoteCurrency: 'AED' });
    expect(Number(morocco)).toBeCloseTo(3.6725, 4);
  });

  it('returns nothing rather than inventing a rate it has never been told', async () => {
    const rate = await getRate({ companyId: ctx.dubai.id, quoteCurrency: 'GBP' });
    expect(rate).toBeNull();
  });
});

describe('getRateDefaults', () => {
  it('gives each company its own local currency and rate', async () => {
    const dubai = await getRateDefaults(ctx.dubai.id);
    expect(dubai.localCurrency).toBe('AED');
    expect(dubai.missing).toBe(false);

    const morocco = await getRateDefaults(ctx.morocco.id);
    expect(morocco.localCurrency).toBe('MAD');
    expect(Number(morocco.local)).toBeCloseTo(9.85, 4);
  });

  it('offers a rate for every currency a document can be raised in', async () => {
    const rates = await getRateDefaults(ctx.morocco.id);
    expect(rates.byCurrency.USD).toBe('1');
    expect(Number(rates.byCurrency.AED)).toBeGreaterThan(0);
    expect(Number(rates.byCurrency.MAD)).toBeGreaterThan(0);
  });
});
