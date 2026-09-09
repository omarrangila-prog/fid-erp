import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney, toQuantity } from '@/lib/money';
import { getFinancialPosition } from '@/lib/services/reports';
import { getCompanyProfitSummary, getMonthlyProfitability } from '@/lib/services/profitability';
import { getReceivables, getPayables, summariseAgeing } from '@/lib/services/receivables';
import { SHIPMENT_STATUSES_IN_TRANSIT } from '@/lib/constants';

/**
 * Dashboard aggregation.
 *
 * Everything on the dashboard is a live query. The point of the screen is to
 * answer the practical questions — how much cash, how much stock, who owes me,
 * what is my profit — in one look, so the figures are grouped the way a person
 * would ask for them rather than the way the ledger stores them.
 */

export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;

/**
 * The last dozen documents of any kind, newest first.
 *
 * A trader opening the dashboard wants to see that this morning's work landed,
 * without hunting through five separate lists — so invoices, receipts, payments,
 * expenses, goods receipts and transfers are gathered into one stream.
 */
export async function getRecentActivity(companyId: string, limit = 6) {
  return prisma.$queryRaw<
    Array<{ date: Date; kind: string; reference: string; party: string; amount: string; currency: string; status: string; href: string }>
  >`
    SELECT si."invoiceDate" AS date, 'Invoice' AS kind, si."invoiceNumber" AS reference,
           c."customerName" AS party, si."totalAmount"::text AS amount, si."currency",
           si."status"::text AS status, '/sales/' || si."id" AS href
      FROM sales_invoices si JOIN customers c ON c."id" = si."customerId"
     WHERE si."companyId" = ${companyId}
    UNION ALL
    SELECT r."receiptDate", 'Receipt', r."receiptNumber", c."customerName",
           r."amount"::text, r."currency", r."status"::text, '/finance/receipts/' || r."id"
      FROM receipts r JOIN customers c ON c."id" = r."customerId"
     WHERE r."companyId" = ${companyId}
    UNION ALL
    SELECT p."paymentDate", 'Payment', p."paymentNumber", v."vendorName",
           p."amount"::text, p."currency", p."status"::text, '/finance/payments/' || p."id"
      FROM payments p JOIN vendors v ON v."id" = p."vendorId"
     WHERE p."companyId" = ${companyId}
    UNION ALL
    SELECT e."expenseDate", 'Expense', e."expenseNumber", ec."name",
           e."amount"::text, e."currency", e."status"::text, '/finance/expenses/' || e."id"
      FROM expenses e JOIN expense_categories ec ON ec."id" = e."expenseCategoryId"
     WHERE e."companyId" = ${companyId}
    UNION ALL
    SELECT gr."receiptDate", 'Goods Receipt', gr."grnNumber", w."name",
           COALESCE((SELECT SUM(grl."quantityKg") FROM goods_receipt_lines grl
                      WHERE grl."goodsReceiptId" = gr."id"), 0)::text,
           'KG', gr."status"::text, '/goods-receipts'
      FROM goods_receipts gr JOIN warehouses w ON w."id" = gr."warehouseId"
     WHERE gr."companyId" = ${companyId}
    ORDER BY date DESC
    LIMIT ${limit}`;
}

/**
 * Batches running low, so somebody can chase a replacement before a customer
 * asks for coffee that is not there.
 */
export async function getLowStock(companyId: string, thresholdKg = 5000, limit = 5) {
  return prisma.$queryRaw<
    Array<{ itemName: string; warehouseName: string; warehouseCode: string; batchNumber: string; availableKg: string }>
  >`
    SELECT ci."itemName", w."name" AS "warehouseName", w."code" AS "warehouseCode",
           b."batchNumber", ib."onHandKg"::text AS "availableKg"
      FROM inventory_balances ib
      JOIN batches b ON b."id" = ib."batchId"
      JOIN coffee_items ci ON ci."id" = b."itemId"
      JOIN warehouses w ON w."id" = ib."warehouseId"
     WHERE ib."companyId" = ${companyId} AND ib."onHandKg" > 0 AND ib."onHandKg" <= ${thresholdKg}
     ORDER BY ib."onHandKg" ASC
     LIMIT ${limit}`;
}

