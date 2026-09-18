'use client';

import * as React from 'react';
import Link from 'next/link';
import { shortDocumentNumber } from '@/lib/short-number';
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
  /** The client's own ICUL/FID reference for the job. */
  reference: string | null;
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
  // A deleted invoice is not on this list at all: the page only loads live
  // documents. Its journal and the trail of who deleted it stay in the books
  // and the audit log, where an accountant can find them.
  const visible = rows;

  const columns: DataColumn<SaleRow>[] = [
    /* The order the client reads a sales list in: when, which invoice, which
       order it came from, who it went to, where it stands, when it is due,
       how much, how much is left, and out of which warehouse. */
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.invoiceDateSort, cell: (r) => r.invoiceDate },
    {
      id: 'number',
      header: 'Invoice #',
      mobile: 'title',
      sortValue: (r) => r.invoiceNumber,
      exportValue: (r) => shortDocumentNumber(r.invoiceNumber),
      // INV 8, not FID-MA-SI-000008. The full number stays in the database,
      // on the printed tax invoice where the law wants it, and in search.
      cell: (r) => <span className="tnum font-medium">{shortDocumentNumber(r.invoiceNumber)}</span>,
    },
    {
      id: 'order',
      header: 'Order no.',
      mobile: 'meta',
      sortValue: (r) => r.reference ?? '',
      exportValue: (r) => r.reference ?? '',
      cell: (r) => <span className="font-mono text-xs text-ink-muted">{r.reference ?? '—'}</span>,
    },
    {
      id: 'customer',
      header: 'Customer',
      mobile: 'meta',
      sortValue: (r) => r.customerName,
      cell: (r) => <span className="font-medium">{r.customerName}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={TRANSACTION_STATUS_META} />,
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
    {
      id: 'outstanding',
      header: 'Balance due',
      numeric: true,
      hideable: true,
      cell: (r) => <span className="font-medium">{r.outstandingLabel}</span>,
    },
    {
      id: 'warehouse',
      header: 'Location',
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
    { id: 'paid', header: 'Paid', numeric: true, hideable: true, cell: (r) => r.paidLabel },
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
            {r.reference ?? '—'}
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
                  cancelLabel: 'Delete invoice',
                  description:
                    'Stock returns to the warehouse it left and the customer balance and ledger are put back as they were. The invoice disappears from every list and total. The audit log keeps a record of who deleted it and why.',
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
      prefsKey="sales"
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
