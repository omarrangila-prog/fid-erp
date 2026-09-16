'use client';

import * as React from 'react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { History, Ship, ArrowLeftRight } from 'lucide-react';
import { RowActions, viewAction } from '@/components/shared/row-actions';
import { Badge } from '@/components/ui/badge';

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
  receivedSort: number;
  inTransitLabel: string;
  inTransitSort: number;
  soldLabel: string;
  soldSort: number;
  availableLabel: string;
  availableSort: number;
  bags: number;
  landedCostLabel: string;
  landedCostSort: number;
  valueLabel: string;
  valueSort: number;
  status: string;
};

export function BatchesClient({
  rows,
  showValue,
  canExport,
  emptyAction,
}: {
  rows: BatchRow[];
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
      exportValue: (r) => r.batchNumber,
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
      exportValue: (r) => r.itemName,
      cell: (r) => (
        <span>
          <span className="block">{r.itemName}</span>
          <span className="block text-xs text-ink-subtle">{r.origin}</span>
        </span>
      ),
    },
    { id: 'lot', header: 'Lot', hideable: true, defaultHidden: true, exportValue: (r) => r.lotNumber, cell: (r) => r.lotNumber },
    { id: 'origin', header: 'Origin', hideable: true, defaultHidden: true, exportValue: (r) => r.origin, cell: (r) => r.origin },
    { id: 'container', header: 'Container', hideable: true, exportValue: (r) => r.containerNumber ?? '', cell: (r) => r.containerNumber ?? '—' },
    { id: 'shipment', header: 'Shipment', hideable: true, exportValue: (r) => r.shipmentNumber, cell: (r) => r.shipmentNumber },
    // Shown by default, not hidden behind the column picker: the client tracks
    // stock back to the contract it came in on, and a reference you have to go
    // looking for is one you stop using.
    { id: 'contract', header: 'Contract', hideable: true, exportValue: (r) => r.contractNumber, cell: (r) => r.contractNumber },
    { id: 'warehouses', header: 'Warehouse', mobile: 'meta', exportValue: (r) => r.warehouses, cell: (r) => r.warehouses || '—' },
    { id: 'ordered', header: 'Ordered KG', numeric: true, hideable: true, sortValue: (r) => r.orderedSort, exportValue: (r) => r.orderedSort, exportType: 'quantity', cell: (r) => r.orderedLabel },
    { id: 'received', header: 'Received KG', numeric: true, hideable: true, exportValue: (r) => r.receivedSort, exportType: 'quantity', cell: (r) => r.receivedLabel },
    { id: 'inTransit', header: 'In transit KG', numeric: true, hideable: true, exportValue: (r) => r.inTransitSort, exportType: 'quantity', cell: (r) => r.inTransitLabel },
    { id: 'sold', header: 'Sold KG', numeric: true, mobile: 'meta', exportValue: (r) => r.soldSort, exportType: 'quantity', cell: (r) => r.soldLabel },
    {
      id: 'available',
      header: 'Available KG',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.availableSort,
      exportValue: (r) => r.availableSort,
      exportType: 'quantity',
      cell: (r) => <span className="font-medium">{r.availableLabel}</span>,
    },
    { id: 'bags', header: 'Bags', numeric: true, hideable: true, defaultHidden: true, exportValue: (r) => r.bags, exportType: 'integer', cell: (r) => r.bags.toLocaleString() },
    ...(showValue
      ? [
          {
            id: 'landed',
            header: 'Landed / KG USD',
            numeric: true,
            hideable: true,
            exportValue: (r: BatchRow) => r.landedCostSort,
            exportType: 'number',
            cell: (r: BatchRow) => r.landedCostLabel,
          } satisfies DataColumn<BatchRow>,
          {
            id: 'value',
            header: 'Value USD',
            numeric: true,
            hideable: true,
            sortValue: (r: BatchRow) => r.valueSort,
            exportValue: (r: BatchRow) => r.valueSort,
            exportType: 'money',
            cell: (r: BatchRow) => r.valueLabel,
          } satisfies DataColumn<BatchRow>,
        ]
      : []),
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      exportValue: (r) => (r.status === 'ACTIVE' ? 'Active' : 'Closed'),
      cell: (r) => (
        <Badge tone={r.status === 'ACTIVE' ? 'success' : 'neutral'}>
          {r.status === 'ACTIVE' ? 'Active' : 'Closed'}
        </Badge>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      mobile: 'action',
      pin: 'right',
      printHidden: true,
      // Visibility only: a batch's quantities come from the stock ledger and
      // are not edited here. These are the places a person goes next.
      cell: (r) => (
        <RowActions
          actions={[
            viewAction(`/inventory/batches/${r.id}`),
            { label: 'Movements', href: `/inventory/movements?q=${encodeURIComponent(r.batchNumber)}`, icon: History },
            { label: 'Shipment', href: `/shipments/${r.shipmentId}`, icon: Ship },
            { label: 'Transfer', href: '/inventory/transfers/new', icon: ArrowLeftRight, overflowOnly: true },
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
      rowHref={(r) => `/inventory/batches/${r.id}`}
      pageSize={50}
      filters={[
        { id: 'item', label: 'Coffee', value: (r) => r.itemName },
        { id: 'warehouse', label: 'Warehouse', value: (r) => r.warehouses || null },
        { id: 'origin', label: 'Origin', value: (r) => r.origin },
      ]}
      searchValue={(r) =>
        `${r.batchNumber} ${r.lotNumber} ${r.itemName} ${r.origin} ${r.containerNumber ?? ''} ${r.shipmentNumber} ${r.contractNumber} ${r.warehouses}`
      }
      searchPlaceholder="Search batch, lot, container or shipment…"
      emptyAction={emptyAction}
      emptyTitle="No batches yet"
      emptyDescription="Batches are created when a purchase contract is approved."
      exportFileName={canExport ? 'batch-stock' : undefined}
      exportTitle="Batch Stock"
    />
  );
}
