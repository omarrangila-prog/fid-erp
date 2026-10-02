import { prisma } from '@/lib/db';
import { Decimal } from '@/lib/money';
import { formatPercent } from '@/lib/format';
import { getShipmentOrdinals, shipmentOrdinalLabel } from '@/lib/services/shipment';
import type { ItemNode, ItemProfitFilters } from '@/lib/services/item-profitability';
import { kg, pairText, perKgText, profitText } from '@/components/inventory/item-profit-format';
import type { StockFilterValues } from '@/app/(app)/inventory/stock-filters';
import type { ItemStockRow } from '@/app/(app)/inventory/item-stock-client';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: string | undefined) => (value && DAY.test(value) ? new Date(`${value}T00:00:00.000Z`) : undefined);

/** The filters in the URL, checked, and the service filters they mean. */
export function parseStockFilters(query: Record<string, string | undefined>): {
  values: StockFilterValues;
  filters: Omit<ItemProfitFilters, 'companyId' | 'warehouseIds'>;
} {
  const pick = (key: string) => {
    const value = query[key];
    return value && value.length <= 64 ? value : undefined;
  };
  const values: StockFilterValues = {
    item: pick('item'),
    warehouse: pick('warehouse'),
    shipment: pick('shipment'),
    batch: pick('batch'),
    container: pick('container'),
    from: day(query.from) ? query.from : undefined,
    to: day(query.to) ? query.to : undefined,
  };
  return {
    values,
    filters: {
      itemId: values.item,
      warehouseId: values.warehouse,
      shipmentId: values.shipment,
      batchId: values.batch,
      containerId: values.container,
      from: day(values.from),
      to: day(values.to),
    },
  };
}

