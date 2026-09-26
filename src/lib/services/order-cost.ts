import { prisma } from '@/lib/db';
import { Decimal, dec, sum, toMoney, toQuantity, toUnitCost, convertFromUsd, KG_PER_MT } from '@/lib/money';
import { getBatchCostings } from '@/lib/services/landed-cost';
import { getExpenseSettlements, type ExpensePaymentStatus } from '@/lib/services/expense-settlement';
import { getOrderFxTransactions, summariseFx, type FxPair, type FxTransaction } from '@/lib/services/shipment-fx';

/**
 * The costing of one shipment — the order it was bought on, with every
 * container, item and batch under it.
 *
 * The loading sheet keeps one shipment record per container so each can
 * carry its own ETA and B/L, and the old cost report offered one tab per
 * record: an order of three containers read as three shipments, and the
 * page said "5 shipments" where the client had two. The unit here is the
 * order (its ICUL/FID reference), and every figure is summed once from the
 * records that belong to it:
 *
 *   goods      Σ batch.purchaseCostUsd over the order's active batches
 *   expenses   every posted shipment expense booked to one of its records
 *   sales      every posted invoice line sold from one of its batches
 *
 * An expense belongs to exactly one record and a batch to exactly one
 * shipment, so nothing is counted twice however many children an order has.
 */

export type OrderCostLine = {
  batchId: string;
  batchNumber: string;
  itemName: string;
  lotNumber: string;
  containerNumber: string | null;
  shipmentId: string;
  orderedKg: Decimal;
  receivedKg: Decimal;
  soldKg: Decimal;
  /** Still owned: on the shelf plus what a draft invoice has set aside. */
  onHandKg: Decimal;
  purchaseUsd: Decimal;
  landedUsd: Decimal;
  landedPerKgUsd: Decimal;
  /** At the purchase's rate for the coffee and the costs' own rates for the costs. */
  landedLocal: Decimal;
  landedPerKgLocal: Decimal;
  warehouse: string | null;
  status: string;
};

export type OrderExpenseLine = {
  expenseId: string;
  expenseNumber: string;
  expenseDate: Date;
  category: string;
  memo: string | null;
  containerNumber: string | null;
  currency: string;
  amount: Decimal;
  amountUsd: Decimal;
  amountLocal: Decimal;
  capitalised: boolean;
  paid: boolean;
  payment: ExpensePaymentStatus;
  paidFrom: string | null;
};

export type OrderCostSheet = {
  contractId: string;
  contractReference: string;
  vendorName: string;
  /** The first record, for View and Costing links. */
  firstShipmentId: string;
  shipmentIds: string[];
  statuses: string[];
  items: string[];
  containers: number;
  localCurrency: string;
  rateLocalPerUsd: Decimal;
  orderedKg: Decimal;
  receivedKg: Decimal;
  soldKg: Decimal;
  remainingKg: Decimal;
  goodsUsd: Decimal;
  goodsLocal: Decimal;
  expenseUsd: Decimal;
  expenseLocal: Decimal;
  /** Only the expenses that went into the coffee's cost. */
  capitalisedExpenseUsd: Decimal;
  capitalisedExpenseLocal: Decimal;
  /**
   * Costs booked to this shipment that the client said not to add to stock —
   * they belong to the month, not the coffee. Kept out of the landed cost and
   * out of the cost per kilo, and taken off the profit once, below.
   */
  periodExpenseUsd: Decimal;
  periodExpenseLocal: Decimal;
  landedUsd: Decimal;
  landedLocal: Decimal;
  costPerKgUsd: Decimal;
  costPerKgLocal: Decimal;
  costPerMtUsd: Decimal;
  costPerMtLocal: Decimal;
  revenueUsd: Decimal;
  revenueLocal: Decimal;
  cogsUsd: Decimal;
  cogsLocal: Decimal;
  grossProfitUsd: Decimal;
  grossProfitLocal: Decimal;
  /** Gross profit less the costs that were not added to stock. */
  netProfitUsd: Decimal;
  netProfitLocal: Decimal;
  marginPct: Decimal;
  /** What the unsold coffee is carried at. */
  remainingValueUsd: Decimal;
  remainingValueLocal: Decimal;
  /**
   * One weighted rate per currency pair, from the transactions themselves:
   * the purchase and the capitalised costs for the landed cost, the invoices
   * for the sales. Each transaction keeps its own rate; these only describe
   * them together.
   */
  costFx: FxPair[];
  salesFx: FxPair[];
  fxCosts: FxTransaction[];
  fxSales: FxTransaction[];
  lines: OrderCostLine[];
  expenses: OrderExpenseLine[];
  byCategory: Array<{ category: string; capitalised: boolean; count: number; amountUsd: Decimal; amountLocal: Decimal }>;
};

