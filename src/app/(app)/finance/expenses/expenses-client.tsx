'use client';

import * as React from 'react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { TRANSACTION_STATUS_META } from '@/lib/constants';
import { VoucherRowActions } from '@/components/shared/voucher-actions';

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
  kind: 'SHIPMENT' | 'GENERAL';
  payee: string | null;
  enteredBy: string;
  reference: string | null;
  status: string;
  warehouseNames: string;
};

export function ExpensesClient({
  rows,
  canExport,
  emptyAction,
  canPost = false,
  canDelete = false,
}: {
  rows: ExpenseRow[];
  canExport: boolean;
  /** Rendered inside the empty state; built on the server so permissions are checked there. */
  emptyAction?: React.ReactNode;
  canPost?: boolean;
  canDelete?: boolean;
}) {
  const columns: DataColumn<ExpenseRow>[] = [
    { id: 'number', header: 'Voucher', mobile: 'title', sortValue: (r) => r.number, exportValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.dateSort, exportValue: (r) => r.date, cell: (r) => r.date },
    { id: 'category', header: 'Category', mobile: 'meta', sortValue: (r) => r.category, exportValue: (r) => r.category, cell: (r) => r.category },
    {
      id: 'type',
      header: 'Type',
      mobile: 'badge',
      sortValue: (r) => r.kind,
      exportValue: (r) => (r.kind === 'SHIPMENT' ? 'Shipment' : 'Company'),
      cell: (r) => (
        <Badge tone={r.kind === 'SHIPMENT' ? 'info' : 'neutral'}>
          {r.kind === 'SHIPMENT' ? 'Shipment' : 'Company'}
        </Badge>
      ),
    },
    { id: 'job', header: 'Job', mobile: 'meta', exportValue: (r) => r.job ?? '', cell: (r) => r.job ?? '—' },
    {
      id: 'warehouse',
      header: 'Warehouse',
      mobile: 'meta',
      sortValue: (r) => r.warehouseNames,
      exportValue: (r) => r.warehouseNames,
      cell: (r) => r.warehouseNames || '—',
    },
    { id: 'payee', header: 'Payee', hideable: true, exportValue: (r) => r.payee ?? '', cell: (r) => r.payee ?? '—' },
    { id: 'enteredBy', header: 'Entered by', hideable: true, defaultHidden: true, exportValue: (r) => r.enteredBy, cell: (r) => r.enteredBy },
    {
      id: 'amount',
      header: 'Amount',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.amountSort,
      exportValue: (r) => r.amountSort,
      exportType: 'money',
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.amount}</span>
          {r.currency !== 'USD' ? <span className="block text-xs text-ink-subtle">{r.amountUsd}</span> : null}
        </span>
      ),
    },
    {
      id: 'faceValue',
      header: 'Voucher amount',
      hideable: true,
      defaultHidden: true,
      exportValue: (r) => `${r.currency} ${r.amount}`,
      cell: (r) => `${r.currency} ${r.amount}`,
    },
    {
      id: 'treatment',
      header: 'Treatment',
      hideable: true,
      exportValue: (r) => (r.capitalise ? 'Landed cost' : 'Period cost'),
      cell: (r) => (
        <Badge tone={r.capitalise ? 'info' : 'neutral'}>{r.capitalise ? 'Landed cost' : 'Period cost'}</Badge>
      ),
    },
    { id: 'account', header: 'Paid from', hideable: true, exportValue: (r) => r.account, cell: (r) => r.account },
    {
      id: 'costImpact',
      header: 'Shipment cost',
      hideable: true,
      exportValue: (r) => (r.kind === 'SHIPMENT' ? (r.capitalise ? 'In landed cost' : 'On shipment P&L') : 'Not on shipment'),
      cell: (r) =>
        r.kind === 'SHIPMENT' ? (r.capitalise ? 'In landed cost' : 'On shipment P&L') : '—',
    },
    { id: 'reference', header: 'Reference', hideable: true, defaultHidden: true, exportValue: (r) => r.reference ?? '', cell: (r) => r.reference ?? '—' },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      exportValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={TRANSACTION_STATUS_META} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      printHidden: true,
      mobile: 'action',
      pin: 'right',
      cell: (r) => (
        <VoucherRowActions
          kind="expense"
          id={r.id}
          status={r.status}
          canPost={canPost}
          canDelete={canDelete}
        />
      ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/finance/expenses/${r.id}`}
      searchValue={(r) => `${r.number} ${r.category} ${r.job ?? ''} ${r.reference ?? ''} ${r.warehouseNames}`}
      searchPlaceholder="Search voucher, category or job…"
      emptyAction={emptyAction}
      emptyTitle="No expenses yet"
      emptyDescription="Record shipment and operating costs. Direct shipment costs raise the landed cost of the coffee."
      exportFileName={canExport ? 'expenses' : undefined}
      exportTitle="Expense Vouchers"
    />
  );
}
