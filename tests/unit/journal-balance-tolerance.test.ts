import { describe, it, expect } from 'vitest';
import { Decimal, tryDec, USD_TRANSLATION_TOLERANCE } from '@/lib/money';

/**
 * When a journal entry counts as balanced.
 *
 * The client entered a Tangier trip: USD 3,401.30 debited against MAD 31,360
 * credited at 9.22 to the dollar. Both sides showed 3,401.30 and the
 * difference showed 0.00, but the form demanded an exact zero and refused to
 * post — MAD 31,360 / 9.22 is 3,401.3015…, fifteen ten-thousandths out. There
 * was nothing the user could type to clear it, because no whole cent of
 * dirhams converts to exactly 3,401.30.
 *
 * The posting engine absorbs a residue under half a cent. The form must use
 * the same ceiling, or it blocks entries the ledger would accept.
 */

/** The form's own sum, in USD. */
function totals(lines: Array<{ amount: string; currency: string; rateToUsd: string; direction: 'DEBIT' | 'CREDIT' }>) {
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const line of lines) {
    const value = tryDec(line.amount);
    const rate = tryDec(line.rateToUsd);
    if (line.currency !== 'USD' && !rate.greaterThan(0)) continue;
    const usd = line.currency === 'USD' ? value : value.dividedBy(rate);
    if (line.direction === 'DEBIT') debit = debit.plus(usd);
    else credit = credit.plus(usd);
  }
  const difference = debit.minus(credit);
  const settled = difference.abs().lessThanOrEqualTo(USD_TRANSLATION_TOLERANCE);
  return { debit, credit, difference, settled, balanced: settled && debit.greaterThan(0) };
}

describe('a journal entry balances', () => {
  it("accepts the client's Tangier trip: USD 3,401.30 against MAD 31,360 at 9.22", () => {
    const t = totals([
      { amount: '3401.30', currency: 'USD', rateToUsd: '1', direction: 'DEBIT' },
      { amount: '31360', currency: 'MAD', rateToUsd: '9.22', direction: 'CREDIT' },
    ]);
    // The residue is real but smaller than a cent anyone could pay.
    expect(t.difference.abs().lessThan('0.005')).toBe(true);
    expect(t.difference.isZero()).toBe(false);
    // And the entry posts.
    expect(t.balanced).toBe(true);
  });

  it('still refuses a difference a person could see', () => {
    const t = totals([
      { amount: '3401.30', currency: 'USD', rateToUsd: '1', direction: 'DEBIT' },
      { amount: '31000', currency: 'MAD', rateToUsd: '9.22', direction: 'CREDIT' },
    ]);
    expect(t.balanced).toBe(false);
    // Thirty-nine dollars short: a real error, not rounding.
    expect(t.difference.toFixed(2)).toBe('39.04');
  });

  it('refuses a cent out, which is money', () => {
    const t = totals([
      { amount: '100.00', currency: 'USD', rateToUsd: '1', direction: 'DEBIT' },
      { amount: '99.99', currency: 'USD', rateToUsd: '1', direction: 'CREDIT' },
    ]);
    expect(t.balanced).toBe(false);
  });

  it('refuses an empty entry, however balanced nothing is', () => {
    const t = totals([
      { amount: '0', currency: 'USD', rateToUsd: '1', direction: 'DEBIT' },
      { amount: '0', currency: 'USD', rateToUsd: '1', direction: 'CREDIT' },
    ]);
    expect(t.settled).toBe(true);
    expect(t.balanced).toBe(false);
  });

  it('does not count a dirham as a dollar when the rate is mistyped', () => {
    // The client's rate field read "9..22", which is not a number. It used to
    // fall back to zero, and a zero rate meant "already dollars": MAD 31,360
    // counted as USD 31,360 and the entry looked balanced at nine times its
    // worth.
    const t = totals([
      { amount: '31360', currency: 'USD', rateToUsd: '1', direction: 'DEBIT' },
      { amount: '31360', currency: 'MAD', rateToUsd: '9..22', direction: 'CREDIT' },
    ]);
    // The unusable line contributes nothing, so the entry is plainly wrong.
    expect(t.credit.toFixed(2)).toBe('0.00');
    expect(t.balanced).toBe(false);
  });

  it('accepts an exact same-currency entry', () => {
    const t = totals([
      { amount: '5000', currency: 'MAD', rateToUsd: '9.22', direction: 'DEBIT' },
      { amount: '5000', currency: 'MAD', rateToUsd: '9.22', direction: 'CREDIT' },
    ]);
    expect(t.difference.isZero()).toBe(true);
    expect(t.balanced).toBe(true);
  });
});
