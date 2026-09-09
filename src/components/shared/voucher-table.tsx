'use client';

import * as React from 'react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { StatusBadge, Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/lib/constants';

export type VoucherRow = {
  id: string;
  number: string;
  date: string;
  dateSort: number;
  party: string;
  account: string;
  method: string;
  currency: string;
  amount: string;
  amountSort: number;
  amountUsd: string;
  rate: string;
  reference: string | null;
  allocationCount: number;
  status: string;
};

/** Shared list for receipts and payments, which differ only in wording. */
export function VoucherTable({
  rows,
  basePath,
  partyLabel,
  statusMeta,
  emptyTitle,
  emptyDescription,
  emptyAction,
}: {
  rows: VoucherRow[];
  basePath: string;
  partyLabel: string;
  statusMeta: Record<string, { label: string; tone: BadgeTone }>;
  emptyTitle: string;
  emptyDescription: string;
  emptyAction?: React.ReactNode;
}) {
  const columns: DataColumn<VoucherRow>[] = [
    {
      id: 'number',
      header: 'Voucher',
      mobile: 'title',
      sortValue: (r) => r.number,
      cell: (r) => <span className="font-medium">{r.number}</span>,
    },
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.dateSort, cell: (r) => r.date },
    { id: 'party', header: partyLabel, mobile: 'meta', sortValue: (r) => r.party, cell: (r) => r.party },
    {
      id: 'amount',
      header: 'Amount',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.amountSort,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.amount}</span>
          {r.currency !== 'USD' ? <span className="block text-xs text-ink-subtle">{r.amountUsd}</span> : null}
        </span>
      ),
    },
    { id: 'rate', header: 'Rate', numeric: true, hideable: true, cell: (r) => r.rate },
    {
      id: 'method',
      header: 'Method',
      hideable: true,
      sortValue: (r) => r.method,
      cell: (r) => <Badge tone="neutral">{r.method}</Badge>,
    },
    { id: 'account', header: 'Account', hideable: true, cell: (r) => r.account },
    { id: 'reference', header: 'Reference', hideable: true, defaultHidden: true, cell: (r) => r.reference ?? '—' },
    {
      id: 'applied',
      header: 'Applied to',
      numeric: true,
      hideable: true,
      cell: (r) => (r.allocationCount > 0 ? `${r.allocationCount} doc` : 'On account'),
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={statusMeta} />,
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `${basePath}/${r.id}`}
      searchValue={(r) => `${r.number} ${r.party} ${r.reference ?? ''} ${r.account}`}
      searchPlaceholder="Search voucher, party or reference…"
      emptyAction={emptyAction}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
    />
  );
}
