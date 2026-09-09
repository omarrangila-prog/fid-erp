'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { downloadCsv, exportFilename } from '@/lib/export-csv';

export type BatchRow = {
  id: string;
  batchNumber: string;
  lotNumber: string;
  itemName: string;
  origin: string;
  containerNumber: string | null;
  shipmentNumber: string;
  shipmentId: string;
  contractNumber: string;
  warehouses: string;
  orderedLabel: string;
  orderedSort: number;
  receivedLabel: string;
  inTransitLabel: string;
  soldLabel: string;
  availableLabel: string;
  availableSort: number;
  bags: number;
  landedCostLabel: string;
  valueLabel: string;
  valueSort: number;
  status: string;
};

export function BatchesClient({
  rows,
  companyCode,
  showValue,
  canExport,
  emptyAction,
}: {
  rows: BatchRow[];
  companyCode: string;
  showValue: boolean;
  canExport: boolean;
  /** Rendered inside the empty state; built on the server so permissions are checked there. */
  emptyAction?: React.ReactNode;
}) {
  const columns: DataColumn<BatchRow>[] = [
    {
      id: 'batch',
      header: 'Batch / Lot',
      mobile: 'title',
      sortValue: (r) => r.batchNumber,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.batchNumber}</span>
          <span className="block text-xs text-ink-subtle">Lot {r.lotNumber}</span>
        </span>
      ),
    },
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
    { id: 'container', header: 'Container', hideable: true, cell: (r) => r.containerNumber ?? '—' },
    { id: 'shipment', header: 'Shipment', hideable: true, cell: (r) => r.shipmentNumber },
    { id: 'warehouses', header: 'Warehouse', mobile: 'meta', cell: (r) => r.warehouses || '—' },
    { id: 'ordered', header: 'Ordered', numeric: true, hideable: true, sortValue: (r) => r.orderedSort, cell: (r) => r.orderedLabel },
    { id: 'received', header: 'Received', numeric: true, hideable: true, cell: (r) => r.receivedLabel },
    { id: 'inTransit', header: 'In transit', numeric: true, hideable: true, cell: (r) => r.inTransitLabel },
    { id: 'sold', header: 'Sold', numeric: true, mobile: 'meta', cell: (r) => r.soldLabel },
    {
      id: 'available',
      header: 'Available',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.availableSort,
      cell: (r) => <span className="font-medium">{r.availableLabel}</span>,
    },
    { id: 'bags', header: 'Bags', numeric: true, hideable: true, defaultHidden: true, cell: (r) => r.bags.toLocaleString() },
    ...(showValue
      ? [
          { id: 'landed', header: 'Landed / KG', numeric: true, hideable: true, cell: (r: BatchRow) => r.landedCostLabel } satisfies DataColumn<BatchRow>,
          {
            id: 'value',
            header: 'Value',
            numeric: true,
            hideable: true,
            sortValue: (r: BatchRow) => r.valueSort,
            cell: (r: BatchRow) => r.valueLabel,
          } satisfies DataColumn<BatchRow>,
        ]
      : []),
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      cell: (r) => (
        <Badge tone={r.status === 'ACTIVE' ? 'success' : 'neutral'}>
          {r.status === 'ACTIVE' ? 'Active' : 'Closed'}
        </Badge>
      ),
    },
  ];

  function exportCsv() {
    downloadCsv(
      exportFilename(companyCode, 'batch-stock'),
      ['Batch', 'Lot', 'Coffee', 'Origin', 'Container', 'Shipment', 'Contract', 'Warehouse',
       'Ordered KG', 'Received KG', 'In transit KG', 'Sold KG', 'Available KG', 'Bags', 'Landed/KG USD', 'Value USD'],
      rows.map((r) => [
        r.batchNumber, r.lotNumber, r.itemName, r.origin, r.containerNumber, r.shipmentNumber, r.contractNumber,
        r.warehouses, r.orderedSort, r.receivedLabel, r.inTransitLabel, r.soldLabel, r.availableSort, r.bags,
        showValue ? r.landedCostLabel : '', showValue ? r.valueSort : '',
      ]),
    );
  }

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/inventory/batches/${r.id}`}
      pageSize={50}
      searchValue={(r) =>
        `${r.batchNumber} ${r.lotNumber} ${r.itemName} ${r.origin} ${r.containerNumber ?? ''} ${r.shipmentNumber} ${r.contractNumber} ${r.warehouses}`
      }
      searchPlaceholder="Search batch, lot, container or shipment…"
      emptyAction={emptyAction}
      emptyTitle="No batches yet"
      emptyDescription="Batches are created when a purchase contract is approved."
      toolbar={
        canExport ? (
          <Button variant="outline" onClick={exportCsv}>
            <Download />
            <span className="hidden sm:inline">Export</span>
          </Button>
        ) : undefined
      }
    />
  );
}
