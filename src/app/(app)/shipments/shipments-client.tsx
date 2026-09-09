'use client';

import * as React from 'react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { StatusBadge } from '@/components/ui/badge';
import { SHIPMENT_STATUS_META, DOCUMENT_STATUS_META, SETTLEMENT_STATUS_META } from '@/lib/constants';

export type ShipmentRow = {
  id: string;
  shipmentNumber: string;
  jobNumber: string;
  contractNumber: string;
  vendorName: string;
  customerName: string | null;
  itemName: string;
  origin: string | null;
  quantityLabel: string;
  quantitySort: number;
  bags: number;
  containers: number;
  bookingNumber: string | null;
  billOfLading: string | null;
  vesselName: string | null;
  shippingLine: string | null;
  etaDate: string;
  etaSort: number;
  etaDays: number | null;
  status: string;
  documentStatus: string;
  settlement: string;
  soldPct: number;
  soldLabel: string;
};

export function ShipmentsClient({
  rows,
  emptyAction,
}: {
  rows: ShipmentRow[];
  /** Rendered inside the empty state; built on the server so permissions are checked there. */
  emptyAction?: React.ReactNode;
}) {
  const columns: DataColumn<ShipmentRow>[] = [
    {
      id: 'number',
      header: 'Shipment / Job',
      mobile: 'title',
      sortValue: (r) => r.shipmentNumber,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.shipmentNumber}</span>
          <span className="block text-xs text-ink-subtle">{r.jobNumber}</span>
        </span>
      ),
    },
    { id: 'coffee', header: 'Coffee', mobile: 'meta', sortValue: (r) => r.itemName, cell: (r) => r.itemName },
    { id: 'vendor', header: 'Supplier', mobile: 'meta', sortValue: (r) => r.vendorName, cell: (r) => r.vendorName },
    {
      id: 'quantity',
      header: 'Quantity',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.quantitySort,
      cell: (r) => (
        <span>
          <span className="block">{r.quantityLabel}</span>
          <span className="block text-xs text-ink-subtle">
            {r.bags.toLocaleString()} bags · {r.containers} ctr
          </span>
        </span>
      ),
    },
    {
      id: 'sold',
      header: 'Sold',
      hideable: true,
      sortValue: (r) => r.soldPct,
      cell: (r) => (
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-14 overflow-hidden rounded-full bg-forest-100">
            <span
              className={r.soldPct >= 100 ? 'block h-full bg-gold-500' : 'block h-full bg-sky-500'}
              style={{ width: `${Math.min(100, r.soldPct)}%` }}
            />
          </span>
          <span className="text-xs text-ink-muted">{r.soldLabel}</span>
        </span>
      ),
    },
    {
      id: 'booking',
      header: 'Booking / B/L',
      hideable: true,
      cell: (r) => (
        <span className="text-xs">
          <span className="block">{r.bookingNumber ?? '—'}</span>
          <span className="block text-ink-subtle">{r.billOfLading ?? '—'}</span>
        </span>
      ),
    },
    {
      id: 'line',
      header: 'Line / Vessel',
      hideable: true,
      defaultHidden: true,
      cell: (r) => (
        <span className="text-xs">
          <span className="block">{r.shippingLine ?? '—'}</span>
          <span className="block text-ink-subtle">{r.vesselName ?? '—'}</span>
        </span>
      ),
    },
    {
      id: 'eta',
      header: 'ETA',
      mobile: 'meta',
      sortValue: (r) => r.etaSort,
      cell: (r) => (
        <span>
          <span className="block">{r.etaDate}</span>
          {r.etaDays !== null ? (
            <span className={`block text-xs ${r.etaDays <= 3 ? 'font-medium text-amber-700' : 'text-ink-subtle'}`}>
              {r.etaDays < 0 ? `${Math.abs(r.etaDays)}d late` : r.etaDays === 0 ? 'today' : `in ${r.etaDays}d`}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'documents',
      header: 'Documents',
      hideable: true,
      sortValue: (r) => r.documentStatus,
      cell: (r) => <StatusBadge status={r.documentStatus} meta={DOCUMENT_STATUS_META} />,
    },
    {
      id: 'payment',
      header: 'Payment',
      hideable: true,
      sortValue: (r) => r.settlement,
      cell: (r) => <StatusBadge status={r.settlement} meta={SETTLEMENT_STATUS_META} />,
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={SHIPMENT_STATUS_META} />,
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/shipments/${r.id}`}
      searchValue={(r) =>
        `${r.shipmentNumber} ${r.jobNumber} ${r.contractNumber} ${r.vendorName} ${r.itemName} ${r.bookingNumber ?? ''} ${r.billOfLading ?? ''} ${r.vesselName ?? ''}`
      }
      searchPlaceholder="Search by shipment, job, booking, B/L or vessel…"
      emptyAction={emptyAction}
      emptyTitle="No shipments yet"
      emptyDescription="A job is opened automatically when a purchase contract is approved."
    />
  );
}
