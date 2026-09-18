'use client';

import * as React from 'react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Calculator, Receipt, Ship } from 'lucide-react';
import { RowActions, viewAction } from '@/components/shared/row-actions';
import { StatusBadge } from '@/components/ui/badge';
import { SHIPMENT_STATUS_META, DOCUMENT_STATUS_META, SETTLEMENT_STATUS_META } from '@/lib/constants';

export type ShipmentRow = {
  id: string;
  shipmentNumber: string;
  jobNumber: string;
  contractNumber: string;
  contractReference: string;
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
  warehouseNames: string;
  purchaseUsd: string | null;
  expensesLocal: string | null;
  expensesUsd: string | null;
  landedUsd: string | null;
  landedLocal: string | null;
  costPerKg: string | null;
  costPerMt: string | null;
  costPerKgLocal: string | null;
  costPerMtLocal: string | null;
  remainingKg: string | null;
  localCurrency: string | null;
};

export function ShipmentsClient({
  rows,
  emptyAction,
  showCost = false,
  canAddExpense = false,
}: {
  rows: ShipmentRow[];
  emptyAction?: React.ReactNode;
  showCost?: boolean;
  canAddExpense?: boolean;
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
          
        </span>
      ),
    },
    {
      id: 'contract',
      header: 'Reference',
      sortValue: (r) => r.contractReference,
      exportValue: (r) => r.contractReference,
      // The supplier's own reference is what everyone in the trade quotes;
      // the internal contract number is shown under it rather than instead.
      cell: (r) => (
        <span className="block min-w-44">
          <span className="block font-mono text-xs font-medium">{r.contractReference}</span>
          <span className="block text-[11px] text-ink-subtle">{r.contractNumber}</span>
        </span>
      ),
    },
    { id: 'coffee', header: 'Coffee', mobile: 'meta', sortValue: (r) => r.itemName, cell: (r) => r.itemName },
    {
      id: 'warehouse',
      header: 'Warehouse',
      mobile: 'meta',
      sortValue: (r) => r.warehouseNames,
      cell: (r) => r.warehouseNames || '—',
    },
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
    ...(showCost
      ? [
          {
            id: 'purchase',
            header: 'Purchase USD',
            hideable: true,
            numeric: true,
            cell: (r: ShipmentRow) => r.purchaseUsd ?? '—',
          } satisfies DataColumn<ShipmentRow>,
          {
            id: 'expensesLocal',
            header: 'Local expenses',
            hideable: true,
            numeric: true,
            cell: (r: ShipmentRow) => (
              <span>
                <span className="block">{r.expensesLocal ?? '—'}</span>
                {r.expensesUsd ? <span className="block text-xs text-ink-subtle">{r.expensesUsd}</span> : null}
              </span>
            ),
          } satisfies DataColumn<ShipmentRow>,
          {
            id: 'landed',
            header: 'Landed USD',
            hideable: true,
            numeric: true,
            cell: (r: ShipmentRow) => (
              <span>
                <span className="block font-medium">{r.landedUsd ?? '—'}</span>
                {r.landedLocal ? <span className="block text-xs text-ink-subtle">{r.landedLocal}</span> : null}
              </span>
            ),
          } satisfies DataColumn<ShipmentRow>,
          {
            id: 'costKg',
            header: 'Cost / KG',
            hideable: true,
            numeric: true,
            exportValue: (r: ShipmentRow) => r.costPerKg ?? '',
            cell: (r: ShipmentRow) => (
              <span>
                <span className="block font-medium">{r.costPerKg ?? '—'}</span>
                {r.costPerKgLocal ? (
                  <span className="block text-xs text-ink-subtle">{r.costPerKgLocal}</span>
                ) : null}
                {r.costPerMt ? (
                  <span className="block text-xs text-ink-subtle">
                    {r.costPerMt} / MT
                    {r.costPerMtLocal ? ` · ${r.costPerMtLocal} / MT` : ''}
                  </span>
                ) : null}
              </span>
            ),
          } satisfies DataColumn<ShipmentRow>,
          {
            id: 'remaining',
            header: 'Remaining KG',
            hideable: true,
            numeric: true,
            cell: (r: ShipmentRow) => r.remainingKg ?? '—',
          } satisfies DataColumn<ShipmentRow>,
        ]
      : []),
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
    {
      id: 'actions',
      header: 'Actions',
      printHidden: true,
      mobile: 'action',
      pin: 'right',
      cell: (r) => (
        <RowActions
          actions={[
            viewAction(`/shipments/${r.id}`),
            { label: 'Costing', href: `/shipments/${r.id}#costing`, icon: Calculator },
            { label: 'Add expense', href: `/finance/expenses/new?job=${r.id}`, icon: Receipt, show: canAddExpense },
            { label: 'Loading sheet', href: '/loading', icon: Ship },
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
      rowHref={(r) => `/shipments/${r.id}`}
      searchValue={(r) =>
        `${r.shipmentNumber} ${r.jobNumber} ${r.contractNumber} ${r.contractReference} ${r.vendorName} ${r.itemName} ${r.bookingNumber ?? ''} ${r.billOfLading ?? ''} ${r.vesselName ?? ''} ${r.warehouseNames}`
      }
      searchPlaceholder="Search by reference, shipment, job, booking, B/L or vessel…"
      emptyAction={emptyAction}
      emptyTitle="No shipments yet"
      emptyDescription="A job is opened automatically when a purchase contract is approved."
    />
  );
}
