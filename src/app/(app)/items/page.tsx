import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getItemStock, getWarehouseStockByItem } from '@/lib/services/stock';
import { formatQuantityKg } from '@/lib/format';
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

  const [items, stock, warehouseStock] = await Promise.all([
    prisma.coffeeItem.findMany({ where: { companyId }, orderBy: { itemName: 'asc' } }),
    getItemStock(companyId),
    getWarehouseStockByItem(companyId),
  ]);

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
      warehouses: (byWarehouse?.warehouses ?? []).map((warehouse) => ({
        warehouseName: warehouse.warehouseName,
        availableLabel: formatQuantityKg(warehouse.availableKg),
        availableKg: Number(warehouse.availableKg),
      })),
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
