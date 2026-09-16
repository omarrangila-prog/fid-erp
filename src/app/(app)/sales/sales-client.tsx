'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { TRANSACTION_STATUS_META, SETTLEMENT_STATUS_META } from '@/lib/constants';
import { HandCoins, BookOpen, Printer } from 'lucide-react';
import { RowActions, viewAction, editAction } from '@/components/shared/row-actions';
import { deleteSalesInvoiceAction } from '@/server/actions/trading-actions';

export type SaleRow = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceDateSort: number;
  dueDate: string;
  dueDateSort: number;
  customerName: string;
  customerId: string;
  currency: string;
  totalAmount: string;
  totalAmountSort: number;
  totalAmountUsd: string;
  quantityLabel: string;
  quantitySort: number;
  paidLabel: string;
  outstandingLabel: string;
  settlement: string;
  daysOverdue: number;
  status: string;
  paymentType: string;
  createdBy: string;
  items: string;
  itemCount: number;
  jobNumber: string | null;
  shipmentId: string | null;
  warehouseNames: string;
};

export function SalesClient({
  rows,
  canCreate,
  canEdit,
  canDelete,
  canReverse,
  canApprove,
}: {
  rows: SaleRow[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReverse: boolean;
  canApprove: boolean;
}) {
  // A cancelled invoice stays in the books and on this list, out of the way
  // by default. It is never deleted: its journals and the receipts that
  // settled it still point at it.
  const [showCancelled, setShowCancelled] = React.useState(false);
  const visible = React.useMemo(
    () => (showCancelled ? rows : rows.filter((r) => r.status !== 'REVERSED')),
    [rows, showCancelled],
  );
  const cancelledCount = rows.length - visible.length;

  const columns: DataColumn<SaleRow>[] = [
    {
      id: 'number',
      header: 'Invoice',
      mobile: 'title',
      sortValue: (r) => r.invoiceNumber,
      cell: (r) => <span className="font-medium">{r.invoiceNumber}</span>,
    },
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.invoiceDateSort, cell: (r) => r.invoiceDate },
    {
      id: 'customer',
      header: 'Customer',
      mobile: 'meta',
      sortValue: (r) => r.customerName,
      cell: (r) => r.customerName,
    },
    {
      id: 'warehouse',
      header: 'Warehouse',
      mobile: 'meta',
      sortValue: (r) => r.warehouseNames,
      cell: (r) => r.warehouseNames || '—',
    },
    {
      id: 'items',
      header: 'Items',
      mobile: 'meta',
      hideable: true,
      sortValue: (r) => r.items,
      exportValue: (r) => r.items,
      cell: (r) => (
        <span className="block max-w-56 truncate" title={r.items}>
          {r.items || '—'}
          {r.itemCount > 1 ? <span className="ml-1 text-xs text-ink-subtle">({r.itemCount})</span> : null}
        </span>
      ),
    },
    {
      id: 'quantity',
      header: 'Quantity',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.quantitySort,
      cell: (r) => r.quantityLabel,
    },
    {
      id: 'value',
      header: 'Value',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.totalAmountSort,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.totalAmount}</span>
          {r.currency !== 'USD' ? <span className="block text-xs text-ink-subtle">{r.totalAmountUsd}</span> : null}
        </span>
      ),
    },
    { id: 'paid', header: 'Paid', numeric: true, hideable: true, cell: (r) => r.paidLabel },
    {
      id: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      hideable: true,
      cell: (r) => <span className="font-medium">{r.outstandingLabel}</span>,
    },
    {
      id: 'due',
      header: 'Due',
      hideable: true,
      sortValue: (r) => r.dueDateSort,
      cell: (r) => (
        <span>
          <span className="block">{r.dueDate}</span>
          {r.daysOverdue > 0 && r.settlement !== 'PAID' ? (
            <span className="block text-xs font-medium text-red-600">{r.daysOverdue}d overdue</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'settlement',
      header: 'Payment',
      hideable: true,
      sortValue: (r) => r.settlement,
      cell: (r) =>
        r.status === 'POSTED' ? (
          <StatusBadge status={r.settlement} meta={SETTLEMENT_STATUS_META} />
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
    },
    {
      id: 'job',
      header: 'Job',
      hideable: true,
      defaultHidden: true,
      cell: (r) =>
        r.shipmentId ? (
          <Link href={`/shipments/${r.shipmentId}`} className="text-gold-700 hover:underline">
            {r.jobNumber}
          </Link>
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
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
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={TRANSACTION_STATUS_META} />,
    },
    {
      id: 'createdBy',
      header: 'Created by',
      hideable: true,
      defaultHidden: true,
      sortValue: (r) => r.createdBy,
      exportValue: (r) => r.createdBy,
      cell: (r) => <span className="text-xs text-ink-muted">{r.createdBy}</span>,
    },
    ...(canEdit || canDelete || canReverse || canApprove
      ? [
          {
            id: 'actions',
            header: 'Actions',
            printHidden: true,
            mobile: 'action' as const,
            pin: 'right' as const,
            cell: (r: SaleRow) => (
              <RowActions
                actions={[
                  viewAction(`/sales/${r.id}`),
                  editAction(`/sales/${r.id}/edit`, canEdit && r.status !== 'REVERSED'),
                  {
                    label: 'Record payment',
                    href: `/finance/receipts/new?invoice=${r.id}`,
                    icon: HandCoins,
                    show: r.status === 'POSTED' && r.settlement !== 'PAID',
                  },
                  { label: 'Customer ledger', href: `/ledgers/customers?customer=${r.customerId}`, icon: BookOpen },
                  { label: 'Print', href: `/sales/${r.id}/print`, icon: Printer },
                ]}
                destructive={{
                  status: r.status,
                  noun: 'invoice',
                  show: r.status === 'DRAFT' ? canDelete : canReverse,
                  cancelLabel: 'Cancel invoice',
                  description:
                    'Stock returns to the warehouse it left, the customer balance is reversed, and a contra journal keeps the ledger in balance. The invoice stays in the books marked cancelled — nothing is deleted.',
                  run: (reason) => deleteSalesInvoiceAction(r.id, reason).then((res) => ({ ok: res.ok, error: res.ok ? undefined : res.error })),
                }}
              />
            ),
          } satisfies DataColumn<SaleRow>,
        ]
      : []),
  ];

  return (
    <DataTable
      data={visible}
      filters={[
      { id: 'status', label: 'Status', value: (r) => r.status },
      { id: 'settlement', label: 'Payment', value: (r) => r.settlement },
      { id: 'customer', label: 'Customer', value: (r) => r.customerName },
      { id: 'currency', label: 'Currency', value: (r) => r.currency },
      { id: 'warehouse', label: 'Warehouse', value: (r) => r.warehouseNames || null },
      ]}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/sales/${r.id}`}
      searchValue={(r) => `${r.invoiceNumber} ${r.customerName} ${r.jobNumber ?? ''} ${r.warehouseNames}`}
      searchPlaceholder="Search by invoice, customer or job…"
      emptyTitle="No sales invoices yet"
      emptyDescription="Sell coffee from a batch in a warehouse. Posting raises the receivable and relieves the stock."
      emptyAction={
        canCreate ? (
          <Button asChild>
            <Link href="/sales/new">
              <Plus />
              New invoice
            </Link>
          </Button>
        ) : undefined
      }
      toolbar={
        <>
          {rows.some((r) => r.status === 'REVERSED') ? (
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                checked={showCancelled}
                onChange={(e) => setShowCancelled(e.target.checked)}
                className="size-4 rounded border-line"
              />
              Show cancelled{showCancelled ? '' : ` (${cancelledCount})`}
            </label>
          ) : null}
          {canCreate ? (
            <Button asChild>
              <Link href="/sales/new">
                <Plus />
                <span className="hidden sm:inline">New invoice</span>
                <span className="sm:hidden">New</span>
              </Link>
            </Button>
          ) : null}
        </>
      }
    />
  );
}

export { Badge };
