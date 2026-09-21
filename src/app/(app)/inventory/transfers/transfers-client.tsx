'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Check, Truck, PackageCheck } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { advanceStockTransferAction, deleteStockTransferAction } from '@/server/actions/trading-actions';
import { MemoCell } from '@/components/shared/memo-cell';
import { RowActions, viewAction, editAction } from '@/components/shared/row-actions';
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
  memo: string | null;
  lines: Array<{
    reference: string;
    itemName: string;
    batchId: string;
    batchNumber: string;
    lotNumber: string;
    containerNumber: string;
    quantityLabel: string;
  }>;
};

const STATE_TONES: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  APPROVED: 'info',
  IN_TRANSIT: 'progress',
  RECEIVED: 'success',
  CANCELLED: 'danger',
  REVERSED: 'danger',
};

/** One value, or "Multiple" when the lines differ. */
function summary(values: string[]) {
  const distinct = [...new Set(values)];
  return distinct.length <= 1 ? (distinct[0] ?? '—') : distinct.length === 2 ? distinct.join(', ') : `Multiple (${distinct.length})`;
}

/** The next step available from each state, and what it is called. */
const NEXT_STEP: Record<string, { to: 'APPROVED' | 'IN_TRANSIT' | 'RECEIVED'; label: string; icon: typeof Check }> = {
  DRAFT: { to: 'APPROVED', label: 'Approve', icon: Check },
  APPROVED: { to: 'IN_TRANSIT', label: 'Dispatch', icon: Truck },
  IN_TRANSIT: { to: 'RECEIVED', label: 'Receive', icon: PackageCheck },
};

export function TransfersClient({ rows, canManage }: { rows: TransferRow[]; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

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
      // The ICUL/FID order the stock was bought on — the business reference, in the table, not only inside.
      id: 'reference',
      header: 'ICUL/FID Reference',
      sortValue: (r) => summary(r.lines.map((l) => l.reference)),
      exportValue: (r) => r.lines.map((l) => l.reference).join(', '),
      cell: (r) => <span className="font-medium text-forest-800">{summary(r.lines.map((l) => l.reference))}</span>,
    },
    {
      id: 'item',
      header: 'Item · Batch · Container',
      exportValue: (r) => r.lines.map((l) => `${l.itemName} ${l.batchNumber} ${l.containerNumber}`).join('; '),
      cell: (r) => (
        <span className="block min-w-44 text-xs">
          <span className="block text-sm text-ink">{summary(r.lines.map((l) => l.itemName))}</span>
          <span className="block text-ink-subtle">
            {summary(r.lines.map((l) => l.batchNumber))} · {summary(r.lines.map((l) => l.containerNumber))}
          </span>
        </span>
      ),
    },
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
      id: 'memo',
      header: 'Memo',
      hideable: true,
      exportValue: (r) => r.memo ?? '',
      cell: (r) => <MemoCell memo={r.memo} />,
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
    {
      id: 'actions',
      header: 'Actions',
      cell: (r: TransferRow) => {
        const step = NEXT_STEP[r.state];
        return (
          <RowActions
            inline={3}
            actions={[
              viewAction(`/inventory/transfers/${r.id}`),
              editAction(`/inventory/transfers/${r.id}/edit`, canManage && r.state === 'DRAFT'),
              ...(canManage && step
                ? [{ label: step.label, onSelect: () => void advance(r, step.to), icon: step.icon, disabled: busy === r.id }]
                : []),
              ...(canManage && r.state === 'RECEIVED'
                ? [{ label: 'Correct or reverse', href: `/inventory/transfers/${r.id}`, icon: 'history' as const }]
                : []),
            ]}
            destructive={
              canManage && ['DRAFT', 'APPROVED', 'IN_TRANSIT'].includes(r.state)
                ? {
                    status: r.state === 'DRAFT' ? 'DRAFT' : 'POSTED',
                    noun: 'transfer',
                    cancelLabel: 'Cancel',
                    description:
                      r.state === 'DRAFT'
                        ? 'A draft moves no stock; it is removed and its number is issued again.'
                        : 'The stock it reserved is released back to the source warehouse. It stays on the list as cancelled.',
                    run: async (reason?: string) =>
                      r.state === 'DRAFT'
                        ? deleteStockTransferAction(r.id)
                        : advanceStockTransferAction(r.id, 'CANCELLED', reason ?? 'Cancelled'),
                  }
                : undefined
            }
          />
        );
      },
    } satisfies DataColumn<TransferRow>,
  ];

  return (
    <>
      <DataTable
      prefsKey="transfers"
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        searchValue={(r) =>
          `${r.transferLabel} ${r.storedNumber} ${r.fromWarehouse} ${r.toWarehouse} ${r.lines
            .map((l) => `${l.reference} ${l.itemName} ${l.batchNumber} ${l.lotNumber} ${l.containerNumber}`)
            .join(' ')}`
        }
        rowHref={(r) => `/inventory/transfers/${r.id}`}
        expandedContent={(r) =>
          r.lines.length > 1 ? (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-ink-muted">
                  <th className="py-1 pr-3 font-medium">ICUL/FID Reference</th>
                  <th className="py-1 pr-3 font-medium">Item</th>
                  <th className="py-1 pr-3 font-medium">Batch</th>
                  <th className="py-1 pr-3 font-medium">Lot</th>
                  <th className="py-1 pr-3 font-medium">Container</th>
                  <th className="py-1 text-right font-medium">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l, i) => (
                  <tr key={`${l.batchId}-${i}`} className="border-t border-line/60">
                    <td className="py-1 pr-3 font-medium text-forest-800">{l.reference}</td>
                    <td className="py-1 pr-3">{l.itemName}</td>
                    <td className="py-1 pr-3">{l.batchNumber}</td>
                    <td className="py-1 pr-3">{l.lotNumber}</td>
                    <td className="py-1 pr-3">{l.containerNumber}</td>
                    <td className="tnum py-1 text-right">{l.quantityLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null
        }
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

    </>
  );
}
