'use client';

import * as React from 'react';
import Link from 'next/link';
import { Download, Printer } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { SHIPMENT_STATUS_META, DOCUMENT_STATUS_META } from '@/lib/constants';
import { downloadCsv, exportFilename } from '@/lib/export-csv';

export type LoadingRow = {
  id: string;
  shipmentId: string;
  contractDate: string;
  contractDateSort: number;
  contractNumber: string;
  contractReference: string;
  vendorName: string;
  itemName: string;
  origin: string;
  lotNumber: string;
  batchNumber: string;
  containerNumber: string | null;
  quantityKg: string;
  quantitySort: number;
  bags: number;
  buyer: string | null;
  soldStatus: 'Sold' | 'Partly sold' | 'Unsold';
  shippingLine: string | null;
  bookingNumber: string | null;
  billOfLading: string | null;
  etaDate: string;
  etaSort: number;
  status: string;
  documentStatus: string;
};

/**
 * The loading sheet: one row per batch, which is how the logistics team
 * actually works — a container at a time, not a contract at a time.
 */
export function LoadingSheet({
  rows,
  companyCode,
  canExport,
}: {
  rows: LoadingRow[];
  companyCode: string;
  canExport: boolean;
}) {
  const [status, setStatus] = React.useState('ALL');
  const [sold, setSold] = React.useState('ALL');
  const [vendor, setVendor] = React.useState('ALL');

  const vendors = React.useMemo(() => [...new Set(rows.map((r) => r.vendorName))].sort(), [rows]);

  const filtered = React.useMemo(
    () =>
      rows.filter(
        (r) =>
          (status === 'ALL' || r.status === status) &&
          (sold === 'ALL' || r.soldStatus === sold) &&
          (vendor === 'ALL' || r.vendorName === vendor),
      ),
    [rows, status, sold, vendor],
  );

  const columns: DataColumn<LoadingRow>[] = [
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.contractDateSort, cell: (r) => r.contractDate },
    {
      id: 'contract',
      header: 'PO / Reference',
      mobile: 'title',
      sortValue: (r) => r.contractNumber,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.contractNumber}</span>
          <span className="block text-xs text-ink-subtle">{r.contractReference}</span>
        </span>
      ),
    },
    { id: 'vendor', header: 'Supplier', mobile: 'meta', sortValue: (r) => r.vendorName, cell: (r) => r.vendorName },
    {
      id: 'coffee',
      header: 'Coffee',
      mobile: 'meta',
      sortValue: (r) => r.itemName,
      cell: (r) => (
        <span>
          <span className="block">{r.itemName}</span>
          <span className="block text-xs text-ink-subtle">{r.origin}</span>
        </span>
      ),
    },
    {
      id: 'lot',
      header: 'Lot / Batch',
      mobile: 'meta',
      sortValue: (r) => r.batchNumber,
      cell: (r) => (
        <span>
          <span className="block">{r.lotNumber}</span>
          <span className="block text-xs text-ink-subtle">{r.batchNumber}</span>
        </span>
      ),
    },
    { id: 'container', header: 'Container', hideable: true, cell: (r) => r.containerNumber ?? '—' },
    {
      id: 'quantity',
      header: 'KG / Bags',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.quantitySort,
      cell: (r) => (
        <span>
          <span className="block">{r.quantityKg}</span>
          <span className="block text-xs text-ink-subtle">{r.bags.toLocaleString()} bags</span>
        </span>
      ),
    },
    { id: 'buyer', header: 'Buyer', hideable: true, cell: (r) => r.buyer ?? '—' },
    {
      id: 'sold',
      header: 'Sold',
      mobile: 'badge',
      sortValue: (r) => r.soldStatus,
      cell: (r) => (
        <Badge tone={r.soldStatus === 'Sold' ? 'success' : r.soldStatus === 'Partly sold' ? 'progress' : 'neutral'}>
          {r.soldStatus}
        </Badge>
      ),
    },
    { id: 'line', header: 'Shipping line', hideable: true, cell: (r) => r.shippingLine ?? '—' },
    { id: 'booking', header: 'Booking', hideable: true, cell: (r) => r.bookingNumber ?? '—' },
    { id: 'bl', header: 'B/L', hideable: true, cell: (r) => r.billOfLading ?? '—' },
    { id: 'eta', header: 'ETA', mobile: 'meta', sortValue: (r) => r.etaSort, cell: (r) => r.etaDate },
    {
      id: 'documents',
      header: 'Documents',
      hideable: true,
      defaultHidden: true,
      cell: (r) => <StatusBadge status={r.documentStatus} meta={DOCUMENT_STATUS_META} />,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={SHIPMENT_STATUS_META} />,
    },
  ];

  function exportCsv() {
    downloadCsv(
      exportFilename(companyCode, 'loading-sheet'),
      [
        'Date', 'PO', 'Contract Reference', 'Supplier', 'Coffee', 'Origin', 'Lot', 'Batch', 'Container',
        'KG', 'Bags', 'Buyer', 'Sold', 'Shipping Line', 'Booking', 'B/L', 'ETA', 'Shipment Status', 'Document Status',
      ],
      filtered.map((r) => [
        r.contractDate, r.contractNumber, r.contractReference, r.vendorName, r.itemName, r.origin,
        r.lotNumber, r.batchNumber, r.containerNumber, r.quantitySort, r.bags, r.buyer, r.soldStatus,
        r.shippingLine, r.bookingNumber, r.billOfLading, r.etaDate,
        SHIPMENT_STATUS_META[r.status]?.label ?? r.status,
        DOCUMENT_STATUS_META[r.documentStatus]?.label ?? r.documentStatus,
      ]),
    );
  }

  return (
    <DataTable
      data={filtered}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/shipments/${r.shipmentId}`}
      pageSize={50}
      searchValue={(r) =>
        `${r.contractNumber} ${r.contractReference} ${r.vendorName} ${r.itemName} ${r.lotNumber} ${r.batchNumber} ${r.containerNumber ?? ''} ${r.bookingNumber ?? ''} ${r.billOfLading ?? ''} ${r.buyer ?? ''}`
      }
      searchPlaceholder="Search lot, batch, container, booking, B/L…"
      emptyTitle="Nothing to load"
      emptyDescription="Approve a purchase contract to open a job and populate the loading sheet."
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-10 w-auto min-w-36">
            <option value="ALL">All statuses</option>
            {Object.entries(SHIPMENT_STATUS_META).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </Select>
          <Select value={sold} onChange={(e) => setSold(e.target.value)} className="h-10 w-auto min-w-32">
            <option value="ALL">Sold and unsold</option>
            <option value="Unsold">Unsold</option>
            <option value="Partly sold">Partly sold</option>
            <option value="Sold">Sold</option>
          </Select>
          <Select value={vendor} onChange={(e) => setVendor(e.target.value)} className="h-10 w-auto min-w-40">
            <option value="ALL">All suppliers</option>
            {vendors.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
          {canExport ? (
            <>
              <Button variant="outline" onClick={exportCsv}>
                <Download />
                <span className="hidden sm:inline">Export</span>
              </Button>
              <Button variant="outline" onClick={() => window.print()} className="print:hidden">
                <Printer />
                <span className="hidden sm:inline">Print</span>
              </Button>
            </>
          ) : null}
        </div>
      }
    />
  );
}

export { Link };
