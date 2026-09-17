import { describe, expect, it } from 'vitest';
import { Decimal } from '@/lib/money';

/**
 * The arithmetic behind the journal voucher's conversion offer.
 *
 * The voucher balances in USD, so the difference it carries is in dollars.
 * On a line written in another currency that difference has to be multiplied
 * back by the line's own rate before it can be offered — which is the step
 * that turns fifty thousand dollars owed into the dirhams that actually
 * landed in the bank.
 */

/** The same rule the form uses: difference in USD, stated in the line's money. */
function balancing(differenceUsd: string, direction: 'DEBIT' | 'CREDIT', currency: string, rate: string) {
  const difference = new Decimal(differenceUsd);
  const inUsd = direction === 'DEBIT' ? difference.negated() : difference;
  if (!inUsd.greaterThan(0)) return null;
  const r = new Decimal(rate);
  if (currency !== 'USD' && r.lessThanOrEqualTo(0)) return null;
  return (currency === 'USD' ? inUsd : inUsd.times(r)).toFixed(2);
}

describe('a USD loan landing in a dirham bank', () => {
  it('turns USD 50,000 at 9.90 into MAD 495,000', () => {
    // The loan account has been credited USD 50,000, so debits trail by that.
    expect(balancing('-50000', 'DEBIT', 'MAD', '9.90')).toBe('495000.00');
  });

  it('turns USD 50,000 at 9.22 into MAD 461,000', () => {
    expect(balancing('-50000', 'DEBIT', 'MAD', '9.22')).toBe('461000.00');
  });

  it('offers the dollars unchanged on a USD line', () => {
    expect(balancing('-50000', 'DEBIT', 'USD', '1')).toBe('50000.00');
  });

  it('offers nothing to a line on the side that is already heavier', () => {
    expect(balancing('-50000', 'CREDIT', 'MAD', '9.90')).toBeNull();
  });

  it('offers nothing while the rate is still blank', () => {
    expect(balancing('-50000', 'DEBIT', 'MAD', '0')).toBeNull();
  });

  it('offers nothing once the voucher balances', () => {
    expect(balancing('0', 'DEBIT', 'MAD', '9.90')).toBeNull();
  });
});

describe('what each line is worth in USD', () => {
  /** The same rule the form shows beneath every amount. */
  const usd = (amount: string, currency: string, rate: string) =>
    currency === 'USD' ? new Decimal(amount).toFixed(2) : new Decimal(amount).dividedBy(rate).toFixed(2);

  it('reads MAD 495,000 at 9.90 as USD 50,000', () => {
    expect(usd('495000', 'MAD', '9.90')).toBe('50000.00');
  });

  it('exposes a rate typed into the amount box as a dollar or two', () => {
    // The mistake that produced a difference of 50,001: 9.22 typed as the
    // amount is worth one dollar, and now says so on the line.
    expect(usd('9.22', 'MAD', '9.22')).toBe('1.00');
  });
});
