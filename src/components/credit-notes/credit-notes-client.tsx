'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, CheckCircle2 } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { RowActions, viewAction, editAction } from '@/components/shared/row-actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm';
import { postCreditNoteAction, reverseCreditNoteAction } from '@/server/actions/compliance-actions';
import type { BadgeTone } from '@/lib/constants';

export type CreditNoteRow = {
  id: string;
  number: string;
  date: string;
  dateSort: number;
  party: string;
  againstDocument: string | null;
  reason: string;
  currency: string;
  netLabel: string;
  taxLabel: string | null;
  totalLabel: string;
  totalSort: number;
  returnsStock: boolean;
  warehouseNames: string;
  status: string;
};

const STATUS_TONES: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  POSTED: 'success',
  REVERSED: 'danger',
};

export function CreditNotesClient({
  rows,
  basePath,
  kind,
  canCreate,
  canPost,
}: {
  rows: CreditNoteRow[];
  basePath: string;
  kind: 'customer' | 'supplier';
  canCreate: boolean;
  canPost: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reversing, setReversing] = React.useState<CreditNoteRow | null>(null);

  const noun = kind === 'customer' ? 'credit note' : 'debit note';

  async function post(row: CreditNoteRow) {
    setBusy(row.id);
    try {
      const result = await postCreditNoteAction(row.id);
      if (result.ok) {
        toast.success(`${row.number} posted.`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(null);
    }
  }

  const columns: DataColumn<CreditNoteRow>[] = [
    {
      id: 'number',
      header: 'Number',
      mobile: 'title',
      sortValue: (r) => r.number,
      cell: (r) => (
        <Link href={`${basePath}/${r.id}`} className="font-medium text-forest-700 hover:underline">
          {r.number}
        </Link>
      ),
    },
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.dateSort, cell: (r) => r.date },
    {
      id: 'party',
      header: kind === 'customer' ? 'Customer' : 'Supplier',
      mobile: 'meta',
      sortValue: (r) => r.party,
      cell: (r) => (
        <span>
          <span className="block">{r.party}</span>
          {r.againstDocument ? (
            <span className="block text-xs text-ink-subtle">against {r.againstDocument}</span>
          ) : (
            <span className="block text-xs text-ink-subtle">not against a document</span>
          )}
        </span>
      ),
    },
    {
      id: 'warehouse',
      header: 'Warehouse',
      mobile: 'meta',
      sortValue: (r) => r.warehouseNames,
      exportValue: (r) => r.warehouseNames,
      cell: (r) => r.warehouseNames || '—',
    },
    {
      id: 'reason',
      header: 'Reason',
      hideable: true,
      cell: (r) => <span className="text-xs text-ink-muted">{r.reason}</span>,
    },
    {
      id: 'amount',
      header: 'Amount',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.totalSort,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.totalLabel}</span>
          {r.taxLabel ? (
            <span className="block text-xs text-ink-subtle">
              {r.netLabel} + {r.taxLabel} tax
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'stock',
      header: 'Stock',
      hideable: true,
      cell: (r) =>
        r.returnsStock ? (
          <Badge tone="info">Returns coffee</Badge>
        ) : (
          <span className="text-xs text-ink-subtle">Value only</span>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <Badge tone={STATUS_TONES[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</Badge>,
    },
    {
      id: 'linked',
      header: 'Against',
      hideable: true,
      sortValue: (r) => r.againstDocument ?? '',
      exportValue: (r) => r.againstDocument ?? '',
      cell: (r) => r.againstDocument ?? <span className="text-ink-subtle">—</span>,
    },
    {
      id: 'currency',
      header: 'Currency',
      hideable: true,
      sortValue: (r) => r.currency,
      exportValue: (r) => r.currency,
      cell: (r) => r.currency,
    },
    {
      id: 'actions',
      header: 'Actions',
      mobile: 'action',
      pin: 'right',
      printHidden: true,
      cell: (r: CreditNoteRow) => (
        <RowActions
          actions={[
            viewAction(`${basePath}/${r.id}`),
            editAction(`${basePath}/${r.id}/edit`, r.status === 'DRAFT'),
            {
              label: 'Post',
              icon: CheckCircle2,
              show: canPost && r.status === 'DRAFT',
              disabled: busy === r.id,
              onSelect: () => post(r),
            },
          ]}
          destructive={{
            status: r.status,
            noun,
            show: canPost && r.status === 'POSTED',
            description: `Deletes the ${noun}: it is taken back out of the books${
              r.returnsStock ? ', the coffee it returned goes back out of the warehouse,' : ''
            } and it disappears from every list and total.`,
            run: async (reason) => {
              const result = await reverseCreditNoteAction(r.id, reason ?? '');
              return { ok: result.ok, error: result.ok ? undefined : result.error };
            },
          }}
        />
      ),
    } satisfies DataColumn<CreditNoteRow>,
  ];

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        searchValue={(r) => `${r.number} ${r.party} ${r.reason} ${r.againstDocument ?? ''} ${r.warehouseNames}`}
        searchPlaceholder={`Search ${noun}s…`}
        emptyTitle={`No ${noun}s yet`}
        emptyDescription={
          kind === 'customer'
            ? 'Raise one when a customer is short-shipped, sends coffee back, or is owed an allowance. The original invoice stays on file.'
            : 'Raise one when a supplier owes you an allowance or you send coffee back to them.'
        }
        emptyAction={
          canCreate ? (
            <Button asChild>
              <Link href={`${basePath}/new`}>
                <Plus />
                New {noun}
              </Link>
            </Button>
          ) : undefined
        }
        toolbar={
          canCreate ? (
            <Button asChild>
              <Link href={`${basePath}/new`}>
                <Plus />
                <span className="hidden sm:inline">New {noun}</span>
                <span className="sm:hidden">New</span>
              </Link>
            </Button>
          ) : undefined
        }
      />

      <ConfirmDialog
        open={Boolean(reversing)}
        onOpenChange={(open) => !open && setReversing(null)}
        title={`Delete ${reversing?.number ?? ''}?`}
        description={
          reversing?.returnsStock
            ? 'The note is taken back out of the books and the coffee it brought back is taken out of the warehouse again. If it has since been sold, the deletion will be refused.'
            : 'The note is taken back out of the books and disappears from every list and total.'
        }
        confirmLabel="Delete"
        variant="danger"
        requireReason
        reasonLabel="Why is this being deleted?"
        onConfirm={async (reason) => {
          if (!reversing) return;
          const result = await reverseCreditNoteAction(reversing.id, reason ?? '');
          if (result.ok) {
            toast.success(`${reversing.number} reversed.`);
            router.refresh();
          } else {
            throw new Error(result.error);
          }
        }}
      />
    </>
  );
}