export async function getDashboard(params: { companyId: string; from?: Date; to?: Date }) {
  const [position, profit, receivables, payables, monthly, shipments, warehouseStock, itemStock, alerts] =
    await Promise.all([
      getFinancialPosition({ companyId: params.companyId }),
      getCompanyProfitSummary({ companyId: params.companyId, from: params.from, to: params.to }),
      getReceivables({ companyId: params.companyId, onlyOutstanding: true }),
      getPayables({ companyId: params.companyId, onlyOutstanding: true }),
      getMonthlyProfitability({ companyId: params.companyId, months: 12 }),
      getShipmentCounts(params.companyId),
      getWarehouseStock(params.companyId),
      getTopItemStock(params.companyId),
      prisma.notification.count({ where: { companyId: params.companyId, readAt: null } }),
    ]);

  const today = new Date();
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  const overdue = receivables.filter((r) => r.dueDate && r.dueDate.getTime() < startOfToday);
  const dueToday = receivables.filter((r) => r.dueDate && r.dueDate.getTime() === startOfToday);
  const dueSoon = receivables.filter(
    (r) =>
      r.dueDate &&
      r.dueDate.getTime() > startOfToday &&
      r.dueDate.getTime() <= startOfToday + 7 * 86_400_000,
  );

  const overdueByCustomer = new Map<string, { customerId: string; customerName: string; amountUsd: Decimal }>();
  for (const row of overdue) {
    const entry = overdueByCustomer.get(row.customerId) ?? {
      customerId: row.customerId,
      customerName: row.customerName,
      amountUsd: new Decimal(0),
    };
    entry.amountUsd = entry.amountUsd.plus(row.outstandingAmountUsd);
    overdueByCustomer.set(row.customerId, entry);
  }

  return {
    position,
    profit,
    monthly,
    shipments,
    warehouseStock,
    itemStock,
    unreadAlerts: alerts,
    receivables: {
      totalUsd: toMoney(receivables.reduce((a, r) => a.plus(r.outstandingAmountUsd), new Decimal(0))),
      overdueUsd: toMoney(overdue.reduce((a, r) => a.plus(r.outstandingAmountUsd), new Decimal(0))),
      dueTodayUsd: toMoney(dueToday.reduce((a, r) => a.plus(r.outstandingAmountUsd), new Decimal(0))),
      dueSoonUsd: toMoney(dueSoon.reduce((a, r) => a.plus(r.outstandingAmountUsd), new Decimal(0))),
      overdueCount: overdue.length,
      ageing: summariseAgeing(receivables),
      topOverdue: [...overdueByCustomer.values()]
        .sort((a, b) => (b.amountUsd.greaterThan(a.amountUsd) ? 1 : -1))
        .slice(0, 5),
    },
    payables: {
      totalUsd: toMoney(payables.reduce((a, p) => a.plus(p.outstandingAmountUsd), new Decimal(0))),
      ageing: summariseAgeing(payables),
      count: payables.length,
    },
  };
}

