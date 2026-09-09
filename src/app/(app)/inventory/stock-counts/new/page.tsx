import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { PrerequisiteGate, anyMissing, type Prerequisite } from '@/components/shared/prerequisite-gate';
import { StockCountForm } from '@/app/(app)/inventory/stock-counts/new/count-form';

export const metadata: Metadata = { title: 'New Stock Count' };
export const dynamic = 'force-dynamic';

const CRUMBS = [
  { label: 'Inventory', href: '/inventory' },
  { label: 'Stock Counts', href: '/inventory/stock-counts' },
  { label: 'New' },
];

export default async function NewStockCountPage() {
  const user = await requirePageAccess(PERMISSIONS.STOCK_COUNT_MANAGE);
  const companyId = user.activeCompany.id;

  const [warehouses, balances, openCounts] = await Promise.all([
    prisma.warehouse.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.inventoryBalance.groupBy({
      by: ['warehouseId'],
      where: { companyId },
      _count: { batchId: true },
    }),
    prisma.stockCount.findMany({
      where: { companyId, status: { in: ['DRAFT', 'COUNTED'] } },
      select: { warehouseId: true, countNumber: true },
    }),
  ]);

  const counts = new Map(balances.map((row) => [row.warehouseId, row._count.batchId]));
  const open = new Map(openCounts.map((row) => [row.warehouseId, row.countNumber]));

  const options = warehouses.map((warehouse) => ({
    id: warehouse.id,
    name: warehouse.name,
    batchCount: counts.get(warehouse.id) ?? 0,
    openCountNumber: open.get(warehouse.id) ?? null,
  }));

  const prerequisites: Prerequisite[] = [
    {
      met: warehouses.length > 0,
      label: 'At least one warehouse',
      description: 'A count verifies one warehouse at a time, so there has to be one on file.',
      href: '/warehouses',
      actionLabel: 'Open warehouses',
    },
    {
      met: options.some((option) => option.batchCount > 0),
      label: 'Stock recorded somewhere',
      description: 'There is nothing in any warehouse yet. Receive a purchase contract first.',
      href: '/purchases',
      actionLabel: 'Open purchases',
    },
  ];

  if (anyMissing(prerequisites)) {
    return (
      <div className="space-y-6">
        <PageHeader title="New Stock Count" breadcrumbs={CRUMBS} />
        <PrerequisiteGate
          title="Before you can count stock"
          description="A count compares the shelf against the books, so there has to be something on both."
          prerequisites={prerequisites}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Stock Count"
        description="Freeze what the system believes is in a warehouse, then go and check it."
        breadcrumbs={CRUMBS}
      />
      <StockCountForm warehouses={options} />
    </div>
  );
}
