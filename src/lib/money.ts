import Decimal from 'decimal.js';

/**
 * Decimal arithmetic comes from decimal.js directly rather than through
 * `Prisma.Decimal`, even though Prisma's decimal *is* decimal.js.
 *
 * That keeps this module free of any server-only dependency, so the same
 * rounding and conversion rules can run in a form preview in the browser as
 * run in the posting engine on the server — there is exactly one implementation
 * of "what is 12.5 MT at 4.50 a kilo", not two that can drift apart. Prisma
 * accepts a decimal.js instance wherever it expects a Decimal.
 */

/**
 * Decimal-safe money, rate and quantity arithmetic.
 *
 * Rules enforced here (see docs/MULTI_CURRENCY.md):
 *  - No JavaScript floating point ever touches a monetary value.
 *  - Exchange rates are always expressed as "units of the quoted currency per
 *    1 USD". USD itself therefore always has a rate of exactly 1.
 *  - Converting to USD divides by the rate; converting from USD multiplies.
 *  - Every rounding step is explicit and uses ROUND_HALF_UP.
 */

export const MONEY_SCALE = 4;
export const RATE_SCALE = 8;
export const QUANTITY_SCALE = 3;
export const UNIT_COST_SCALE = 8;

const HALF_UP = Decimal.ROUND_HALF_UP;

export type DecimalInput = Decimal | string | number;

/** Number of decimals a currency is presented with. */
export const CURRENCY_DISPLAY_SCALE: Record<string, number> = {
  USD: 2,
  AED: 2,
  MAD: 2,
  EUR: 2,
};

