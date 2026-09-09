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
