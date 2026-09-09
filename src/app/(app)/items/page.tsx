import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getItemStock } from '@/lib/services/stock';
import { formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { ItemsClient, type ItemRow } from '@/app/(app)/items/items-client';

export const metadata: Metadata = { title: 'Coffee Items' };
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

  const [items, stock] = await Promise.all([
    prisma.coffeeItem.findMany({ where: { companyId }, orderBy: { itemName: 'asc' } }),
    getItemStock(companyId),
  ]);

  const stockByItem = new Map(stock.map((s) => [s.itemId, s]));

  const rows: ItemRow[] = items.map((i) => {
    const s = stockByItem.get(i.id);
    const availableKg = Number(s?.availableKg ?? 0);
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
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Coffee Items"
        description="The coffee master: type, origin, grade, process, crop year and packaging. Stock is always held in kilograms."
        breadcrumbs={[{ label: 'Masters' }, { label: 'Coffee Items' }]}
      />
      <ItemsClient
        rows={rows}
        canCreate={can(user, PERMISSIONS.ITEMS_CREATE)}
        openCreate={openCreate}
        canEdit={can(user, PERMISSIONS.ITEMS_EDIT)}
        showValue={can(user, PERMISSIONS.PURCHASE_COST_VIEW)}
      />
    </div>
  );
}
