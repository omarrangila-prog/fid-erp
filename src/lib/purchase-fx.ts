import { dec, type DecimalInput, type Decimal } from '@/lib/money';

/**
 * The one USD/MAD rate a purchase order's coffee is costed at.
 *
 * An order is bought in dollars and carries one exchange rate: whatever is
 * saved on it now. Every local figure derived from the order — purchase cost,
 * landed cost, cost per kilo, stock value, cost of sales, profit — reads that
 * rate, so editing it moves all of them at once and none can be left on the
 * old one. The dollar purchase price never moves: the supplier is owed the
 * same dollars whatever the dirhams cost.
 *
 * A few orders were given a second, "actual" rate before the client asked for
 * one rate only. Until such an order is next saved, that rate is the one its
 * screens show and its costing uses; saving the order makes it the order's
 * own rate and clears the second one.
 */

export type PurchaseFxInput = {
  /** The rate saved on the order. */
  rateLocalPerUsd: DecimalInput;
  /** A second rate recorded under the earlier two-rate model, if any. */
  actualRateLocalPerUsd?: DecimalInput | null;
};

/** The order's USD/MAD rate. */
export function effectiveLocalRate(contract: PurchaseFxInput): Decimal {
  const legacy = contract.actualRateLocalPerUsd;
  if (legacy !== null && legacy !== undefined) {
    const rate = dec(legacy);
    // A zero or negative rate is not a rate; fall back rather than divide by it.
    if (rate.greaterThan(0)) return rate;
  }
  return dec(contract.rateLocalPerUsd);
}
