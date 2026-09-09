'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, CheckCircle2, Undo2 } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
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
    ...(canPost
      ? [
          {
            id: 'actions',
            header: '',
            cell: (r: CreditNoteRow) => (
              <span className="flex items-center justify-end gap-1">
                {r.status === 'DRAFT' ? (
                  <Button size="sm" variant="accent" loading={busy === r.id} onClick={() => post(r)}>
                    <CheckCircle2 />
                    Post
                  </Button>
                ) : null}
                {r.status === 'POSTED' ? (
                  <Button size="sm" variant="outline" onClick={() => setReversing(r)}>
                    <Undo2 />
                    Reverse
                  </Button>
                ) : null}
              </span>
            ),
          } satisfies DataColumn<CreditNoteRow>,
        ]
      : []),
  ];

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        searchValue={(r) => `${r.number} ${r.party} ${r.reason} ${r.againstDocument ?? ''}`}
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
        title={`Reverse ${reversing?.number ?? ''}?`}
        description={
          reversing?.returnsStock
            ? 'A contra entry is written and the coffee this note brought back is taken out of the warehouse again. If it has since been sold, the reversal will be refused.'
            : 'A contra entry is written. Nothing is deleted — both documents stay in the history.'
        }
        confirmLabel="Reverse"
        variant="danger"
        requireReason
        reasonLabel="Why is this being reversed?"
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
