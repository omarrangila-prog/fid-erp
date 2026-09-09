'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { TRANSACTION_STATUS_META } from '@/lib/constants';
import { downloadCsv, exportFilename } from '@/lib/export-csv';

export type ExpenseRow = {
  id: string;
  number: string;
  date: string;
  dateSort: number;
  category: string;
  job: string | null;
  jobId: string | null;
  currency: string;
  amount: string;
  amountSort: number;
  amountUsd: string;
  account: string;
  capitalise: boolean;
  reference: string | null;
  status: string;
};

export function ExpensesClient({
  rows,
  companyCode,
  canExport,
  emptyAction,
}: {
  rows: ExpenseRow[];
  companyCode: string;
  canExport: boolean;
  /** Rendered inside the empty state; built on the server so permissions are checked there. */
  emptyAction?: React.ReactNode;
}) {
  const columns: DataColumn<ExpenseRow>[] = [
    { id: 'number', header: 'Voucher', mobile: 'title', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.dateSort, cell: (r) => r.date },
    { id: 'category', header: 'Category', mobile: 'meta', sortValue: (r) => r.category, cell: (r) => r.category },
    { id: 'job', header: 'Job', mobile: 'meta', cell: (r) => r.job ?? '—' },
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
    {
      id: 'treatment',
      header: 'Treatment',
      hideable: true,
      cell: (r) => (
        <Badge tone={r.capitalise ? 'info' : 'neutral'}>{r.capitalise ? 'Landed cost' : 'Period cost'}</Badge>
      ),
    },
    { id: 'account', header: 'Paid from', hideable: true, cell: (r) => r.account },
    { id: 'reference', header: 'Reference', hideable: true, defaultHidden: true, cell: (r) => r.reference ?? '—' },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={TRANSACTION_STATUS_META} />,
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/finance/expenses/${r.id}`}
      searchValue={(r) => `${r.number} ${r.category} ${r.job ?? ''} ${r.reference ?? ''}`}
      searchPlaceholder="Search voucher, category or job…"
      emptyAction={emptyAction}
      emptyTitle="No expenses yet"
      emptyDescription="Record shipment and operating costs. Direct shipment costs raise the landed cost of the coffee."
      toolbar={
        canExport ? (
          <Button
            variant="outline"
            onClick={() =>
              downloadCsv(
                exportFilename(companyCode, 'expenses'),
                ['Voucher', 'Date', 'Category', 'Job', 'Currency', 'Amount', 'USD', 'Treatment', 'Paid from', 'Status'],
                rows.map((r) => [
                  r.number, r.date, r.category, r.job, r.currency, r.amountSort, r.amountUsd,
                  r.capitalise ? 'Landed cost' : 'Period cost', r.account, r.status,
                ]),
              )
            }
          >
            <Download />
            <span className="hidden sm:inline">Export</span>
          </Button>
        ) : undefined
      }
    />
  );
}
