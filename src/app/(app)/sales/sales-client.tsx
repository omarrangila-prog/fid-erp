'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pencil, Plus } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { TRANSACTION_STATUS_META, SETTLEMENT_STATUS_META } from '@/lib/constants';
import { InvoiceDeleteButton } from '@/app/(app)/sales/[id]/sale-actions';

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
}: {
  rows: SaleRow[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReverse: boolean;
}) {
  const router = useRouter();
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
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={TRANSACTION_STATUS_META} />,
    },
    ...(canEdit || canDelete || canReverse
      ? [
          {
            id: 'actions',
            header: '',
            printHidden: true,
            mobile: 'action' as const,
            cell: (r: SaleRow) => {
              const canCancel =
                r.status === 'DRAFT'
                  ? canDelete
                  : r.status === 'POSTED'
                    ? canDelete || canReverse
                    : r.status === 'REVERSED'
                      ? canDelete || canReverse
                      : false;
              const showEdit = canEdit && (r.status === 'DRAFT' || r.status === 'POSTED');
              if (!canCancel && !showEdit) return null;
              return (
                <div
                  className="flex flex-wrap items-center justify-end gap-1"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  {showEdit ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        router.push(`/sales/${r.id}/edit`);
                      }}
                    >
                      <Pencil />
                      Edit
                    </Button>
                  ) : null}
                  {canCancel ? <InvoiceDeleteButton id={r.id} status={r.status} /> : null}
                </div>
              );
            },
          } satisfies DataColumn<SaleRow>,
        ]
      : []),
  ];

  return (
    <DataTable
      data={rows}
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
        canCreate ? (
          <Button asChild>
            <Link href="/sales/new">
              <Plus />
              <span className="hidden sm:inline">New invoice</span>
              <span className="sm:hidden">New</span>
            </Link>
          </Button>
        ) : undefined
      }
    />
  );
}

export { Badge };
