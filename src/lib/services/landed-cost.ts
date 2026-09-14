import type { Tx } from '@/lib/db';
import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney, toUnitCost, allocateProportionally, sum, toQuantity } from '@/lib/money';
import { BusinessRuleError } from '@/lib/errors';
import { lockBatch } from '@/lib/services/inventory';

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
 *      inventory to COGS, and written back onto the sales invoice lines that
 *      sold the coffee, so the general ledger and every margin report keep
 *      agreeing with each other.
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
  /** Portion capitalised into coffee sitting in a warehouse. */
  capitalisedUsd: Decimal;
  /** Portion capitalised into coffee still on the water. */
  inTransitUsd: Decimal;
  newLandedUnitCostUsd: Decimal;
};

export type LandedCostResult = {
  allocations: LandedCostAllocation[];
  totalAllocatedUsd: Decimal;
  totalTrueUpUsd: Decimal;
  /** Into the Inventory account: the share of coffee that has landed. */
  totalCapitalisedUsd: Decimal;
  /** Into Inventory In Transit: the share of coffee not yet received. */
  totalInTransitUsd: Decimal;
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

  for (const id of [...batches.map((b) => b.id)].sort()) {
    await lockBatch(tx, params.companyId, id);
  }

  const locked = await tx.batch.findMany({
    where: { id: { in: batches.map((b) => b.id) } },
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

  // Allocation basis is the ordered quantity: freight and clearing cover the
  // whole shipment, whether or not every container has landed yet.
  const weights = locked.map((b) => dec(b.orderedQuantityKg));
  const totalOrdered = sum(weights);
  if (totalOrdered.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('This job has no ordered quantity to spread the cost over.');
  }

  const split = allocateProportionally(amountUsd, weights);
  const allocations: LandedCostAllocation[] = [];

  for (let i = 0; i < locked.length; i += 1) {
    const batch = locked[i];
    const allocatedUsd = split[i];
    if (allocatedUsd.isZero()) continue;

    const orderedKg = dec(batch.orderedQuantityKg);
    const soldKg = dec(batch.soldQuantityKg);
    const receivedKg = dec(batch.receivedQuantityKg);

    // Three destinations, in proportion to kilograms: what has been sold goes
    // to cost of sales, what is still on the water stays in transit, and the
    // rest is the coffee on the shelf. A cost booked while only some
    // containers have landed must not value the shelf at what the whole
    // shipment cost — the receipt of the remaining containers moves their
    // share across when they arrive.
    const trueUpUsd = toMoney(allocatedUsd.times(soldKg).dividedBy(orderedKg));
    const inTransitKg = Decimal.max(orderedKg.minus(receivedKg), 0);
    const inTransitUsd = toMoney(allocatedUsd.times(inTransitKg).dividedBy(orderedKg));
    const capitalisedUsd = toMoney(allocatedUsd.minus(trueUpUsd).minus(inTransitUsd));

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
      inTransitUsd,
      newLandedUnitCostUsd,
    });

    if (!trueUpUsd.isZero()) {
      await restateSoldCost(tx, {
        companyId: params.companyId,
        batchId: batch.id,
        trueUpUsd,
      });
    }
  }

  return {
    allocations,
    totalAllocatedUsd: toMoney(sum(allocations.map((a) => a.allocatedUsd))),
    totalTrueUpUsd: toMoney(sum(allocations.map((a) => a.trueUpUsd))),
    totalCapitalisedUsd: toMoney(sum(allocations.map((a) => a.capitalisedUsd))),
    totalInTransitUsd: toMoney(sum(allocations.map((a) => a.inTransitUsd))),
    allInTransit: batches.every((b) => dec(b.receivedQuantityKg).lessThanOrEqualTo(0)),
  };
}

/**
 * Pushes a batch's true-up into the documents that sold the coffee.
 *
 * The general ledger gets the true-up as one journal line, but every margin
 * figure in the system is read from the cost stored on the sales invoice line
 * — profit by customer, by item, by container, and the company summary that
 * the P&L is cross-checked against. Leaving those at the cost frozen at
 * posting time makes a late freight invoice raise cost of goods sold in the
 * ledger while gross profit in the reports stays where it was.
 *
 * The share is spread over what actually stayed sold: invoice lines add to the
 * basis, returns on a customer credit note take away from it, which is the
 * same net quantity the true-up itself was calculated from. Restating the
 * credit note too keeps a return valued at the same rate as the sale it
 * reverses.
 *
 * Costs move, prices do not. Nothing the customer sees is touched.
 */