export const SUPPORTED_CURRENCIES = ['USD', 'AED', 'MAD'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const BASE_CURRENCY = 'USD';

/** 1 metric ton expressed in the canonical inventory unit (kilograms). */
export const KG_PER_MT = new Decimal(1000);

export function dec(value: DecimalInput | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  if (value instanceof Decimal) return value;
  const d = new Decimal(value);
  if (!d.isFinite()) {
    throw new Error(`Value "${String(value)}" is not a finite decimal.`);
  }
  return d;
}

export function toMoney(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(MONEY_SCALE, HALF_UP);
}

export function toRate(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(RATE_SCALE, HALF_UP);
}

export function toQuantity(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(QUANTITY_SCALE, HALF_UP);
}

export function toUnitCost(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(UNIT_COST_SCALE, HALF_UP);
}

/** Rounds to the presentation scale of a currency (2dp for USD/AED/MAD). */
export function toCurrencyScale(value: DecimalInput, currency: string): Decimal {
  const scale = CURRENCY_DISPLAY_SCALE[currency.toUpperCase()] ?? 2;
  return dec(value).toDecimalPlaces(scale, HALF_UP);
}

export function sum(values: DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}

export function isZero(value: DecimalInput): boolean {
  return dec(value).isZero();
}

export function isNegative(value: DecimalInput): boolean {
  return dec(value).isNegative() && !dec(value).isZero();
}

export function isPositive(value: DecimalInput): boolean {
  return dec(value).greaterThan(0);
}

export function max(a: DecimalInput, b: DecimalInput): Decimal {
  const da = dec(a);
  const db = dec(b);
  return da.greaterThan(db) ? da : db;
}

export function min(a: DecimalInput, b: DecimalInput): Decimal {
  const da = dec(a);
  const db = dec(b);
  return da.lessThan(db) ? da : db;
}

// ---------------------------------------------------------------------------
// Unit conversion — the canonical inventory unit is the kilogram
// ---------------------------------------------------------------------------

export type EntryUnit = 'KG' | 'MT' | 'BAG';

/**
 * How many kilograms one unit represents.
 *
 * Coffee is quoted per kilogram, per metric ton and — very commonly — per bag,
 * so all three are first-class entry units. A bag has no fixed weight: it is
 * whatever the coffee's packaging says, typically 60 KG but 70 for Colombia and
 * 30 for some Ethiopian lots. That is why the bag weight must be supplied.
 */
function kgPerUnit(unit: EntryUnit, bagWeightKg?: DecimalInput): Decimal {
  if (unit === 'MT') return KG_PER_MT;
  if (unit === 'KG') return new Decimal(1);

  const weight = dec(bagWeightKg ?? 0);
  if (weight.lessThanOrEqualTo(0)) {
    throw new Error('A bag weight is required to convert a quantity entered in bags.');
  }
  return weight;
}

/** Converts a quantity entered in KG, MT or bags into canonical kilograms. */
export function quantityToKg(quantity: DecimalInput, unit: EntryUnit, bagWeightKg?: DecimalInput): Decimal {
  return toQuantity(dec(quantity).times(kgPerUnit(unit, bagWeightKg)));
}

/** Converts canonical kilograms back into the unit the user prefers. */
export function kgToUnit(quantityKg: DecimalInput, unit: EntryUnit, bagWeightKg?: DecimalInput): Decimal {
  return toQuantity(dec(quantityKg).dividedBy(kgPerUnit(unit, bagWeightKg)));
}

/**
 * Converts a price expressed per entered unit into a price per kilogram.
 * USD 900 per MT is USD 0.90 per KG; USD 300 per 60 KG bag is USD 5.00 per KG.
 */
export function unitPriceToPricePerKg(
  unitPrice: DecimalInput,
  unit: EntryUnit,
  bagWeightKg?: DecimalInput,
): Decimal {
  return toUnitCost(dec(unitPrice).dividedBy(kgPerUnit(unit, bagWeightKg)));
}

// ---------------------------------------------------------------------------
// Currency conversion
// ---------------------------------------------------------------------------

/**
 * Converts an amount in `currency` into USD using `rateToUsd`, which is the
 * number of units of `currency` that equal 1 USD.
 *
 * AED 100,000 at a rate of 3.678 becomes USD 27,188.6895.
 */
export function convertToUsd(amount: DecimalInput, rateToUsd: DecimalInput, currency?: string): Decimal {
  if (currency && currency.toUpperCase() === BASE_CURRENCY) {
    return toMoney(amount);
  }
  const rate = dec(rateToUsd);
  if (rate.lessThanOrEqualTo(0)) {
    throw new Error('Exchange rate must be greater than zero.');
  }
  return toMoney(dec(amount).dividedBy(rate));
}

/** Converts a USD amount into `currency` using the same rate convention. */
export function convertFromUsd(amountUsd: DecimalInput, rateToUsd: DecimalInput, currency?: string): Decimal {
  if (currency && currency.toUpperCase() === BASE_CURRENCY) {
    return toMoney(amountUsd);
  }
  const rate = dec(rateToUsd);
  if (rate.lessThanOrEqualTo(0)) {
    throw new Error('Exchange rate must be greater than zero.');
  }
  return toMoney(dec(amountUsd).times(rate));
}

/**
 * Converts an amount in the transaction currency into the company's local
 * currency, going through USD.
 *
 * When the transaction currency already *is* the local currency the original
 * amount is returned untouched — routing it through USD and back would
 * introduce a rounding error of up to half a cent for no reason.
 */
export function convertToLocal(params: {
  amount: DecimalInput;
  currency: string;
  rateToUsd: DecimalInput;
  localCurrency: string;
  rateLocalPerUsd: DecimalInput;
}): Decimal {
  const { amount, currency, rateToUsd, localCurrency, rateLocalPerUsd } = params;
  if (currency.toUpperCase() === localCurrency.toUpperCase()) {
    return toMoney(amount);
  }
  const usd = convertToUsd(amount, rateToUsd, currency);
  return convertFromUsd(usd, rateLocalPerUsd, localCurrency);
}

/**
 * Distributes `total` across `weights` proportionally without losing or
 * inventing money: the returned amounts always sum exactly to `total`. Any
 * rounding remainder lands on the largest-weighted entry.
 *
 * Used to spread contract freight across purchase lines.
 */
export function allocateProportionally(total: DecimalInput, weights: DecimalInput[]): Decimal[] {
  const totalDec = toMoney(total);
  const weightDecs = weights.map((w) => dec(w));
  const weightSum = sum(weightDecs);

  if (weightDecs.length === 0) return [];
  if (totalDec.isZero()) return weightDecs.map(() => new Decimal(0));

  if (weightSum.isZero()) {
    // No meaningful weights: split evenly and push the remainder onto the first.
    const even = toMoney(totalDec.dividedBy(weightDecs.length));
    const result = weightDecs.map(() => even);
    const drift = totalDec.minus(sum(result));
    result[0] = toMoney(result[0].plus(drift));
    return result;
  }

  const allocated = weightDecs.map((w) => toMoney(totalDec.times(w).dividedBy(weightSum)));
  const drift = totalDec.minus(sum(allocated));

  if (!drift.isZero()) {
    let largestIndex = 0;
    for (let i = 1; i < weightDecs.length; i += 1) {
      if (weightDecs[i].greaterThan(weightDecs[largestIndex])) largestIndex = i;
    }
    allocated[largestIndex] = toMoney(allocated[largestIndex].plus(drift));
  }

  return allocated;
}

/** Percentage helper that returns 0 instead of NaN/Infinity for a zero base. */
export function percentage(part: DecimalInput, whole: DecimalInput): Decimal {
  const w = dec(whole);
  if (w.isZero()) return new Decimal(0);
  return dec(part).dividedBy(w).times(100).toDecimalPlaces(2, HALF_UP);
}

export { Decimal };