export async function getOrderCostSheets(companyId: string): Promise<OrderCostSheet[]> {
  const [company, contracts] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { localCurrency: true } }),
    prisma.purchaseContract.findMany({
      where: { companyId, status: 'POSTED', shipments: { some: {} } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        contractReference: true,
        rateLocalPerUsd: true,
        vendor: { select: { vendorName: true } },
        shipments: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            status: true,
            batches: {
              where: { status: 'ACTIVE' },
              orderBy: { batchNumber: 'asc' },
              select: {
                id: true,
                batchNumber: true,
                containerId: true,
                orderedQuantityKg: true,
                receivedQuantityKg: true,
                soldQuantityKg: true,
                availableQuantityKg: true,
                allocatedQuantityKg: true,
                purchaseCostUsd: true,
                item: { select: { itemName: true } },
                lot: { select: { lotNumber: true } },
                container: { select: { containerNumber: true } },
                balances: { where: { onHandKg: { gt: 0 } }, select: { warehouse: { select: { name: true } } } },
              },
            },
          },
        },
      },
    }),
  ]);
  if (contracts.length === 0) return [];

  const shipmentIds = contracts.flatMap((c) => c.shipments.map((s) => s.id));

  const [expenses, sales, costings] = await Promise.all([
    prisma.expense.findMany({
      where: { companyId, shipmentId: { in: shipmentIds }, status: 'POSTED', kind: 'SHIPMENT' },
      include: {
        expenseCategory: { select: { name: true } },
        cashBankAccount: { select: { name: true } },
        container: { select: { containerNumber: true } },
        vendor: { select: { country: true } },
      },
      orderBy: [{ expenseDate: 'asc' }, { expenseNumber: 'asc' }],
    }),
    // Sales by the batch each line was sold from: a line belongs to one
    // batch and a batch to one shipment, so each sale counts once.
    /*
     * Sales by the batch they came from. Revenue in dirhams is at each
     * invoice's own rate. The cost of what sold is the batch's cost, and in
     * dirhams it is that cost at the rates it was incurred at — not the
     * sale's rate, which would make the landed cost in dirhams differ from
     * cost of sales plus the stock that is left.
     */
    prisma.$queryRaw<Array<{ batchId: string; shipmentId: string; revenueUsd: string; cogsUsd: string; revenueLocal: string }>>`
      SELECT b."id" AS "batchId", b."shipmentId",
             COALESCE(SUM(sil."lineTotalUsd"), 0)::text AS "revenueUsd",
             COALESCE(SUM(sil."costTotalUsd"), 0)::text AS "cogsUsd",
             COALESCE(SUM(sil."lineTotalUsd" * si."rateLocalPerUsd"), 0)::text AS "revenueLocal"
      FROM sales_invoice_lines sil
      JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
      JOIN batches b ON b."id" = sil."batchId"
      WHERE si."companyId" = ${companyId} AND si."status" = 'POSTED'
        AND b."shipmentId" = ANY(${shipmentIds})
      GROUP BY b."id", b."shipmentId"
    `,
    Promise.all(shipmentIds.map((shipmentId) => getBatchCostings({ companyId, shipmentId }))).then((all) =>
      new Map(all.flat().map((c) => [c.batchId, c])),
    ),
  ]);
  // Paid, partly paid or unpaid: the same answer as the expense list.
  const settlements = await getExpenseSettlements(companyId, expenses);

  const expensesByShipment = new Map<string, typeof expenses>();
  for (const e of expenses) {
    if (!e.shipmentId) continue;
    expensesByShipment.set(e.shipmentId, [...(expensesByShipment.get(e.shipmentId) ?? []), e]);
  }
  const fx = await getOrderFxTransactions(companyId, contracts.map((c) => c.id));

  return contracts.map((contract): OrderCostSheet => {
    const records = contract.shipments;
    const rateLocalPerUsd = dec(contract.rateLocalPerUsd);
    const local = company.localCurrency;

    const lines: OrderCostLine[] = records.flatMap((s) =>
      s.batches.map((b) => {
        const cost = costings.get(b.id);
        return {
          batchId: b.id,
          batchNumber: b.batchNumber,
          itemName: b.item.itemName,
          lotNumber: b.lot.lotNumber,
          containerNumber: b.container?.containerNumber ?? null,
          shipmentId: s.id,
          orderedKg: toQuantity(b.orderedQuantityKg),
          receivedKg: toQuantity(b.receivedQuantityKg),
          soldKg: toQuantity(b.soldQuantityKg),
          onHandKg: toQuantity(dec(b.availableQuantityKg).plus(dec(b.allocatedQuantityKg))),
          purchaseUsd: toMoney(b.purchaseCostUsd),
          landedUsd: cost ? toMoney(cost.landedUsd) : toMoney(b.purchaseCostUsd),
          landedPerKgUsd: cost ? toUnitCost(cost.landedPerKgUsd) : new Decimal(0),
          landedLocal: cost ? toMoney(cost.landedLocal) : convertFromUsd(toMoney(b.purchaseCostUsd), rateLocalPerUsd, local),
          landedPerKgLocal: cost ? toUnitCost(cost.landedPerKgLocal) : new Decimal(0),
          warehouse: [...new Set(b.balances.map((x) => x.warehouse.name))].join(', ') || null,
          status: s.status,
        };
      }),
    );

    const orderExpenses: OrderExpenseLine[] = records.flatMap((s) =>
      (expensesByShipment.get(s.id) ?? []).map((e) => {
        const settlement = settlements.get(e.id);
        return {
          expenseId: e.id,
          expenseNumber: e.expenseNumber,
          expenseDate: e.expenseDate,
          category: e.expenseCategory.name,
          memo: e.description,
          containerNumber: e.container?.containerNumber ?? null,
          currency: e.currency,
          amount: toMoney(e.amount),
          amountUsd: toMoney(e.amountUsd),
          amountLocal: toMoney(e.amountLocal),
          capitalised: e.capitaliseToLandedCost,
          paid: settlement?.status === 'PAID',
          payment: settlement?.status ?? 'UNPAID',
          paidFrom: settlement?.paidFrom ?? null,
        };
      }),
    );

    const byCategoryMap = new Map<string, OrderCostSheet['byCategory'][number]>();
    for (const e of orderExpenses) {
      const key = `${e.category}|${e.capitalised}`;
      const row = byCategoryMap.get(key) ?? { category: e.category, capitalised: e.capitalised, count: 0, amountUsd: dec(0), amountLocal: dec(0) };
      row.count += 1;
      row.amountUsd = toMoney(row.amountUsd.plus(e.amountUsd));
      row.amountLocal = toMoney(row.amountLocal.plus(e.amountLocal));
      byCategoryMap.set(key, row);
    }

    const orderedKg = toQuantity(sum(lines.map((l) => l.orderedKg)));
    const receivedKg = toQuantity(sum(lines.map((l) => l.receivedKg)));
    const soldKg = toQuantity(sum(lines.map((l) => l.soldKg)));
    const goodsUsd = toMoney(sum(lines.map((l) => l.purchaseUsd)));
    const goodsLocal = convertFromUsd(goodsUsd, rateLocalPerUsd, local);
    const expenseUsd = toMoney(sum(orderExpenses.map((e) => e.amountUsd)));
    const expenseLocal = toMoney(sum(orderExpenses.map((e) => e.amountLocal)));
    const capitalisedExpenseUsd = toMoney(sum(orderExpenses.filter((e) => e.capitalised).map((e) => e.amountUsd)));
    const capitalisedExpenseLocal = toMoney(sum(orderExpenses.filter((e) => e.capitalised).map((e) => e.amountLocal)));
    const periodExpenseUsd = toMoney(expenseUsd.minus(capitalisedExpenseUsd));
    const periodExpenseLocal = toMoney(expenseLocal.minus(capitalisedExpenseLocal));
    /*
     * The landed cost is the price paid the supplier plus the costs that were
     * capitalised onto the coffee — the same figure the batches carry, the
     * stock is valued at and cost of sales is drawn from. Adding every cost
     * booked to the shipment, including those marked as not going into stock,
     * gave a second landed cost that no other screen agreed with and a cost
     * per kilo above what the coffee is actually worth. Those costs are real:
     * they come off the profit below, once.
     */
    const landedUsd = toMoney(goodsUsd.plus(capitalisedExpenseUsd));
    const landedLocal = toMoney(goodsLocal.plus(capitalisedExpenseLocal));
    const basisKg = receivedKg.greaterThan(0) ? receivedKg : orderedKg;
    const perKg = (total: Decimal) => (basisKg.greaterThan(0) ? toUnitCost(total.dividedBy(basisKg)) : new Decimal(0));

    const mine = new Set(records.map((r) => r.id));
    const sold = sales.filter((s) => mine.has(s.shipmentId));
    const lineOf = new Map(lines.map((l) => [l.batchId, l]));
    const revenueUsd = toMoney(sum(sold.map((s) => dec(s.revenueUsd))));
    const cogsUsd = toMoney(sum(sold.map((s) => dec(s.cogsUsd))));
    const revenueLocal = toMoney(sum(sold.map((s) => dec(s.revenueLocal))));
    // Each batch's cost of sales at that batch's own blend of historical rates.
    const cogsLocal = toMoney(
      sum(
        sold.map((s) => {
          const line = lineOf.get(s.batchId);
          const blend = line && line.landedUsd.greaterThan(0) ? line.landedLocal.dividedBy(line.landedUsd) : rateLocalPerUsd;
          return dec(s.cogsUsd).times(blend);
        }),
      ),
    );
    const grossProfitUsd = toMoney(revenueUsd.minus(cogsUsd));
    /*
     * What is left is what the stock records hold, not received less sold.
     * The two agree until coffee is written off or lost, and then subtracting
     * gives a shipment stock nobody can find in a warehouse.
     */
    const remainingKg = toQuantity(sum(lines.map((l) => l.onHandKg)));
    const remainingValueUsd = toMoney(sum(lines.map((l) => l.landedPerKgUsd.times(l.onHandKg))));
    const remainingValueLocal = toMoney(sum(lines.map((l) => l.landedPerKgLocal.times(l.onHandKg))));
    const orderFx = fx.get(contract.id) ?? { costs: [], sales: [] };

    const allBatchesContainers = new Set(lines.map((l) => l.containerNumber).filter(Boolean));

    return {
      contractId: contract.id,
      contractReference: contract.contractReference,
      vendorName: contract.vendor.vendorName,
      firstShipmentId: records[0].id,
      shipmentIds: records.map((s) => s.id),
      statuses: records.map((s) => s.status),
      items: [...new Set(lines.map((l) => l.itemName))],
      containers: allBatchesContainers.size,
      localCurrency: local,
      rateLocalPerUsd,
      orderedKg,
      receivedKg,
      soldKg,
      remainingKg,
      goodsUsd,
      goodsLocal,
      expenseUsd,
      expenseLocal,
      capitalisedExpenseUsd,
      capitalisedExpenseLocal,
      periodExpenseUsd,
      periodExpenseLocal,
      landedUsd,
      landedLocal,
      costPerKgUsd: perKg(landedUsd),
      costPerKgLocal: perKg(landedLocal),
      costPerMtUsd: toUnitCost(perKg(landedUsd).times(KG_PER_MT)),
      costPerMtLocal: toUnitCost(perKg(landedLocal).times(KG_PER_MT)),
      revenueUsd,
      revenueLocal,
      cogsUsd,
      cogsLocal,
      grossProfitUsd,
      grossProfitLocal: toMoney(revenueLocal.minus(cogsLocal)),
      netProfitUsd: toMoney(grossProfitUsd.minus(periodExpenseUsd)),
      netProfitLocal: toMoney(revenueLocal.minus(cogsLocal).minus(periodExpenseLocal)),
      marginPct: revenueUsd.greaterThan(0) ? grossProfitUsd.dividedBy(revenueUsd).times(100).toDecimalPlaces(1) : new Decimal(0),
      remainingValueUsd,
      remainingValueLocal,
      costFx: summariseFx(orderFx.costs, local),
      salesFx: summariseFx(orderFx.sales, local),
      fxCosts: orderFx.costs,
      fxSales: orderFx.sales,
      lines,
      expenses: orderExpenses,
      byCategory: [...byCategoryMap.values()].sort((a, b) => a.category.localeCompare(b.category)),
    };
  });
}
