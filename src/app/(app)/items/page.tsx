import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getItemStock, getWarehouseStockByItem } from '@/lib/services/stock';
import { getShipmentOrdinals, shipmentOrdinalLabel } from '@/lib/services/shipment';
import { formatQuantityKg, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { ItemsClient, type ItemRow } from '@/app/(app)/items/items-client';

export const metadata: Metadata = { title: 'Items' };
export const dynamic = 'force-dynamic';

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  // "+ New" from anywhere in the app lands here with ?new=1 and opens the form.
  const openCreate = (await searchParams).new === '1';
  const user = await requirePageAccess(PERMISSIONS.ITEMS_VIEW);
  const companyId = user.activeCompany.id;

  const [items, stock, warehouseStock, traffic, balances, ordinals] = await Promise.all([
    prisma.coffeeItem.findMany({ where: { companyId }, orderBy: { itemName: 'asc' } }),
    getItemStock(companyId),
    getWarehouseStockByItem(companyId),
    // How many batches carry this coffee, and when it last moved — the two
    // things the client checks before selling, read from the stock ledger
    // rather than recomputed.
    prisma.$queryRaw<Array<{ itemId: string; batches: bigint; lastAt: Date | null }>>`
      SELECT b."itemId",
             COUNT(DISTINCT b."id") AS batches,
             MAX(t."transactionDate") AS "lastAt"
      FROM batches b
      LEFT JOIN inventory_transactions t ON t."batchId" = b."id"
      WHERE b."companyId" = ${companyId} AND b."status" = 'ACTIVE'
      GROUP BY b."itemId"`,
    /*
     * Where each coffee physically is, batch by batch: the container it came
     * in, the contract that bought it, the warehouse holding it. The client
     * should not have to open an item to learn that its stock is split across
     * two containers from one shipment.
     */
    prisma.inventoryBalance.findMany({
      where: { companyId, onHandKg: { not: 0 } },
      select: {
        itemId: true,
        onHandKg: true,
        availableKg: true,
        bags: true,
        warehouse: { select: { name: true } },
        batch: {
          select: {
            batchNumber: true,
            container: { select: { containerNumber: true } },
            purchaseContract: { select: { contractReference: true } },
            shipmentId: true,
            lot: { select: { lotNumber: true } },
          },
        },
      },
    }),
    getShipmentOrdinals(companyId),
  ]);

  const lotsByItem = new Map<string, ItemRow['lots']>();
  for (const balance of balances) {
    const list = lotsByItem.get(balance.itemId) ?? [];
    list.push({
      reference: balance.batch.purchaseContract?.contractReference ?? '—',
      batchNumber: balance.batch.batchNumber,
      container: balance.batch.container?.containerNumber ?? '—',
      shipment: shipmentOrdinalLabel(ordinals.get(balance.batch.shipmentId)),
      lotNumber: balance.batch.lot?.lotNumber ?? '—',
      warehouseName: balance.warehouse.name,
      onHandLabel: formatQuantityKg(balance.onHandKg),
      availableLabel: formatQuantityKg(balance.availableKg),
      bags: balance.bags,
    });
    lotsByItem.set(balance.itemId, list);
  }

  const activityByItem = new Map(traffic.map((row) => [row.itemId, row]));

  const stockByItem = new Map(stock.map((s) => [s.itemId, s]));

  const rows: ItemRow[] = items.map((i) => {
    const s = stockByItem.get(i.id);
    const byWarehouse = warehouseStock.get(i.id);
    const warehouseAvailable = Number(byWarehouse?.totalAvailableKg ?? 0);
    const availableKg = warehouseAvailable > 0 ? warehouseAvailable : Number(s?.availableKg ?? 0);
    return {
      id: i.id,
      itemCode: i.itemCode,
      itemName: i.itemName,
      coffeeType: i.coffeeType,
      originCountry: i.originCountry,
      region: i.region,
      farmEstate: i.farmEstate,
      grade: i.grade,
      screenSize: i.screenSize,
      variety: i.variety,
      process: i.process,
      cropYear: i.cropYear,
      moisturePct: i.moisturePct?.toString() ?? null,
      densityGPerL: i.densityGPerL?.toString() ?? null,
      packagingType: i.packagingType,
      bagWeightKg: i.bagWeightKg.toString(),
      defaultUnit: i.defaultUnit,
      description: i.description,
      notes: i.notes,
      status: i.status,
      availableKg,
      availableLabel: availableKg > 0 ? formatQuantityKg(availableKg) : '—',
      bags: 0,
      batchCount: Number(activityByItem.get(i.id)?.batches ?? 0),
      lastMovedLabel: (() => {
        const at = activityByItem.get(i.id)?.lastAt;
        return at ? formatDate(at) : '—';
      })(),
      lastMovedSort: activityByItem.get(i.id)?.lastAt?.getTime() ?? 0,
      warehouses: (byWarehouse?.warehouses ?? []).map((warehouse) => ({
        warehouseName: warehouse.warehouseName,
        availableLabel: formatQuantityKg(warehouse.availableKg),
        availableKg: Number(warehouse.availableKg),
      })),
      lots: lotsByItem.get(i.id) ?? [],
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Items"
        description="Every coffee you trade, named once. Available stock is shown per warehouse."
        breadcrumbs={[{ label: 'Trading' }, { label: 'Items' }]}
      />
      <ItemsClient
        rows={rows}
        canCreate={can(user, PERMISSIONS.ITEMS_CREATE)}
        openCreate={openCreate}
        canEdit={can(user, PERMISSIONS.ITEMS_EDIT)}
        canDelete={can(user, PERMISSIONS.ITEMS_DELETE)}
        showValue={can(user, PERMISSIONS.PURCHASE_COST_VIEW)}
      />
    </div>
  );
}
