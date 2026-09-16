'use client';

import * as React from 'react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Layers, History } from 'lucide-react';
import { RowActions, viewAction } from '@/components/shared/row-actions';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { TRANSACTION_STATUS_META } from '@/lib/constants';

export type GoodsReceiptRow = {
  id: string;
  grnNumber: string;
  receiptDate: string;
  receiptDateSort: number;
  contractId: string;
  contractNumber: string;
  contractReference: string;
  vendorName: string;
  warehouseName: string;
  warehouseCode: string;
  itemNames: string;
  quantityLabel: string;
  quantityKg: number;
  bags: number;
  lineCount: number;
  receivedBy: string;
  status: string;
};

export function GoodsReceiptsClient({
  rows,
  emptyAction,
}: {
  rows: GoodsReceiptRow[];
  /** Rendered inside the empty state; built on the server so permissions are checked there. */
  emptyAction?: React.ReactNode;
}) {
  const columns: DataColumn<GoodsReceiptRow>[] = [
    {
      id: 'grn',
      header: 'Receipt',
      mobile: 'title',
      sortValue: (r) => r.grnNumber,
      cell: (r) => <span className="font-medium">{r.grnNumber}</span>,
    },
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.receiptDateSort, cell: (r) => r.receiptDate },
    {
      id: 'contract',
      header: 'Contract',
      mobile: 'meta',
      sortValue: (r) => r.contractNumber,
      cell: (r) => (
        <span>
          <span className="block">{r.contractNumber}</span>
          <span className="block text-xs text-ink-subtle">{r.contractReference}</span>
        </span>
      ),
    },
    { id: 'vendor', header: 'Supplier', hideable: true, sortValue: (r) => r.vendorName, cell: (r) => r.vendorName },
    {
      id: 'warehouse',
      header: 'Warehouse',
      mobile: 'meta',
      sortValue: (r) => r.warehouseName,
      cell: (r) => <Badge tone="info">{r.warehouseName}</Badge>,
    },
    {
      id: 'coffee',
      header: 'Coffee',
      hideable: true,
      cell: (r) => <span className="block max-w-56 truncate text-xs">{r.itemNames}</span>,
    },
    {
      id: 'quantity',
      header: 'Received',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.quantityKg,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.quantityLabel}</span>
          <span className="block text-xs text-ink-subtle">{r.bags.toLocaleString()} bags</span>
        </span>
      ),
    },
    { id: 'by', header: 'Received by', hideable: true, defaultHidden: true, cell: (r) => r.receivedBy },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={TRANSACTION_STATUS_META} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      mobile: 'action',
      pin: 'right',
      printHidden: true,
      // A receipt is not edited on its own: it belongs to the purchase
      // order, which is where the ordered quantities and batches live.
      cell: (r) => (
        <RowActions
          actions={[
            viewAction(`/purchases/${r.contractId}`),
            { label: 'Batches', href: `/inventory/batches?q=${encodeURIComponent(r.grnNumber)}`, icon: Layers },
            { label: 'Stock movements', href: '/inventory/movements', icon: History, overflowOnly: true },
          ]}
        />
      ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/purchases/${r.contractId}`}
      filters={[
        { id: 'status', label: 'Status', value: (r) => r.status },
        { id: 'warehouse', label: 'Warehouse', value: (r) => r.warehouseName },
        { id: 'supplier', label: 'Supplier', value: (r) => r.vendorName },
      ]}
      searchValue={(r) =>
        `${r.grnNumber} ${r.contractNumber} ${r.contractReference} ${r.vendorName} ${r.warehouseName} ${r.itemNames}`
      }
      searchPlaceholder="Search by receipt, contract, supplier or warehouse…"
      emptyAction={emptyAction}
      emptyTitle="No goods receipts yet"
      emptyDescription="Approve a purchase contract, then record a receipt when the containers arrive."
    />
  );
}
