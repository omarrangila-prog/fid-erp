import { Decimal, toMoney, toQuantity, toUnitCost, quantityToKg, unitPriceToPricePerKg, convertToUsd, type EntryUnit } from '@/lib/money';
import { BusinessRuleError } from '@/lib/errors';

/**
 * Sales line arithmetic, kept free of any server dependency so the invoice form
 * previews line values with exactly the calculation the server posts with.
 */

/** Pure line maths — unit-tested without a database. */
export function computeSalesLine(input: {
  quantity: string | number;
  unit: EntryUnit;
  unitPrice: string | number;
  currency: string;
  rateToUsd: string | number;
  /** Required when the line is entered in bags. */
  bagWeightKg?: Decimal | string | number;
}) {
  const quantity = toQuantity(input.quantity);
  const unitPrice = toUnitCost(input.unitPrice);

  if (quantity.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('Sale quantity must be greater than zero.');
  }
  if (unitPrice.lessThan(0)) {
    throw new BusinessRuleError('Sale price cannot be negative.');
  }

  const lineTotal = toMoney(quantity.times(unitPrice));
  return {
    quantity,
    quantityKg: quantityToKg(quantity, input.unit, input.bagWeightKg),
    unitPrice,
    unitPriceKg: unitPriceToPricePerKg(unitPrice, input.unit, input.bagWeightKg),
    lineTotal,
    lineTotalUsd: convertToUsd(lineTotal, input.rateToUsd, input.currency),
  };
}

