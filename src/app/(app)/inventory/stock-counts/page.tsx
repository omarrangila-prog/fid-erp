import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { StockCountsClient, type StockCountRow } from '@/app/(app)/inventory/stock-counts/stock-counts-client';

export const metadata: Metadata = { title: 'Stock Counts' };
export const dynamic = 'force-dynamic';

export default async function StockCountsPage() {
  const user = await requirePageAccess(PERMISSIONS.STOCK_COUNT_VIEW);

  const counts = await prisma.stockCount.findMany({
    where: { companyId: user.activeCompany.id },
    orderBy: [{ countDate: 'desc' }, { countNumber: 'desc' }],
    include: {
      warehouse: { select: { name: true } },
      createdBy: { select: { name: true } },
      lines: { select: { countedKg: true, differenceKg: true } },
    },
  });

  const rows: StockCountRow[] = counts.map((count) => ({
    id: count.id,
    number: count.countNumber,
    date: formatDate(count.countDate),
    dateSort: count.countDate.getTime(),
    warehouse: count.warehouse.name,
    lineCount: count.lines.length,
    countedCount: count.lines.filter((line) => line.countedKg !== null).length,
    differenceCount: count.lines.filter((line) => !dec(line.differenceKg).isZero()).length,
    status: count.status,
    createdBy: count.createdBy.name,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Counts"
        description="Check what is physically on the floor against what the books say, and post the difference."
        breadcrumbs={[{ label: 'Inventory', href: '/inventory' }, { label: 'Stock Counts' }]}
      />

      <Callout tone="info" title="How a count works">
        Opening a count <strong>snapshots</strong> what the system believes is in the warehouse at that moment, so a
        movement posted while somebody is walking the aisles cannot change what they were asked to verify. Every
        difference needs a reason before it can be posted — an unexplained write-off is how shrinkage gets hidden.
        Posting values each difference at the batch&rsquo;s landed cost.
      </Callout>

      <StockCountsClient rows={rows} canManage={can(user, PERMISSIONS.STOCK_COUNT_MANAGE)} />
    </div>
  );
}
