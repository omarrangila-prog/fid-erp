import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { formatQuantityKg, formatDate, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { EmptyAction } from '@/components/shared/empty-action';
import { ServerPagination } from '@/components/shared/server-pagination';
import { MovementsClient, type MovementRow } from '@/app/(app)/inventory/movements/movements-client';

export const metadata: Metadata = { title: 'Stock Movements' };
export const dynamic = 'force-dynamic';

const REFERENCE_LINKS: Record<string, (id: string) => string> = {
  SALES_INVOICE: (id) => `/sales/${id}`,
  SALES_INVOICE_REVERSAL: (id) => `/sales/${id}`,
  GOODS_RECEIPT: () => '/inventory',
  PURCHASE_CONTRACT: (id) => `/purchases/${id}`,
  STOCK_TRANSFER: () => '/inventory/transfers',
};

const PAGE_SIZE = 100;

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const companyId = user.activeCompany.id;

  // The movement ledger only ever grows, so it is paged in the database.
  const requested = Number((await searchParams).page ?? '1');
  const page = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) - 1 : 0;

  const total = await prisma.inventoryTransaction.count({ where: { companyId } });

  const movements = await prisma.inventoryTransaction.findMany({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
    include: {
      batch: { select: { batchNumber: true } },
      item: { select: { itemName: true } },
      warehouse: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  });

  const rows: MovementRow[] = movements.map((m) => {
    const quantity = dec(m.quantityKg);
    const linkBuilder = REFERENCE_LINKS[m.referenceType];
    return {
      id: m.id,
      date: formatDate(m.transactionDate),
      dateSort: m.createdAt.getTime(),
      type: m.transactionType,
      typeLabel: titleCase(m.transactionType),
      batchNumber: m.batch.batchNumber,
      batchId: m.batchId,
      itemName: m.item.itemName,
      warehouse: m.warehouse?.name ?? '—',
      quantityLabel: formatQuantityKg(quantity),
      quantitySort: Number(quantity),
      isInflow: quantity.greaterThan(0),
      reference: titleCase(m.referenceType),
      referenceHref: linkBuilder ? linkBuilder(m.referenceId) : null,
      notes: m.notes,
      createdBy: m.createdBy.name,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Movements"
        description="The append-only ledger every stock figure is derived from."
        breadcrumbs={[{ label: 'Inventory', href: '/inventory' }, { label: 'Stock Movements' }]}
      />

      <Callout tone="info">
        Nothing here is ever edited or deleted. A correction is a new movement in the opposite direction, so the
        history of a batch always reads as what actually happened.
      </Callout>

      <MovementsClient
        emptyAction={
          can(user, PERMISSIONS.PURCHASES_VIEW) ? (
            <EmptyAction href="/purchases" label="Open purchase contracts" tone="go" />
          ) : undefined
        }
        rows={rows}
        companyCode={user.activeCompany.code}
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
      />

      <ServerPagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/inventory/movements" />
    </div>
  );
}