/** What each filter can be set to — this company's own records, nothing else. */
export async function getStockFilterOptions(companyId: string, warehouseIds: string[] | null) {
  const [items, warehouses, shipments, batches, ordinals] = await Promise.all([
    prisma.coffeeItem.findMany({ where: { companyId }, orderBy: { itemName: 'asc' }, select: { id: true, itemName: true } }),
    prisma.warehouse.findMany({
      where: { companyId, ...(warehouseIds ? { id: { in: warehouseIds } } : {}) },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.shipment.findMany({
      where: { companyId, purchaseContract: { status: 'POSTED' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, purchaseContract: { select: { contractReference: true } }, item: { select: { itemName: true } } },
    }),
    prisma.batch.findMany({
      where: { companyId, purchaseContract: { status: 'POSTED' } },
      orderBy: { batchNumber: 'asc' },
      select: { id: true, batchNumber: true, container: { select: { id: true, containerNumber: true } }, item: { select: { itemName: true } } },
    }),
    getShipmentOrdinals(companyId),
  ]);
  const containers = new Map<string, string>();
  for (const b of batches) if (b.container) containers.set(b.container.id, b.container.containerNumber);
  return {
    items: items.map((i) => ({ id: i.id, label: i.itemName })),
    warehouses: warehouses.map((w) => ({ id: w.id, label: w.name })),
    shipments: shipments.map((s) => ({
      id: s.id,
      label: `${s.purchaseContract.contractReference} · ${shipmentOrdinalLabel(ordinals.get(s.id))} · ${s.item.itemName}`,
    })),
    batches: batches.map((b) => ({ id: b.id, label: `${b.batchNumber} · ${b.item.itemName}` })),
    containers: [...containers.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/** The filters in words, for the heading of a shared or printed copy. */
export function describeStockFilters(
  values: StockFilterValues,
  options: Awaited<ReturnType<typeof getStockFilterOptions>>,
): string[] {
  const name = (list: Array<{ id: string; label: string }>, id?: string) => list.find((o) => o.id === id)?.label;
  return [
    values.item ? `Item: ${name(options.items, values.item) ?? '—'}` : null,
    values.warehouse ? `Warehouse: ${name(options.warehouses, values.warehouse) ?? '—'}` : null,
    values.shipment ? `Shipment: ${name(options.shipments, values.shipment) ?? '—'}` : null,
    values.container ? `Container: ${name(options.containers, values.container) ?? '—'}` : null,
    values.batch ? `Batch: ${name(options.batches, values.batch) ?? '—'}` : null,
  ].filter((v): v is string => !!v);
}

/** The item's own page. */
export const itemPage = (itemId: string) => ['/inventory/items', itemId].join('/');

/** For sorting only — a display order, never a figure anyone adds up. */
const toNumber = (value: Decimal | number) => (typeof value === 'number' ? value : value.toNumber());

/**
 * One item as a table row. Money this person may not see is left out here, on
 * the server — not merely hidden in the browser.
 */
export function toItemStockRow(
  item: ItemNode,
  local: string,
  access: { showCost: boolean; showSales: boolean; showProfit: boolean },
  query: string,
): ItemStockRow {
  const { showCost, showSales } = access;
  // Cost of goods sold and profit are profitability, as on every other
  // screen: they need "View profit" as well as the cost they are made from.
  const showCogs = showCost && access.showProfit;
  const both = showCogs && showSales;
  const warehouses = item.warehouses.filter((w) => !(w.receivedKg.isZero() && w.transferInKg.isZero() && w.transferOutKg.isZero() && w.stockSoldKg.isZero() && w.onHandKg.isZero()));
  const sum = (pick: (w: (typeof warehouses)[number]) => Decimal) => kg(warehouses.reduce((total, w) => total.plus(pick(w)), new Decimal(0)));
  return {
    id: item.itemId,
    href: itemPage(item.itemId) + query,
    itemName: item.itemName,
    itemCode: item.itemCode,
    origin: item.origin,
    status: item.status,
    receivedLabel: kg(item.receivedKg),
    soldLabel: kg(item.soldKg),
    availableLabel: kg(item.availableKg),
    reservedLabel: item.reservedKg.greaterThan(0) ? kg(item.reservedKg) : null,
    receivedSort: toNumber(item.receivedKg),
    soldSort: toNumber(item.soldKg),
    availableSort: toNumber(item.availableKg),
    warehouseNames: warehouses.map((w) => w.warehouseName).join(', '),
    warehouses: warehouses.map((w) => ({
      name: w.warehouseName,
      receivedLabel: kg(w.receivedKg),
      transferInLabel: kg(w.transferInKg),
      transferOutLabel: kg(w.transferOutKg),
      soldLabel: kg(w.stockSoldKg),
      availableLabel: kg(w.availableKg),
    })),
    warehouseTotal: {
      receivedLabel: sum((w) => w.receivedKg),
      transferInLabel: sum((w) => w.transferInKg),
      transferOutLabel: sum((w) => w.transferOutKg),
      soldLabel: sum((w) => w.stockSoldKg),
      availableLabel: sum((w) => w.availableKg),
    },
    avgCost: showCost ? perKgText(item.avgCostPerKg, local) : null,
    cogs: showCogs ? pairText(item.cogs, local) : null,
    stockValue: showCost ? pairText(item.stockValue, local) : null,
    avgSell: showSales ? perKgText(item.avgSellPerKg, local) : null,
    revenue: showSales ? pairText(item.revenue, local) : null,
    collected: showSales ? pairText(item.collectedTotal, local) : null,
    outstanding: showSales ? pairText(item.outstanding, local) : null,
    profit: both && !item.revenue.local.isZero() ? profitText(item.grossProfit, local) : null,
    profitPerKg: both ? perKgText(item.profitPerKg, local) : null,
    margin: both && item.marginPct ? formatPercent(item.marginPct) : null,
    sort: {
      avgCost: showCost ? toNumber(item.avgCostPerKg?.local ?? 0) : 0,
      avgSell: showSales ? toNumber(item.avgSellPerKg?.local ?? 0) : 0,
      revenue: showSales ? toNumber(item.revenue.local) : 0,
      collected: showSales ? toNumber(item.collectedTotal.local) : 0,
      outstanding: showSales ? toNumber(item.outstanding.local) : 0,
      cogs: showCogs ? toNumber(item.cogs.local) : 0,
      profit: both ? toNumber(item.grossProfit.local) : 0,
      margin: both ? toNumber(item.marginPct ?? 0) : 0,
      stockValue: showCost ? toNumber(item.stockValue.local) : 0,
    },
  };
}
