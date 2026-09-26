import Decimal from 'decimal.js';

/**
 * Client-side preview of the purchase contract arithmetic.
 *
 * This deliberately mirrors `computePurchaseTotals` on the server, using the
 * same decimal library and the same rounding, so the buyer sees exactly the
 * figures that will be posted. The server remains the authority — this only
 * exists so the landed cost per kilogram updates as you type.
 */

const HALF_UP = Decimal.ROUND_HALF_UP;
const KG_PER_MT = new Decimal(1000);

export type LineDraft = {
  key: string;
  /** The saved row, when an approved order is being corrected. */
  id?: string;
  /** Received: its coffee, kilograms and numbers are what the warehouse counted. */
  locked?: boolean;
  itemId: string;
  lotNumber: string;
  batchNumber: string;
  containerNumber: string;
  quantity: string;
  unit: 'KG' | 'MT' | 'BAG';
  unitPrice: string;
  bags: string;
  bagWeightKg: string;
  notes: string;
};

const dec = (value: string | number | undefined | null) => {
  if (value === undefined || value === null || value === '') return new Decimal(0);
  try {
    const d = new Decimal(String(value).replace(/,/g, '').trim() || 0);
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};

const money = (d: Decimal) => d.toDecimalPlaces(4, HALF_UP);
const qty = (d: Decimal) => d.toDecimalPlaces(3, HALF_UP);
const unitCost = (d: Decimal) => d.toDecimalPlaces(8, HALF_UP);

function kgPerUnit(unit: LineDraft['unit'], bagWeightKg: Decimal) {
  if (unit === 'MT') return KG_PER_MT;
  if (unit === 'KG') return new Decimal(1);
  return bagWeightKg.greaterThan(0) ? bagWeightKg : new Decimal(0);
}

/** Distributes a total by weight without losing or inventing money. */
function allocate(total: Decimal, weights: Decimal[]): Decimal[] {
  if (weights.length === 0) return [];
  if (total.isZero()) return weights.map(() => new Decimal(0));

  const sum = weights.reduce((a, w) => a.plus(w), new Decimal(0));
  if (sum.isZero()) {
    const even = money(total.dividedBy(weights.length));
    const result = weights.map(() => even);
    result[0] = money(result[0].plus(total.minus(result.reduce((a, r) => a.plus(r), new Decimal(0)))));
    return result;
  }

  const allocated = weights.map((w) => money(total.times(w).dividedBy(sum)));
  const drift = total.minus(allocated.reduce((a, r) => a.plus(r), new Decimal(0)));

  if (!drift.isZero()) {
    let largest = 0;
    for (let i = 1; i < weights.length; i += 1) if (weights[i].greaterThan(weights[largest])) largest = i;
    allocated[largest] = money(allocated[largest].plus(drift));
  }

  return allocated;
}

export type LinePreview = {
  quantityKg: number;
  bags: number;
  lineSubtotal: number;
  allocated: number;
  lineTotal: number;
  unitCostKg: string;
};

export function computePurchaseTotalsClient(input: {
  lines: LineDraft[];
  freightAmount: string;
  otherCharges: string;
  rateToUsd: string;
  currency: string;
}) {
  const base = input.lines.map((line) => {
    const quantity = qty(dec(line.quantity));
    const bagWeight = qty(dec(line.bagWeightKg));
    const factor = kgPerUnit(line.unit, bagWeight);
    const quantityKg = qty(quantity.times(factor));
    const lineSubtotal = money(quantity.times(dec(line.unitPrice)));
    const bags = line.bags
      ? Number(line.bags)
      : line.unit === 'BAG'
        ? Number(quantity.toFixed(0))
        : bagWeight.greaterThan(0)
          ? Number(quantityKg.dividedBy(bagWeight).toFixed(0))
          : 0;

    return { quantityKg, lineSubtotal, bags, hasContainer: line.containerNumber.trim().length > 0 };
  });

  const freight = money(dec(input.freightAmount));
  const other = money(dec(input.otherCharges));
  const weights = base.map((l) => l.lineSubtotal);
  const freightSplit = allocate(freight, weights);
  const otherSplit = allocate(other, weights);

  const lines: LinePreview[] = base.map((l, i) => {
    const allocated = money(freightSplit[i].plus(otherSplit[i]));
    const lineTotal = money(l.lineSubtotal.plus(allocated));
    return {
      quantityKg: Number(l.quantityKg),
      bags: l.bags,
      lineSubtotal: Number(l.lineSubtotal),
      allocated: Number(allocated),
      lineTotal: Number(lineTotal),
      unitCostKg: l.quantityKg.greaterThan(0)
        ? unitCost(lineTotal.dividedBy(l.quantityKg)).toString()
        : '0',
    };
  });

  const subtotal = money(base.reduce((a, l) => a.plus(l.lineSubtotal), new Decimal(0)));
  const totalValue = money(subtotal.plus(freight).plus(other));
  const rate = dec(input.rateToUsd);
  const totalValueUsd =
    input.currency === 'USD' ? totalValue : rate.greaterThan(0) ? money(totalValue.dividedBy(rate)) : new Decimal(0);

  return {
    lines,
    subtotal: Number(subtotal),
    totalValue: Number(totalValue),
    totalValueUsd: Number(totalValueUsd),
    totalQuantityKg: Number(qty(base.reduce((a, l) => a.plus(l.quantityKg), new Decimal(0)))),
    totalBags: base.reduce((a, l) => a + l.bags, 0),
    totalContainers: new Set(
      input.lines.map((l) => l.containerNumber.trim()).filter((n) => n.length > 0),
    ).size,
  };
}

/**
 * One row per container.
 *
 * The client buys 60,000 KG in three containers and each container loads,
 * arrives and is received on its own day — so each needs its own row, with
 * its own lot, batch and container number. Splitting divides the quantity
 * and the bags evenly, in the row's own unit, with the rounding remainder on
 * the last row so the total is unchanged. The first row keeps the numbers
 * already typed; the copies start blank, because they belong to different
 * containers.
 */
export function splitLineIntoContainers(line: LineDraft, count: number): LineDraft[] {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return [line];
  const quantity = dec(line.quantity);
  const bags = dec(line.bags);
  const each = quantity.dividedBy(n).toDecimalPlaces(3, Decimal.ROUND_DOWN);
  const eachBags = bags.dividedBy(n).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  return Array.from({ length: n }, (_, index) => {
    const last = index === n - 1;
    const q = last ? quantity.minus(each.times(n - 1)) : each;
    const b = last ? bags.minus(eachBags.times(n - 1)) : eachBags;
    return {
      ...line,
      key: index === 0 ? line.key : crypto.randomUUID(),
      // The first keeps the saved row; the others are new containers.
      id: index === 0 ? line.id : undefined,
      quantity: quantity.isZero() ? '' : q.toString(),
      bags: bags.isZero() ? '' : b.toString(),
      lotNumber: index === 0 ? line.lotNumber : '',
      batchNumber: index === 0 ? line.batchNumber : '',
      containerNumber: index === 0 ? line.containerNumber : '',
    };
  });
}