async function getShipmentCounts(companyId: string) {
  const rows = await prisma.$queryRaw<Array<{ status: string; count: bigint; quantityKg: string; containers: string }>>`
    SELECT s."status"::text AS status, COUNT(*) AS count,
           COALESCE(SUM(s."quantityKg"), 0)::text AS "quantityKg",
           COALESCE(SUM(s."containers"), 0)::text AS containers
    FROM shipments s
    JOIN purchase_contracts pc ON pc."id" = s."purchaseContractId"
    WHERE s."companyId" = ${companyId} AND pc."status" = 'POSTED'
    GROUP BY s."status"
  `;

  const upcoming = await prisma.shipment.findMany({
    where: {
      companyId,
      purchaseContract: { status: 'POSTED' },
      status: { in: SHIPMENT_STATUSES_IN_TRANSIT as never },
      etaDate: { not: null, gte: new Date(Date.now() - 86_400_000) },
    },
    select: {
      id: true,
      shipmentNumber: true,
      jobNumber: true,
      etaDate: true,
      status: true,
      quantityKg: true,
      containers: true,
      item: { select: { itemName: true } },
      vendor: { select: { vendorName: true } },
    },
    orderBy: { etaDate: 'asc' },
    take: 8,
  });

  const byStatus = Object.fromEntries(
    rows.map((r) => [r.status, { count: Number(r.count), quantityKg: toQuantity(r.quantityKg), containers: Number(r.containers) }]),
  );

  const active = rows
    .filter((r) => r.status !== 'CLOSED' && r.status !== 'DELIVERED')
    .reduce((a, r) => a + Number(r.count), 0);

  return {
    byStatus,
    activeCount: active,
    totalContainers: rows.reduce((a, r) => a + Number(r.containers), 0),
    upcoming: upcoming.map((s) => ({
      id: s.id,
      shipmentNumber: s.shipmentNumber,
      jobNumber: s.jobNumber,
      etaDate: s.etaDate,
      status: s.status,
      quantityKg: toQuantity(s.quantityKg),
      containers: s.containers,
      itemName: s.item.itemName,
      vendorName: s.vendor.vendorName,
    })),
  };
}

/** Stock per warehouse — the "where is it?" answer. */
export async function getWarehouseStock(companyId: string) {
  const rows = await prisma.$queryRaw<
    Array<{ warehouseId: string; code: string; name: string; onHandKg: string; availableKg: string; bags: string; valueUsd: string }>
  >`
    SELECT w."id" AS "warehouseId", w."code", w."name",
           COALESCE(SUM(ib."onHandKg"), 0)::text    AS "onHandKg",
           COALESCE(SUM(ib."availableKg"), 0)::text AS "availableKg",
           COALESCE(SUM(ib."bags"), 0)::text        AS bags,
           COALESCE(SUM(ib."onHandKg" * b."landedUnitCostUsd"), 0)::text AS "valueUsd"
    FROM warehouses w
    LEFT JOIN inventory_balances ib ON ib."warehouseId" = w."id"
    LEFT JOIN batches b ON b."id" = ib."batchId"
    WHERE w."companyId" = ${companyId} AND w."status" = 'ACTIVE'
    GROUP BY w."id", w."code", w."name"
    ORDER BY w."name"
  `;

  return rows.map((r) => ({
    warehouseId: r.warehouseId,
    code: r.code,
    name: r.name,
    onHandKg: toQuantity(r.onHandKg),
    availableKg: toQuantity(r.availableKg),
    bags: Number(r.bags),
    valueUsd: toMoney(r.valueUsd),
  }));
}

async function getTopItemStock(companyId: string) {
  const rows = await prisma.$queryRaw<
    Array<{ itemId: string; itemName: string; originCountry: string; availableKg: string; valueUsd: string }>
  >`
    SELECT ci."id" AS "itemId", ci."itemName", ci."originCountry",
           COALESCE(SUM(b."availableQuantityKg"), 0)::text AS "availableKg",
           COALESCE(SUM(b."availableQuantityKg" * b."landedUnitCostUsd"), 0)::text AS "valueUsd"
    FROM coffee_items ci
    LEFT JOIN batches b ON b."itemId" = ci."id" AND b."status" = 'ACTIVE'
    WHERE ci."companyId" = ${companyId}
    GROUP BY ci."id", ci."itemName", ci."originCountry"
    HAVING COALESCE(SUM(b."availableQuantityKg"), 0) > 0
    ORDER BY SUM(b."availableQuantityKg") DESC
    LIMIT 8
  `;

  return rows.map((r) => ({
    itemId: r.itemId,
    itemName: r.itemName,
    originCountry: r.originCountry,
    availableKg: toQuantity(r.availableKg),
    valueUsd: toMoney(r.valueUsd),
  }));
}

export { dec };
