'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Check, Truck, PackageCheck, X } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm';
import { advanceStockTransferAction, deleteStockTransferAction } from '@/server/actions/trading-actions';
import type { BadgeTone } from '@/lib/constants';

export type TransferRow = {
  id: string;
  /** WTO-004 — the business's own running number, not a system code. */
  transferLabel: string;
  transferSequence: number;
  /** What the record holds, kept searchable for transfers raised before WTO numbering. */
  storedNumber: string;
  transferDate: string;
  transferDateSort: number;
  fromWarehouse: string;
  toWarehouse: string;
  lineCount: number;
  quantityLabel: string;
  quantitySort: number;
  state: string;
  stateLabel: string;
  requestedBy: string;
  approvedBy: string | null;
  receivedBy: string | null;
};

const STATE_TONES: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  APPROVED: 'info',
  IN_TRANSIT: 'progress',
  RECEIVED: 'success',
  CANCELLED: 'danger',
};

/** The next step available from each state, and what it is called. */
const NEXT_STEP: Record<string, { to: 'APPROVED' | 'IN_TRANSIT' | 'RECEIVED'; label: string; icon: typeof Check }> = {
  DRAFT: { to: 'APPROVED', label: 'Approve', icon: Check },
  APPROVED: { to: 'IN_TRANSIT', label: 'Dispatch', icon: Truck },
  IN_TRANSIT: { to: 'RECEIVED', label: 'Receive', icon: PackageCheck },
};

export function TransfersClient({ rows, canManage }: { rows: TransferRow[]; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState<TransferRow | null>(null);

  async function advance(row: TransferRow, to: 'APPROVED' | 'IN_TRANSIT' | 'RECEIVED') {
    setBusy(row.id);
    try {
      const result = await advanceStockTransferAction(row.id, to);
      if (result.ok) {
        toast.success(
          to === 'RECEIVED'
            ? `Stock moved to ${row.toWarehouse}.`
            : to === 'APPROVED'
              ? 'Transfer approved and stock reserved.'
              : 'Transfer dispatched.',
        );
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(null);
    }
  }

  const columns: DataColumn<TransferRow>[] = [
    // WTO-001, WTO-002 … the business's own running number, issued in order.
    {
      id: 'number',
      header: 'Transfer No.',
      mobile: 'title',
      sortValue: (r) => r.transferSequence,
      exportValue: (r) => r.transferLabel,
      cell: (r) => <span className="tnum font-medium">{r.transferLabel}</span>,
    },
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.transferDateSort, cell: (r) => <span>{r.transferDate}</span> },
    {
      id: 'route',
      header: 'From → To',
      mobile: 'meta',
      cell: (r) => (
        <span>
          <span className="block">{r.fromWarehouse}</span>
          <span className="block text-xs text-ink-subtle">→ {r.toWarehouse}</span>
        </span>
      ),
    },
    {
      id: 'quantity',
      header: 'Quantity',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.quantitySort,
      cell: (r) => (
        <span>
          <span className="block">{r.quantityLabel}</span>
          <span className="block text-xs text-ink-subtle">
            {r.lineCount} batch{r.lineCount === 1 ? '' : 'es'}
          </span>
        </span>
      ),
    },
    {
      id: 'people',
      header: 'Requested / Approved',
      hideable: true,
      cell: (r) => (
        <span className="text-xs">
          <span className="block">{r.requestedBy}</span>
          <span className="block text-ink-subtle">{r.approvedBy ?? 'Not approved'}</span>
        </span>
      ),
    },
    {
      id: 'state',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.state,
      cell: (r) => <Badge tone={STATE_TONES[r.state] ?? 'neutral'}>{r.stateLabel}</Badge>,
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: '',
            cell: (r: TransferRow) => {
              const step = NEXT_STEP[r.state];
              if (!step) return null;
              const Icon = step.icon;
              return (
                <span className="flex items-center justify-end gap-1">
                  <Button
                    size="sm"
                    variant={step.to === 'RECEIVED' ? 'accent' : 'outline'}
                    loading={busy === r.id}
                    onClick={() => advance(r, step.to)}
                  >
                    <Icon />
                    {step.label}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Cancel the transfer of ${r.transferDate}`}
                    onClick={() => setCancelling(r)}
                  >
                    <X className="text-red-500" />
                  </Button>
                </span>
              );
            },
          } satisfies DataColumn<TransferRow>,
        ]
      : []),
  ];

  return (
    <>
      <DataTable
      prefsKey="transfers"
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        searchValue={(r) => `${r.transferLabel} ${r.storedNumber} ${r.fromWarehouse} ${r.toWarehouse}`}
        searchPlaceholder="Search transfers…"
        emptyTitle="No transfers yet"
        emptyDescription="Move coffee between warehouses without changing how much the company owns."
        emptyAction={
          canManage ? (
            <Button asChild>
              <Link href="/inventory/transfers/new">
                <Plus />
                New transfer
              </Link>
            </Button>
          ) : undefined
        }
        toolbar={
          canManage ? (
            <Button asChild>
              <Link href="/inventory/transfers/new">
                <Plus />
                <span className="hidden sm:inline">New transfer</span>
                <span className="sm:hidden">New</span>
              </Link>
            </Button>
          ) : undefined
        }
      />

      <ConfirmDialog
        open={Boolean(cancelling)}
        onOpenChange={(open) => !open && setCancelling(null)}
        title={`Cancel ${cancelling?.transferLabel ?? 'transfer'}?`}
        description="Any stock this transfer had reserved is released back to the source warehouse."
        confirmLabel="Cancel transfer"
        variant="danger"
        requireReason
        reasonLabel="Why is this being cancelled?"
        onConfirm={async (reason) => {
          if (!cancelling) return;
          const result =
            cancelling.state === 'DRAFT'
              ? await deleteStockTransferAction(cancelling.id)
              : await advanceStockTransferAction(cancelling.id, 'CANCELLED', reason);
          if (result.ok) {
            toast.success('Transfer cancelled.');
            router.refresh();
          } else {
            throw new Error(result.error);
          }
        }}
      />
    </>
  );
}
