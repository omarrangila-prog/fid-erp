'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm';
import { cancelStockCountAction } from '@/server/actions/compliance-actions';
import type { BadgeTone } from '@/lib/constants';

export type StockCountRow = {
  id: string;
  number: string;
  date: string;
  dateSort: number;
  warehouse: string;
  lineCount: number;
  countedCount: number;
  differenceCount: number;
  status: string;
  createdBy: string;
};

const STATUS_TONES: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  COUNTED: 'progress',
  POSTED: 'success',
  CANCELLED: 'danger',
};

export function StockCountsClient({ rows, canManage }: { rows: StockCountRow[]; canManage: boolean }) {
  const router = useRouter();
  const [cancelling, setCancelling] = React.useState<StockCountRow | null>(null);

  const columns: DataColumn<StockCountRow>[] = [
    {
      id: 'number',
      header: 'Count',
      mobile: 'title',
      sortValue: (r) => r.number,
      cell: (r) => (
        <Link href={`/inventory/stock-counts/${r.id}`} className="font-medium text-forest-700 hover:underline">
          {r.number}
        </Link>
      ),
    },
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.dateSort, cell: (r) => r.date },
    { id: 'warehouse', header: 'Warehouse', mobile: 'meta', sortValue: (r) => r.warehouse, cell: (r) => r.warehouse },
    {
      id: 'progress',
      header: 'Counted',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.countedCount / Math.max(1, r.lineCount),
      cell: (r) => (
        <span>
          <span className="block tabular-nums">
            {r.countedCount} of {r.lineCount}
          </span>
          {r.differenceCount > 0 ? (
            <span className="block text-xs text-amber-700">
              {r.differenceCount} difference{r.differenceCount === 1 ? '' : 's'}
            </span>
          ) : r.countedCount > 0 ? (
            <span className="block text-xs text-ink-subtle">No differences</span>
          ) : null}
        </span>
      ),
    },
    { id: 'by', header: 'Opened by', hideable: true, cell: (r) => <span className="text-xs">{r.createdBy}</span> },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <Badge tone={STATUS_TONES[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</Badge>,
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: '',
            cell: (r: StockCountRow) =>
              r.status === 'DRAFT' || r.status === 'COUNTED' ? (
                <span className="flex items-center justify-end gap-1">
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/inventory/stock-counts/${r.id}`}>Open sheet</Link>
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Cancel ${r.number}`} onClick={() => setCancelling(r)}>
                    <X className="text-red-500" />
                  </Button>
                </span>
              ) : null,
          } satisfies DataColumn<StockCountRow>,
        ]
      : []),
  ];

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        searchValue={(r) => `${r.number} ${r.warehouse}`}
        searchPlaceholder="Search counts…"
        emptyTitle="No stock counts yet"
        emptyDescription="Open a count to check what is physically in a warehouse against what the system believes is there."
        emptyAction={
          canManage ? (
            <Button asChild>
              <Link href="/inventory/stock-counts/new">
                <Plus />
                Start a count
              </Link>
            </Button>
          ) : undefined
        }
        toolbar={
          canManage ? (
            <Button asChild>
              <Link href="/inventory/stock-counts/new">
                <Plus />
                <span className="hidden sm:inline">Start a count</span>
                <span className="sm:hidden">New</span>
              </Link>
            </Button>
          ) : undefined
        }
      />

      <ConfirmDialog
        open={Boolean(cancelling)}
        onOpenChange={(open) => !open && setCancelling(null)}
        title={`Cancel ${cancelling?.number ?? 'count'}?`}
        description="Nothing has been adjusted, so cancelling simply closes the sheet. The warehouse is then free for a new count."
        confirmLabel="Cancel count"
        variant="danger"
        requireReason
        reasonLabel="Why is this being cancelled?"
        onConfirm={async (reason) => {
          if (!cancelling) return;
          const result = await cancelStockCountAction(cancelling.id, reason ?? '');
          if (result.ok) {
            toast.success('Count cancelled.');
            router.refresh();
          } else {
            throw new Error(result.error);
          }
        }}
      />
    </>
  );
}
