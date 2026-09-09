import {
  Decimal,
  toMoney,
  toUnitCost,
  toQuantity,
  quantityToKg,
  unitPriceToPricePerKg,
  allocateProportionally,
  convertToUsd,
  sum,
  type EntryUnit,
} from '@/lib/money';
import { BusinessRuleError } from '@/lib/errors';
import type { ContainerType, Incoterm } from '@/lib/enums';

/**
 * Purchase contract arithmetic.
 *
 * This lives apart from `services/purchase.ts` deliberately: it depends only on
 * the decimal library, so the entry form can run the identical calculation in
 * the browser that the posting engine runs on the server. One implementation,
 * no chance of the preview disagreeing with what is saved.
 */

export type PurchaseLineInput = {
  itemId: string;
  /** Supplier traceability. Both are mandatory — coffee is always lot-traced. */
  lotNumber: string;
  batchNumber: string;
  containerNumber?: string | null;
  containerType?: ContainerType;
  quantity: string | number;
  unit: EntryUnit;
  unitPrice: string | number;
  bags?: number;
  bagWeightKg?: string | number;
  notes?: string | null;
};

export type PurchaseContractInput = {
  companyId: string;
  contractReference: string;
  supplierContractNo?: string | null;
  contractDate: Date;
  vendorId: string;
  origin?: string | null;
  currency: string;
  rateToUsd: string | number;
  rateLocalPerUsd: string | number;
  freightAmount: string | number;
  otherCharges?: string | number;
  incoterm?: Incoterm;
  portOfLoading?: string | null;
  destination?: string | null;
  expectedShipmentDate?: Date | null;
  paymentTermDays?: number;
  notes?: string | null;
  lines: PurchaseLineInput[];
};

type ComputedLine = {
  lineNumber: number;
  itemId: string;
  lotNumber: string;
  batchNumber: string;
  containerNumber: string | null;
  containerType: ContainerType;
  quantity: Decimal;
  unit: EntryUnit;
  quantityKg: Decimal;
  bags: number;
  bagWeightKg: Decimal;
  unitPrice: Decimal;
  unitPriceKg: Decimal;
  lineSubtotal: Decimal;
  freightAllocated: Decimal;
  otherChargesAllocated: Decimal;
  lineTotal: Decimal;
  unitCostKg: Decimal;
  containers: number;
  notes: string | null;
};

/**
 * Pure calculation, extracted so it can be unit-tested without a database.
 *
 * Freight and other direct contract charges are spread across the lines in
 * proportion to line value and folded into the cost per kilogram. That is what
 * makes them flow through to cost of goods sold — and therefore to gross margin
 * — exactly once. See docs/ARCHITECTURE.md §Landed cost.
 */
export function computePurchaseTotals(input: {
  lines: PurchaseLineInput[];
  freightAmount: string | number;
  otherCharges?: string | number;
  currency: string;
  rateToUsd: string | number;
}) {
  if (input.lines.length === 0) {
    throw new BusinessRuleError('A purchase contract needs at least one line.');
  }

  const seenBatches = new Set<string>();

  const base = input.lines.map((line, index) => {
    const quantity = toQuantity(line.quantity);
    const unitPrice = toUnitCost(line.unitPrice);

    if (quantity.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(`Line ${index + 1}: quantity must be greater than zero.`);
    }
    if (unitPrice.lessThan(0)) {
      throw new BusinessRuleError(`Line ${index + 1}: price cannot be negative.`);
    }
    if (!line.lotNumber?.trim()) {
      throw new BusinessRuleError(`Line ${index + 1}: a lot number is required for traceability.`);
    }
    if (!line.batchNumber?.trim()) {
      throw new BusinessRuleError(`Line ${index + 1}: a batch number is required for traceability.`);
    }

    const batchKey = line.batchNumber.trim().toUpperCase();
    if (seenBatches.has(batchKey)) {
      throw new BusinessRuleError(`Batch number "${line.batchNumber}" is used on more than one line.`);
    }
    seenBatches.add(batchKey);

    const bagWeightKg = toQuantity(line.bagWeightKg ?? 60);
    const quantityKg = quantityToKg(quantity, line.unit, bagWeightKg);
    // If bags were not entered, derive them from the nominal bag weight so the
    // bag count is never silently zero on a bagged coffee contract.
    const bags =
      line.bags ??
      (line.unit === 'BAG'
        ? Number(quantity.toFixed(0))
        : bagWeightKg.greaterThan(0)
          ? Number(quantityKg.dividedBy(bagWeightKg).toFixed(0))
          : 0);

    return {
      lineNumber: index + 1,
      itemId: line.itemId,
      lotNumber: line.lotNumber.trim(),
      batchNumber: line.batchNumber.trim(),
      containerNumber: line.containerNumber?.trim() || null,
      containerType: line.containerType ?? ('FT20' as ContainerType),
      quantity,
      unit: line.unit,
      quantityKg,
      bags,
      bagWeightKg,
      unitPrice,
      unitPriceKg: unitPriceToPricePerKg(unitPrice, line.unit, bagWeightKg),
      lineSubtotal: toMoney(quantity.times(unitPrice)),
      containers: line.containerNumber?.trim() ? 1 : 0,
      notes: line.notes ?? null,
    };
  });

  const freightAmount = toMoney(input.freightAmount);
  const otherCharges = toMoney(input.otherCharges ?? 0);
  if (freightAmount.isNegative()) throw new BusinessRuleError('Freight cannot be negative.');
  if (otherCharges.isNegative()) throw new BusinessRuleError('Other direct charges cannot be negative.');

  const weights = base.map((l) => l.lineSubtotal);
  const freightSplit = allocateProportionally(freightAmount, weights);
  const otherSplit = allocateProportionally(otherCharges, weights);

  const lines: ComputedLine[] = base.map((l, i) => {
    const lineTotal = toMoney(l.lineSubtotal.plus(freightSplit[i]).plus(otherSplit[i]));
    return {
      ...l,
      freightAllocated: freightSplit[i],
      otherChargesAllocated: otherSplit[i],
      lineTotal,
      unitCostKg: toUnitCost(lineTotal.dividedBy(l.quantityKg)),
    };
  });

  const subtotal = toMoney(sum(lines.map((l) => l.lineSubtotal)));
  const totalValue = toMoney(subtotal.plus(freightAmount).plus(otherCharges));

  return {
    lines,
    subtotal,
    freightAmount,
    otherCharges,
    totalValue,
    totalValueUsd: convertToUsd(totalValue, input.rateToUsd, input.currency),
    totalQuantityKg: toQuantity(sum(lines.map((l) => l.quantityKg))),
    totalBags: lines.reduce((acc, l) => acc + l.bags, 0),
    totalContainers: new Set(lines.map((l) => l.containerNumber).filter(Boolean)).size,
  };
}

