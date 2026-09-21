import { Decimal, dec } from '@/lib/money';

/**
 * Bags are a view of the kilograms, not a second balance.
 *
 * Stock is kept in kilograms — every receipt, sale, transfer and adjustment
 * moves KG, and KG is what the ledger values. Bags used to be a separate
 * integer typed on each movement and summed on its own, which let the two
 * drift apart: a transfer that recorded no bag count moved 360 KG into a
 * warehouse and zero bags, the sale out of it then took six bags away, and
 * the warehouse showed −6 bags with coffee still on the shelf.
 *
 * So the bag figure on a stock screen is derived, always, from the quantity
 * it sits beside and the batch's configured bag weight: 652.8 KG in 60 KG
 * bags is 10.88 bags. It cannot go negative while the kilograms are positive,
 * and it cannot disagree with them.
 */

/** Bags held in `kg` at `bagWeightKg` per bag, to two places. Zero when no bag weight is configured. */
export function bagsForKg(kg: Decimal | string | number, bagWeightKg: Decimal | string | number | null | undefined): number {
  const weight = dec(bagWeightKg ?? 0);
  if (weight.lessThanOrEqualTo(0)) return 0;
  return Number(dec(kg).dividedBy(weight).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
}

/**
 * The whole-bag count a document records for a quantity — the rule a sales
 * invoice already used: the nearest whole bag at the batch's bag weight.
 */
export function wholeBagsForKg(kg: Decimal | string | number, bagWeightKg: Decimal | string | number | null | undefined): number {
  const weight = dec(bagWeightKg ?? 0);
  if (weight.lessThanOrEqualTo(0)) return 0;
  return Number(dec(kg).dividedBy(weight).toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
}

/** Sum bag figures without floating-point dust: 10.88 + 0.12 is 11, not 11.000000000000002. */
export function addBags(a: number, b: number): number {
  return Number(dec(a).plus(b).toDecimalPlaces(2));
}

/** "10.88", "330", "0.64" — whole bags without a trailing ".00". */
export function formatBags(bags: number): string {
  return bags.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