async function restateSoldCost(
  tx: Tx,
  params: { companyId: string; batchId: string; trueUpUsd: Decimal },
): Promise<void> {
  const [invoiceLines, creditLines] = await Promise.all([
    tx.salesInvoiceLine.findMany({
      where: { batchId: params.batchId, salesInvoice: { companyId: params.companyId, status: 'POSTED' } },
      select: { id: true, salesInvoiceId: true, quantityKg: true, costTotalUsd: true },
      orderBy: { id: 'asc' },
    }),
    tx.creditNoteLine.findMany({
      where: {
        batchId: params.batchId,
        creditNote: { companyId: params.companyId, status: 'POSTED', type: 'CUSTOMER' },
      },
      select: { id: true, creditNoteId: true, quantityKg: true, costTotalUsd: true },
      orderBy: { id: 'asc' },
    }),
  ]);

  if (invoiceLines.length === 0) return;

  const weights = [
    ...invoiceLines.map((line) => dec(line.quantityKg)),
    ...creditLines.map((line) => dec(line.quantityKg).negated()),
  ];

  // The net sold quantity is what the true-up was derived from. If it has gone
  // to nothing there is no sale left to carry the cost, so leave the documents
  // alone rather than inventing a rate.
  if (sum(weights).lessThanOrEqualTo(0)) return;

  const shares = allocateProportionally(params.trueUpUsd, weights);
  const invoiceTotals = new Map<string, Decimal>();
  const creditTotals = new Map<string, Decimal>();

  for (let i = 0; i < invoiceLines.length; i += 1) {
    const line = invoiceLines[i];
    const share = shares[i];
    if (share.isZero()) continue;

    const quantityKg = dec(line.quantityKg);
    const costTotalUsd = toMoney(dec(line.costTotalUsd).plus(share));

    await tx.salesInvoiceLine.update({
      where: { id: line.id },
      data: {
        costTotalUsd,
        ...(quantityKg.greaterThan(0) ? { unitCostUsd: toUnitCost(costTotalUsd.dividedBy(quantityKg)) } : {}),
      },
    });

    invoiceTotals.set(
      line.salesInvoiceId,
      (invoiceTotals.get(line.salesInvoiceId) ?? new Decimal(0)).plus(share),
    );
  }

  for (let i = 0; i < creditLines.length; i += 1) {
    const line = creditLines[i];
    // The weight was negated so the basis nets out; the credit note's own cost
    // still moves in the same direction as the sale it reverses.
    const share = shares[invoiceLines.length + i].negated();
    if (share.isZero()) continue;

    await tx.creditNoteLine.update({
      where: { id: line.id },
      data: { costTotalUsd: toMoney(dec(line.costTotalUsd).plus(share)) },
    });

    creditTotals.set(line.creditNoteId, (creditTotals.get(line.creditNoteId) ?? new Decimal(0)).plus(share));
  }

  for (const [salesInvoiceId, delta] of invoiceTotals) {
    const invoice = await tx.salesInvoice.findUniqueOrThrow({
      where: { id: salesInvoiceId },
      select: { costOfGoodsUsd: true },
    });
    await tx.salesInvoice.update({
      where: { id: salesInvoiceId },
      data: { costOfGoodsUsd: toMoney(dec(invoice.costOfGoodsUsd).plus(delta)) },
    });
  }

  for (const [creditNoteId, delta] of creditTotals) {
    const note = await tx.creditNote.findUniqueOrThrow({
      where: { id: creditNoteId },
      select: { costOfGoodsUsd: true },
    });
    await tx.creditNote.update({
      where: { id: creditNoteId },
      data: { costOfGoodsUsd: toMoney(dec(note.costOfGoodsUsd).plus(delta)) },
    });
  }
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

export type ShipmentCostLine = {
  expenseId: string;
  expenseNumber: string;
  category: string;
  amountUsd: Decimal;
  amount: Decimal;
  currency: string;
  capitalised: boolean;
  paid: boolean;
};

/** The costing / profitability sheet for one consignment. */
export async function getShipmentCostSheet(companyId: string, shipmentId: string) {
  const job = await getJobCostSummary(prisma as Tx, companyId, shipmentId);

  const expenses = await prisma.expense.findMany({
    where: { companyId, shipmentId, status: 'POSTED', kind: 'SHIPMENT' },
    include: { expenseCategory: { select: { name: true } } },
    orderBy: [{ expenseDate: 'asc' }, { expenseNumber: 'asc' }],
  });

  const lines: ShipmentCostLine[] = expenses.map((expense) => ({
    expenseId: expense.id,
    expenseNumber: expense.expenseNumber,
    category: expense.expenseCategory.name,
    amountUsd: toMoney(expense.amountUsd),
    amount: toMoney(expense.amount),
    currency: expense.currency,
    capitalised: expense.capitaliseToLandedCost,
    paid: Boolean(expense.cashBankAccountId),
  }));

  const expenseUsd = toMoney(sum(lines.map((line) => line.amountUsd)));
  const totalShipmentCostUsd = toMoney(job.goodsUsd.plus(expenseUsd));
  const receivedKg = toQuantity(job.receivedKg);
  const basisKg = receivedKg.greaterThan(0) ? receivedKg : toQuantity(job.orderedKg);

  const invoices = await prisma.salesInvoice.findMany({
    where: { companyId, shipmentId, status: 'POSTED' },
    select: { subtotalUsd: true, costOfGoodsUsd: true },
  });
  const revenueUsd = toMoney(sum(invoices.map((invoice) => dec(invoice.subtotalUsd))));
  const cogsUsd = toMoney(sum(invoices.map((invoice) => dec(invoice.costOfGoodsUsd))));
  const grossProfitUsd = toMoney(revenueUsd.minus(cogsUsd));
  const soldKg = toQuantity(job.soldKg);

  return {
    goodsUsd: job.goodsUsd,
    capitalisedUsd: job.capitalisedUsd,
    expenseUsd,
    totalShipmentCostUsd,
    orderedKg: toQuantity(job.orderedKg),
    receivedKg,
    soldKg,
    costPerKgUsd: basisKg.greaterThan(0) ? toUnitCost(totalShipmentCostUsd.dividedBy(basisKg)) : new Decimal(0),
    revenueUsd,
    cogsUsd,
    grossProfitUsd,
    profitPerKgUsd: soldKg.greaterThan(0) ? toUnitCost(grossProfitUsd.dividedBy(soldKg)) : new Decimal(0),
    profitPct: revenueUsd.greaterThan(0) ? grossProfitUsd.dividedBy(revenueUsd).times(100) : new Decimal(0),
    lines,
  };
}
