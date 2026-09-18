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
  lines: Array<{
    itemName: string;
    batchNumber: string;
    containerNumber: string;
    quantityLabel: string;
    bags: number;
  }>;
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
    /* The receipt number was the system's own. The reference column below
       carries the client's, and the whole row opens the receipt. */
    { id: 'date', header: 'Date', mobile: 'title', sortValue: (r) => r.receiptDateSort, cell: (r) => <span className="font-medium">{r.receiptDate}</span> },
    {
      id: 'contract',
      header: 'Reference',
      mobile: 'meta',
      sortValue: (r) => r.contractReference,
      // The supplier's reference leads; the internal number sits beneath it.
      cell: (r) => (
        <span className="block min-w-44">
          <span className="block font-mono text-xs font-medium">{r.contractReference}</span>
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
      prefsKey="goods-receipts"
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/purchases/${r.contractId}`}
      filters={[
        { id: 'status', label: 'Status', value: (r) => r.status },
        { id: 'warehouse', label: 'Warehouse', value: (r) => r.warehouseName },
        { id: 'supplier', label: 'Supplier', value: (r) => r.vendorName },
      ]}
      expandedContent={(r) => (
        <div className="overflow-x-auto">
          <p className="mb-2 text-xs text-ink-muted">
            {r.lines.length === 1 ? 'What was received' : `The ${r.lines.length} lines received`}
          </p>
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="py-1.5 pr-3 font-medium">Item</th>
                <th className="py-1.5 pr-3 font-medium">Batch</th>
                <th className="py-1.5 pr-3 font-medium">Container</th>
                <th className="py-1.5 pr-3 text-right font-medium">Received</th>
                <th className="py-1.5 text-right font-medium">Bags</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((line, i) => (
                <tr key={`${line.batchNumber}-${i}`} className="border-b border-line/60 last:border-0">
                  <td className="py-1.5 pr-3 font-medium">{line.itemName}</td>
                  <td className="py-1.5 pr-3">{line.batchNumber}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{line.containerNumber}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{line.quantityLabel}</td>
                  <td className="py-1.5 text-right tabular-nums">{line.bags.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      searchValue={(r) =>
        `${r.grnNumber} ${r.contractNumber} ${r.contractReference} ${r.vendorName} ${r.warehouseName} ${r.itemNames} ${r.lines
          .map((l) => `${l.batchNumber} ${l.containerNumber}`)
          .join(' ')}`
      }
      searchPlaceholder="Search by reference, receipt, supplier, batch or container…"
      emptyAction={emptyAction}
      emptyTitle="No goods receipts yet"
      emptyDescription="Approve a purchase contract, then record a receipt when the containers arrive."
    />
  );
}
