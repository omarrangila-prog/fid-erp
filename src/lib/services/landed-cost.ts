import type { Tx } from '@/lib/db';
import { Decimal, dec, toMoney, toUnitCost, allocateProportionally, sum } from '@/lib/money';
import { BusinessRuleError } from '@/lib/errors';

/**
 * Landed cost engine.
 *
 * The cost of a kilogram of coffee is not what the supplier charged for it. It
 * is the goods value plus every direct cost of getting it to the warehouse:
 * ocean freight, insurance, customs, clearing, port charges, inland transport,
 * documentation, labour, inspection. Those costs arrive weeks after the
 * purchase, so landed cost has to be applied retroactively.
 *
 *   landed cost per KG = (goods value + capitalised costs) / ordered KG
 *
 * Two things happen when a direct cost is capitalised against a job:
 *
 *   1. The cost is spread across the job's batches in proportion to quantity,
 *      raising each batch's landed unit cost. Coffee still in stock is now
 *      carried at the higher value, which is what the Balance Sheet should show.
 *
 *   2. For coffee already sold, the extra cost belongs in cost of goods sold,
 *      not in inventory. That portion is "trued up": moved straight from
 *      inventory to COGS so the general ledger keeps agreeing with the
 *      quantity-based profitability figures.
 *
 * Without step 2 a late freight invoice would inflate the inventory asset for
 * coffee that had already left the warehouse.
 */

export type LandedCostAllocation = {
  batchId: string;
  batchNumber: string;
  allocatedUsd: Decimal;
  /** Portion relating to already-sold coffee, moved to cost of goods sold. */
  trueUpUsd: Decimal;
  /** Portion that stays capitalised in inventory. */
  capitalisedUsd: Decimal;
  newLandedUnitCostUsd: Decimal;
};

export type LandedCostResult = {
  allocations: LandedCostAllocation[];
  totalAllocatedUsd: Decimal;
  totalTrueUpUsd: Decimal;
  totalCapitalisedUsd: Decimal;
  /** True when none of the job's coffee has landed in a warehouse yet. */
  allInTransit: boolean;
};

/**
 * Spreads `amountUsd` across the batches of one job and updates their landed
 * cost. Pass a negative amount to unwind a reversed expense.
 */
export async function applyLandedCost(
  tx: Tx,
  params: {
    companyId: string;
    shipmentId: string;
    amountUsd: Decimal | string | number;
    reference: string;
  },
): Promise<LandedCostResult> {
  const amountUsd = toMoney(params.amountUsd);

  const batches = await tx.batch.findMany({
    where: { companyId: params.companyId, shipmentId: params.shipmentId, status: 'ACTIVE' },
    select: {
      id: true,
      batchNumber: true,
      orderedQuantityKg: true,
      receivedQuantityKg: true,
      soldQuantityKg: true,
      purchaseCostUsd: true,
      capitalisedCostUsd: true,
    },
    orderBy: { batchNumber: 'asc' },
  });

  if (batches.length === 0) {
    throw new BusinessRuleError(
      'This job has no coffee batches, so a direct shipment cost cannot be capitalised against it.',
    );
  }

  // Allocation basis is the ordered quantity: freight and clearing cover the
  // whole shipment, whether or not every container has landed yet.
  const weights = batches.map((b) => dec(b.orderedQuantityKg));
  const totalOrdered = sum(weights);
  if (totalOrdered.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('This job has no ordered quantity to spread the cost over.');
  }

  const split = allocateProportionally(amountUsd, weights);
  const allocations: LandedCostAllocation[] = [];

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const allocatedUsd = split[i];
    if (allocatedUsd.isZero()) continue;

    const orderedKg = dec(batch.orderedQuantityKg);
    const soldKg = dec(batch.soldQuantityKg);

    // The share of this allocation attributable to coffee already sold.
    const soldRatio = orderedKg.greaterThan(0) ? soldKg.dividedBy(orderedKg) : new Decimal(0);
    const trueUpUsd = toMoney(allocatedUsd.times(soldRatio));
    const capitalisedUsd = toMoney(allocatedUsd.minus(trueUpUsd));

    const newCapitalisedTotal = toMoney(dec(batch.capitalisedCostUsd).plus(allocatedUsd));
    const newLandedUnitCostUsd = toUnitCost(
      dec(batch.purchaseCostUsd).plus(newCapitalisedTotal).dividedBy(orderedKg),
    );

    await tx.batch.update({
      where: { id: batch.id },
      data: {
        capitalisedCostUsd: newCapitalisedTotal,
        landedUnitCostUsd: newLandedUnitCostUsd,
      },
    });

    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      allocatedUsd,
      trueUpUsd,
      capitalisedUsd,
      newLandedUnitCostUsd,
    });
  }

  return {
    allocations,
    totalAllocatedUsd: toMoney(sum(allocations.map((a) => a.allocatedUsd))),
    totalTrueUpUsd: toMoney(sum(allocations.map((a) => a.trueUpUsd))),
    totalCapitalisedUsd: toMoney(sum(allocations.map((a) => a.capitalisedUsd))),
    allInTransit: batches.every((b) => dec(b.receivedQuantityKg).lessThanOrEqualTo(0)),
  };
}

/** Landed cost summary for one job, used by the shipment costing screen. */
export async function getJobCostSummary(tx: Tx, companyId: string, shipmentId: string) {
  const rows = await tx.$queryRaw<
    Array<{
      goodsUsd: string;
      capitalisedUsd: string;
      orderedKg: string;
      receivedKg: string;
      soldKg: string;
      bags: string;
    }>
  >`
    SELECT
      COALESCE(SUM(b."purchaseCostUsd"), 0)::text    AS "goodsUsd",
      COALESCE(SUM(b."capitalisedCostUsd"), 0)::text AS "capitalisedUsd",
      COALESCE(SUM(b."orderedQuantityKg"), 0)::text  AS "orderedKg",
      COALESCE(SUM(b."receivedQuantityKg"), 0)::text AS "receivedKg",
      COALESCE(SUM(b."soldQuantityKg"), 0)::text     AS "soldKg",
      COALESCE(SUM(b."orderedBags"), 0)::text        AS bags
    FROM batches b
    WHERE b."companyId" = ${companyId} AND b."shipmentId" = ${shipmentId} AND b."status" = 'ACTIVE'
  `;

  const row = rows[0];
  const goodsUsd = toMoney(row?.goodsUsd ?? 0);
  const capitalisedUsd = toMoney(row?.capitalisedUsd ?? 0);
  const totalLandedUsd = toMoney(goodsUsd.plus(capitalisedUsd));
  const orderedKg = dec(row?.orderedKg ?? 0);
  const bags = Number(row?.bags ?? 0);

  return {
    goodsUsd,
    capitalisedUsd,
    totalLandedUsd,
    orderedKg,
    receivedKg: dec(row?.receivedKg ?? 0),
    soldKg: dec(row?.soldKg ?? 0),
    bags,
    landedCostPerKgUsd: orderedKg.greaterThan(0) ? toUnitCost(totalLandedUsd.dividedBy(orderedKg)) : new Decimal(0),
    landedCostPerBagUsd: bags > 0 ? toMoney(totalLandedUsd.dividedBy(bags)) : new Decimal(0),
  };
}
