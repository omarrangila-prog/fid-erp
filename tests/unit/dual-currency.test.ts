import { describe, expect, it } from 'vitest';
import { equivalentOf, rateLabel } from '@/lib/dual-currency';

/** The brief's own cases: the transaction's currency first, its equivalent at its own rate. */
describe("the other currency, at the transaction's own rate", () => {
  it('A — a USD 50,000 purchase at 9.22 reads ≈ MAD 461,000', () => {
    const e = equivalentOf({ amount: '50000', currency: 'USD', localCurrency: 'MAD', rateLocalPerUsd: '9.22' })!;
    expect(e.currency).toBe('MAD');
    expect(Number(e.amount)).toBe(461_000);
  });

  it('B — a MAD 100,000 sale at 9.60 reads ≈ USD 10,416.67', () => {
    const e = equivalentOf({ amount: '100000', currency: 'MAD', localCurrency: 'MAD', rateLocalPerUsd: '9.60' })!;
    expect(e.currency).toBe('USD');
    expect(Number(e.amount)).toBeCloseTo(10_416.67, 2);
  });

  it('C — a MAD 7,400 expense at 9.60 reads ≈ USD 770.83', () => {
    const e = equivalentOf({ amount: '7400', currency: 'MAD', localCurrency: 'MAD', rateLocalPerUsd: '9.60' })!;
    expect(Number(e.amount)).toBeCloseTo(770.83, 2);
  });

  it('D — two expenses keep their own rates, never one shared rate', () => {
    const a = equivalentOf({ amount: '1000', currency: 'USD', localCurrency: 'MAD', rateLocalPerUsd: '9.20' })!;
    const b = equivalentOf({ amount: '2000', currency: 'USD', localCurrency: 'MAD', rateLocalPerUsd: '9.50' })!;
    expect(Number(a.amount)).toBe(9_200);
    expect(Number(b.amount)).toBe(19_000);
  });

  it('uses what the transaction stored, when it stored it', () => {
    const e = equivalentOf({ amount: '31190.40', currency: 'MAD', localCurrency: 'MAD', amountUsd: '3283.20', rateLocalPerUsd: '9.85' })!;
    expect(Number(e.amount)).toBe(3_283.2);
  });

  it('invents nothing when there is no rate', () => {
    expect(equivalentOf({ amount: '10000', currency: 'USD', localCurrency: 'MAD' })).toBeNull();
    expect(equivalentOf({ amount: '10000', currency: 'USD', localCurrency: 'MAD', rateLocalPerUsd: '0' })).toBeNull();
  });

  it('names the rate it used', () => {
    const e = equivalentOf({ amount: '1', currency: 'USD', localCurrency: 'MAD', rateLocalPerUsd: '9.6' })!;
    expect(rateLabel(e.rate, 'MAD')).toBe('1 USD = 9.6000 MAD');
  });
});
