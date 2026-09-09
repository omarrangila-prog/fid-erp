import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { CountSheet, type CountLine } from '@/app/(app)/inventory/stock-counts/[id]/count-sheet';
import type { BadgeTone } from '@/lib/constants';

export const metadata: Metadata = { title: 'Stock Count' };
export const dynamic = 'force-dynamic';

const STATUS_TONES: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  COUNTED: 'progress',
  POSTED: 'success',
  CANCELLED: 'danger',
};

export default async function StockCountPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageAccess(PERMISSIONS.STOCK_COUNT_VIEW);
  const { id } = await params;

  const count = await prisma.stockCount.findFirst({
    where: { id, companyId: user.activeCompany.id },
    include: {
      warehouse: { select: { name: true } },
      createdBy: { select: { name: true } },
      countedBy: { select: { name: true } },
      lines: {
        orderBy: { batch: { batchNumber: 'asc' } },
        include: {
          batch: {
            select: {
              batchNumber: true,
              landedUnitCostUsd: true,
              item: { select: { itemName: true } },
              lot: { select: { lotNumber: true } },
            },
          },
        },
      },
    },
  });
  if (!count) notFound();

  const lines: CountLine[] = count.lines.map((line) => ({
    batchId: line.batchId,
    batchNumber: line.batch.batchNumber,
    itemName: line.batch.item.itemName,
    lotNumber: line.batch.lot?.lotNumber ?? '—',
    systemKg: line.systemKg.toString(),
    countedKg: line.countedKg === null ? null : line.countedKg.toString(),
    reason: line.reason,
    notes: line.notes,
    landedUnitCostUsd: line.batch.landedUnitCostUsd.toString(),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Stock Count ${count.countNumber}`}
        description={`${count.warehouse.name} · counted as at ${formatDate(count.countDate)}`}
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Stock Counts', href: '/inventory/stock-counts' },
          { label: count.countNumber },
        ]}
        meta={
          <>
            <Badge tone={STATUS_TONES[count.status] ?? 'neutral'}>{count.status.toLowerCase()}</Badge>
            <span className="text-xs text-ink-muted">Opened by {count.createdBy.name}</span>
            {count.countedBy ? (
              <span className="text-xs text-ink-muted">Counted by {count.countedBy.name}</span>
            ) : null}
          </>
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/inventory/stock-counts">
              <ArrowLeft />
              Back
            </Link>
          </Button>
        }
      />

      <CountSheet
        id={count.id}
        countNumber={count.countNumber}
        status={count.status}
        lines={lines}
        canManage={can(user, PERMISSIONS.STOCK_COUNT_MANAGE)}
        canPost={can(user, PERMISSIONS.STOCK_COUNT_POST)}
      />
    </div>
  );
}
