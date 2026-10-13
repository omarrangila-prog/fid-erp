import { dec, type DecimalInput, type Decimal } from '@/lib/money';

/**
 * Which rate a purchase order's local-currency costing is stated at.
 *
 * An order is placed in dollars at the best rate available that day. That rate
 * is an estimate: the real one appears later, when the dollars are actually
 * bought to pay the supplier. Until then every local figure derived from the
 * order — landed cost, cost per kilo, inventory value, cost of sales — is
 * stated at a rate nobody paid.
 *
 * One definition, read by every screen, so confirming the rate moves all of
 * them at once and none can be left showing the estimate. The dollar purchase
 * price is never touched: the supplier is owed the same dollars whatever the
 * dirhams cost.
 */

export type PurchaseFxSource = 'ESTIMATED' | 'ACTUAL';

export type PurchaseFxInput = {
  /** The rate entered when the order was placed. */
  rateLocalPerUsd: DecimalInput;
  /** The rate actually paid, once known. Null while still an estimate. */
  actualRateLocalPerUsd?: DecimalInput | null;
};

/** The rate costing must use: the actual one when it is known, else the estimate. */
export function effectiveLocalRate(contract: PurchaseFxInput): Decimal {
  const actual = contract.actualRateLocalPerUsd;
  if (actual !== null && actual !== undefined) {
    const rate = dec(actual);
    // A zero or negative rate is not a rate; fall back rather than divide by it.
    if (rate.greaterThan(0)) return rate;
  }
  return dec(contract.rateLocalPerUsd);
}

/** Whether that rate is the one actually paid, or still the day's guess. */
export function purchaseFxSource(contract: PurchaseFxInput): PurchaseFxSource {
  const actual = contract.actualRateLocalPerUsd;
  return actual !== null && actual !== undefined && dec(actual).greaterThan(0) ? 'ACTUAL' : 'ESTIMATED';
}

export const PURCHASE_FX_LABELS: Record<PurchaseFxSource, string> = {
  ESTIMATED: 'Estimated',
  ACTUAL: 'Actual',
};

/**
 * What confirming the rate does to the local value of a dollar amount.
 *
 * Reported so the user sees the size of the change before it is saved, and so
 * the difference can be explained afterwards rather than appearing as an
 * unexplained movement in cost.
 */
export function localRateImpact(params: {
  amountUsd: DecimalInput;
  estimatedRate: DecimalInput;
  actualRate: DecimalInput;
}): { estimatedLocal: Decimal; actualLocal: Decimal; difference: Decimal } {
  const usd = dec(params.amountUsd);
  const estimatedLocal = usd.times(dec(params.estimatedRate));
  const actualLocal = usd.times(dec(params.actualRate));
  return { estimatedLocal, actualLocal, difference: actualLocal.minus(estimatedLocal) };
}
