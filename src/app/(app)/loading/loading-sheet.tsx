'use client';

import * as React from 'react';
import Link from 'next/link';
import { Ship, Users, Anchor, PackageCheck, FileText, Boxes, CalendarClock, Calculator } from 'lucide-react';
import { RowActions } from '@/components/shared/row-actions';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { DOCUMENT_STATUS_META, type BadgeTone } from '@/lib/constants';
import { CONTAINER_STAGE_META, containerStage } from '@/lib/container-stage';
import { MarkLoadedDialog } from '@/app/(app)/loading/mark-loaded-dialog';
import { EtaDialog, ArrivedDialog } from '@/app/(app)/loading/eta-dialog';
import { DocumentStatusDialog } from '@/app/(app)/loading/document-status-dialog';
import { ManageContainersDialog } from '@/app/(app)/loading/manage-containers-dialog';
import { GoodsReceiptDialog, type ReceivableBatch } from '@/app/(app)/purchases/[id]/goods-receipt-dialog';

/** Statuses from which "loaded" is still ahead rather than behind. */
const NOT_YET_LOADED = ['CONTRACT_CREATED', 'AWAITING_LOADING'];

/** Landed, so the goods receipt is the next thing to do. */
const LANDED = ['ARRIVED', 'CUSTOMS_CLEARING', 'CLEARED', 'DELIVERED'];

export type AllocationRow = {
  customerId: string;
  customerName: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  quantity: string;
  amount: string;
  outstanding: string;
  settlement: string;
  warehouseNames: string;
};

export type LoadingLine = {
  batchId: string;
  itemName: string;
  origin: string | null;
  lotNumber: string;
  batchNumber: string;
  traceabilityPending: boolean;
  containerNumber: string | null;
  quantity: string;
  quantityKg: number;
  received: string;
  receivedKg: number;
  sold: string;
  available: string;
  bags: number;
  outstandingKg: string;
  bagWeightKg: string;
  warehouseNames: string;
};

export type LoadingRow = {
  id: string;
  shipmentId: string;
  contractId: string;
  contractDate: string;
  contractDateSort: number;
  contractNumber: string;
  contractReference: string;
  shipmentOrdinal: number;
  shipmentsOnOrder: number;
  exporter: string;
  importer: string;
  consignee: string | null;
  lines: LoadingLine[];
  origin: string;
  destination: string | null;
  containerNumbers: string[];
  containers: number;
  quantity: string;
  quantitySort: number;
  quantityKg: number;
  receivedKg: number;
  sold: string;
  available: string;
  bags: number;
  status: string;
  documentStatus: string;
  shippingLine: string | null;
  shippingLineId: string | null;
  bookingNumber: string | null;
  billOfLading: string | null;
  etaDate: string;
  etaSort: number;
  portOfLoading: string | null;
  portOfDischarge: string | null;
  /** The ETA as `2026-04-18`, or null. Separate from `etaSort`, which is a
   *  sort key and carries a sentinel when there is no date. */
  etaIso: string | null;
  remarks: string | null;
  saleStatus: 'UNSOLD' | 'PARTIALLY_SOLD' | 'FULLY_SOLD';
  paymentStatus: string;
  fullyReceived: boolean;
  warehouseNames: string;
  allocations: AllocationRow[];
};

const SALE_META: Record<LoadingRow['saleStatus'], { label: string; tone: BadgeTone }> = {
  UNSOLD: { label: 'Unsold', tone: 'neutral' },
  PARTIALLY_SOLD: { label: 'Partly sold', tone: 'progress' },
  FULLY_SOLD: { label: 'Sold', tone: 'success' },
};

const PAYMENT_META: Record<string, { label: string; tone: BadgeTone }> = {
  NONE: { label: '—', tone: 'neutral' },
  UNPAID: { label: 'Unpaid', tone: 'warning' },
  PARTIAL: { label: 'Part paid', tone: 'progress' },
  PAID: { label: 'Paid', tone: 'success' },
  OVERDUE: { label: 'Overdue', tone: 'danger' },
};

/**
 * The four stages the follow-up sheet actually uses: Pending loading, Loaded,
 * Arrived, Received — the same four the purchase order shows per container.
 *
 * Older rows may still hold Awaiting Loading, In Transit or Customs
 * internally; those map onto the four so the sheet does not invent stages the
 * workflow does not have.
 */
function displayStatus(row: LoadingRow): { label: string; tone: BadgeTone } {
  return CONTAINER_STAGE_META[containerStage(row.status, row.fullyReceived)];
}

function itemNames(row: LoadingRow) {
  return row.lines.map((line) => line.itemName).join(' ');
}

function ItemsCell({ row }: { row: LoadingRow }) {
  const count = row.lines.length;
  return (
    <span className="block min-w-52">
      {count > 1 ? (
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
          {count} items
        </span>
      ) : null}
      {row.lines.map((line) => (
        <span key={line.batchId} className="block py-0.5">
          <span className="block font-medium leading-snug">{line.itemName}</span>
          <span className="block text-xs text-ink-subtle">
            {line.quantity}
            {line.bags > 0 ? ` · ${line.bags} bags` : ''}
            {line.traceabilityPending
              ? ' · Lot not yet advised'
              : line.lotNumber
                ? ` · Lot ${line.lotNumber}`
                : ''}
            {line.warehouseNames ? ` · ${line.warehouseNames}` : ''}
          </span>
        </span>
      ))}
    </span>
  );
}

function receivableBatches(row: LoadingRow): ReceivableBatch[] {
  const lines = row.lines.filter((line) => Number(line.outstandingKg) > 0.001);

  // Every container on the shipment handed to a line: its own where it has
  // one, otherwise the line with the most coffee per container so far — the
  // same rule the purchase order uses, so both screens show the same rows.
  const containersByBatch = new Map<string, string[]>(lines.map((line) => [line.batchId, []]));
  for (const containerNumber of row.containerNumbers) {
    const owner = lines.find((line) => line.containerNumber === containerNumber);
    const target =
      owner ??
      lines.reduce<LoadingLine | null>((best, line) => {
        const perContainer = (l: LoadingLine) => l.quantityKg / ((containersByBatch.get(l.batchId)?.length ?? 0) + 1);
        return !best || perContainer(line) > perContainer(best) ? line : best;
      }, null);
    if (target) containersByBatch.get(target.batchId)?.push(containerNumber);
  }

  return lines.map((line) => ({
    batchId: line.batchId,
    batchNumber: line.batchNumber,
    shipmentOrdinal: row.shipmentOrdinal,
    arrived: LANDED.includes(row.status),
    itemName: line.itemName,
    lotNumber: line.lotNumber,
    containerNumber: line.containerNumber,
    containerNumbers: containersByBatch.get(line.batchId) ?? [],
    orderedKg: String(line.quantityKg),
    receivedKg: String(line.receivedKg),
    outstandingKg: line.outstandingKg,
    bagWeightKg: line.bagWeightKg,
    traceabilityPending: line.traceabilityPending,
  }));
}

/**
 * The loading / contract follow-up sheet.
 *
 * Two column sets, because the two businesses are not the same shape. Dubai
 * trades container to container, so its sheet leads with the container and the
 * consignee. Morocco buys a container and sells it to many customers over
 * weeks, so its sheet leads with the contract and what is left of it.
 *
 * One row is one shipment — one PO, one reference, one container total — with
 * the coffees listed underneath. Treating each item line as its own shipment
 * doubled the container count.
 */
export function LoadingSheet({
  rows,
  isDubai,
  canExport,
  canUpdate,
  canReceive,
  shippingLines,
  ports = [],
  warehouses,
  defaultWarehouseId,
}: {
  rows: LoadingRow[];
  isDubai: boolean;
  canExport: boolean;
  /** Whether this user may move a consignment along. */
  canUpdate: boolean;
  canReceive: boolean;
  shippingLines: Array<{ id: string; name: string }>;
  ports?: string[];
  warehouses: Array<{ id: string; name: string; code: string }>;
  defaultWarehouseId: string | null;
}) {
  const [viewing, setViewing] = React.useState<LoadingRow | null>(null);
  const [loadingRow, setLoadingRow] = React.useState<LoadingRow | null>(null);
  const [editingEta, setEditingEta] = React.useState<LoadingRow | null>(null);
  const [arrivingRow, setArrivingRow] = React.useState<LoadingRow | null>(null);
  const [receivingRow, setReceivingRow] = React.useState<LoadingRow | null>(null);
  const [documentsRow, setDocumentsRow] = React.useState<LoadingRow | null>(null);
  const [containersRow, setContainersRow] = React.useState<LoadingRow | null>(null);

  const contract: DataColumn<LoadingRow> = {
    id: 'contract',
    header: 'Contract date & ref',
    mobile: 'title',
    sortValue: (r) => r.contractDateSort,
    exportValue: (r) =>
      `${r.contractDate} ${r.contractReference}${r.shipmentsOnOrder > 1 ? ` (shipment ${r.shipmentOrdinal} of ${r.shipmentsOnOrder})` : ''}`,
    cell: (r) => (
      <span className="block min-w-40">
        <Link href={`/purchases/${r.contractId}`} className="font-medium text-forest-700 hover:underline">
          {r.contractReference}
        </Link>
        <span className="block text-xs text-ink-subtle">
          {r.contractDate}
          {r.shipmentsOnOrder > 1 ? ` · Shipment ${r.shipmentOrdinal} of ${r.shipmentsOnOrder}` : ''}
        </span>
      </span>
    ),
  };

  const itemColumn: DataColumn<LoadingRow> = {
    id: 'item',
    header: 'Items description',
    mobile: 'meta',
    sortValue: (r) => itemNames(r),
    exportValue: (r) =>
      r.lines.map((line) => `${line.itemName} (${line.quantity}${line.bags ? `, ${line.bags} bags` : ''})`).join('; '),
    cell: (r) => <ItemsCell row={r} />,
  };

  const warehouseColumn: DataColumn<LoadingRow> = {
    id: 'warehouse',
    header: 'Warehouse',
    mobile: 'meta',
    sortValue: (r) => r.warehouseNames,
    exportValue: (r) => r.warehouseNames,
    cell: (r) => r.warehouseNames || '—',
  };

  const quantity: DataColumn<LoadingRow> = {
    id: 'quantity',
    header: 'Qty',
    numeric: true,
    mobile: 'meta',
    sortValue: (r) => r.quantitySort,
    exportValue: (r) => r.quantity,
    cell: (r) => (
      <span className="block whitespace-nowrap">
        <span className="block font-medium">{r.quantity}</span>
        {r.saleStatus !== 'UNSOLD' ? (
          <span className="block text-xs text-ink-subtle">{r.available} left</span>
        ) : (
          <span className="block text-xs text-ink-subtle">{r.bags} bags</span>
        )}
      </span>
    ),
  };

  const status: DataColumn<LoadingRow> = {
    id: 'status',
    header: 'Status',
    mobile: 'badge',
    sortValue: (r) => displayStatus(r).label,
    exportValue: (r) => displayStatus(r).label,
    cell: (r) => {
      const meta = displayStatus(r);
      const badge = <Badge tone={meta.tone}>{meta.label}</Badge>;
      if (NOT_YET_LOADED.includes(r.status) && canUpdate) {
        return (
          <button
            type="button"
            onClick={() => setLoadingRow(r)}
            className="rounded px-0.5 py-0.5 text-left hover:bg-forest-50"
            title="Enter shipping details and mark loaded"
          >
            {badge}
          </button>
        );
      }
      return (
        <Link href={`/shipments/${r.shipmentId}`}>
          {badge}
        </Link>
      );
    },
  };

  const actions: DataColumn<LoadingRow> = {
    id: 'actions',
    header: 'Actions',
    printHidden: true,
    pin: 'right',
    cell: (r) => {
      const landed = LANDED.includes(r.status);
      const sailing = r.status === 'LOADED' || r.status === 'IN_TRANSIT';
      const canReceiveNow = landed && !r.fullyReceived && receivableBatches(r).length > 0;

      return (
        <RowActions
          inline={1}
          actions={[
            {
              label: 'Mark loaded',
              icon: Ship,
              show: canUpdate && NOT_YET_LOADED.includes(r.status),
              onSelect: () => setLoadingRow(r),
            },
            {
              label: 'Mark arrived',
              icon: Anchor,
              show: canUpdate && sailing,
              onSelect: () => setArrivingRow(r),
            },
            {
              label: 'Receive PO',
              icon: PackageCheck,
              show: canReceiveNow,
              ...(canReceive ? { onSelect: () => setReceivingRow(r) } : { href: `/purchases/${r.contractId}` }),
            },
            { label: 'Update ETA', icon: CalendarClock, show: canUpdate, onSelect: () => setEditingEta(r) },
            {
              label: 'Manage containers',
              icon: Boxes,
              show: canUpdate && (sailing || landed),
              onSelect: () => setContainersRow(r),
            },
            {
              label: 'Update documents',
              icon: FileText,
              show: canUpdate && (sailing || landed),
              onSelect: () => setDocumentsRow(r),
            },
            { label: 'View shipment', href: `/shipments/${r.shipmentId}`, icon: Ship, overflowOnly: true },
            { label: 'Purchase order', href: `/purchases/${r.contractId}`, icon: FileText, overflowOnly: true },
            { label: 'Shipment costing', href: `/shipments/${r.shipmentId}`, icon: Calculator, overflowOnly: true },
          ]}
        />
      );
    },
  };

  const origin: DataColumn<LoadingRow> = {
    id: 'origin',
    header: 'Origin',
    hideable: true,
    sortValue: (r) => r.origin,
    exportValue: (r) => r.origin,
    cell: (r) => r.origin,
  };

  const shippingLine: DataColumn<LoadingRow> = {
    id: 'shippingLine',
    header: 'Shipping line',
    hideable: true,
    sortValue: (r) => r.shippingLine ?? '',
    exportValue: (r) => r.shippingLine ?? '',
    cell: (r) => r.shippingLine ?? <span className="text-ink-subtle">—</span>,
  };

  const booking: DataColumn<LoadingRow> = {
    id: 'booking',
    header: 'Booking no.',
    hideable: true,
    sortValue: (r) => r.bookingNumber ?? '',
    exportValue: (r) => r.bookingNumber ?? '',
    cell: (r) => r.bookingNumber ?? <span className="text-ink-subtle">—</span>,
  };

  const loadPort: DataColumn<LoadingRow> = {
    id: 'portOfLoading',
    header: 'Port of loading',
    hideable: true,
    sortValue: (r) => r.portOfLoading ?? '',
    exportValue: (r) => r.portOfLoading ?? '',
    cell: (r) => r.portOfLoading ?? <span className="text-ink-subtle">—</span>,
  };

  const dischargePort: DataColumn<LoadingRow> = {
    id: 'portOfDischarge',
    header: 'Port of discharge',
    hideable: true,
    sortValue: (r) => r.portOfDischarge ?? '',
    exportValue: (r) => r.portOfDischarge ?? '',
    cell: (r) => r.portOfDischarge ?? <span className="text-ink-subtle">—</span>,
  };

  const documents: DataColumn<LoadingRow> = {
    id: 'documents',
    header: 'Documents',
    sortValue: (r) => r.documentStatus,
    exportValue: (r) => DOCUMENT_STATUS_META[r.documentStatus]?.label ?? r.documentStatus,
    cell: (r) => {
      const meta = DOCUMENT_STATUS_META[r.documentStatus];
      const badge = <Badge tone={meta?.tone ?? 'neutral'}>{meta?.label ?? r.documentStatus}</Badge>;
      if (!canUpdate) return badge;
      return (
        <button
          type="button"
          onClick={() => setDocumentsRow(r)}
          className="rounded px-0.5 py-0.5 text-left hover:bg-forest-50"
          title="Update document status"
        >
          {badge}
        </button>
      );
    },
  };

  const eta: DataColumn<LoadingRow> = {
    id: 'eta',
    header: 'ETA',
    mobile: 'meta',
    sortValue: (r) => r.etaSort,
    exportValue: (r) => r.etaDate,
    cell: (r) =>
      canUpdate ? (
        <button
          type="button"
          onClick={() => setEditingEta(r)}
          className="whitespace-nowrap rounded px-1 py-0.5 text-left underline decoration-dotted underline-offset-2 hover:bg-forest-50"
          title="Change the expected arrival"
        >
          {r.etaIso ? r.etaDate : <span className="text-ink-subtle">Set ETA</span>}
        </button>
      ) : (
        <span className="whitespace-nowrap">{r.etaDate}</span>
      ),
  };

  const remarks: DataColumn<LoadingRow> = {
    id: 'remarks',
    header: 'Remarks',
    hideable: true,
    exportValue: (r) => r.remarks ?? '',
    cell: (r) => <span className="block max-w-56 truncate text-xs text-ink-muted">{r.remarks ?? '—'}</span>,
  };

  const consignee: DataColumn<LoadingRow> = {
    id: 'consignee',
    header: 'Consignee',
    mobile: 'meta',
    sortValue: (r) => r.consignee ?? '',
    exportValue: (r) => r.consignee ?? '',
    cell: (r) =>
      r.allocations.length === 0 ? (
        <span className="text-xs text-ink-subtle">Not allocated</span>
      ) : r.allocations.length === 1 ? (
        <Link
          href={`/customers/${r.allocations[0].customerId}`}
          className="text-forest-700 hover:underline"
        >
          {r.allocations[0].customerName}
        </Link>
      ) : (
        <Button size="sm" variant="ghost" className="h-auto px-1 py-0.5" onClick={() => setViewing(r)}>
          <Users className="size-3.5" />
          {r.allocations.length} customers
        </Button>
      ),
  };

  const payment: DataColumn<LoadingRow> = {
    id: 'payment',
    header: 'Payment',
    mobile: 'badge',
    sortValue: (r) => r.paymentStatus,
    exportValue: (r) => PAYMENT_META[r.paymentStatus]?.label ?? r.paymentStatus,
    cell: (r) => {
      const meta = PAYMENT_META[r.paymentStatus] ?? PAYMENT_META.NONE;
      return r.paymentStatus === 'NONE' ? (
        <span className="text-xs text-ink-subtle">—</span>
      ) : (
        <Badge tone={meta.tone}>{meta.label}</Badge>
      );
    },
  };

  const allocationsColumn: DataColumn<LoadingRow> = {
    id: 'allocations',
    header: '',
    printHidden: true,
    cell: (r) =>
      r.allocations.length > 0 ? (
        <Button size="sm" variant="outline" onClick={() => setViewing(r)}>
          View sales
        </Button>
      ) : null,
  };

  const dubaiColumns: DataColumn<LoadingRow>[] = [
    contract,
    {
      id: 'exporter',
      header: 'Exporter',
      mobile: 'meta',
      sortValue: (r) => r.exporter,
      exportValue: (r) => r.exporter,
      cell: (r) => <span className="block min-w-32">{r.exporter}</span>,
    },
    {
      id: 'importer',
      header: 'Importer',
      hideable: true,
      defaultHidden: true,
      exportValue: (r) => r.importer,
      cell: (r) => <span className="block min-w-32 text-xs">{r.importer}</span>,
    },
    consignee,
    itemColumn,
    warehouseColumn,
    quantity,
    {
      id: 'destination',
      header: 'Destination',
      hideable: true,
      exportValue: (r) => r.destination ?? '',
      cell: (r) => r.destination ?? '—',
    },
    status,
    origin,
    shippingLine,
    booking,
    loadPort,
    dischargePort,
    {
      id: 'containers',
      header: 'Containers',
      numeric: true,
      sortValue: (r) => r.containers,
      exportValue: (r) => (r.containerNumbers.length > 0 ? r.containerNumbers.join(', ') : String(r.containers)),
      cell: (r) => (
        <button
          type="button"
          onClick={() => canUpdate && setContainersRow(r)}
          className="block whitespace-nowrap rounded px-0.5 text-left hover:bg-forest-50 disabled:hover:bg-transparent"
          disabled={!canUpdate}
          title={canUpdate ? 'Edit container numbers' : undefined}
        >
          <span className="block font-mono text-xs">
            {r.containerNumbers.length > 0 ? r.containerNumbers.join(', ') : '—'}
          </span>
          <span className="block text-xs text-ink-subtle">{r.containers} ctr</span>
        </button>
      ),
    },
    eta,
    payment,
    remarks,
    documents,
    allocationsColumn,
    actions,
  ];

  const moroccoColumns: DataColumn<LoadingRow>[] = [
    {
      ...contract,
      header: 'Contract Ref',
    },
    {
      id: 'exporter',
      header: 'Exporter',
      mobile: 'title',
      sortValue: (r) => r.exporter,
      exportValue: (r) => r.exporter,
      cell: (r) => <span className="block min-w-32 font-medium">{r.exporter}</span>,
    },
    {
      id: 'importer',
      header: 'Importer',
      mobile: 'meta',
      sortValue: (r) => r.importer,
      exportValue: (r) => r.importer,
      cell: (r) => <span className="block min-w-32">{r.importer}</span>,
    },
    {
      ...itemColumn,
      header: 'Item',
    },
    warehouseColumn,
    quantity,
    {
      id: 'containers',
      header: 'Containers',
      numeric: true,
      sortValue: (r) => r.containers,
      exportValue: (r) => (r.containerNumbers.length > 0 ? r.containerNumbers.join(', ') : String(r.containers)),
      cell: (r) => (
        <span className="block whitespace-nowrap">
          <span className="block tabular-nums font-medium">{r.containers}</span>
          <span className="block font-mono text-xs text-ink-subtle">
            {r.containerNumbers.length > 0 ? r.containerNumbers.join(', ') : '—'}
          </span>
        </span>
      ),
    },
    status,
    { ...shippingLine, hideable: false },
    {
      id: 'bookingBl',
      header: 'Booking / B/L',
      sortValue: (r) => r.bookingNumber ?? r.billOfLading ?? '',
      exportValue: (r) => [r.bookingNumber, r.billOfLading].filter(Boolean).join(' · '),
      cell: (r) => (
        <span className="block whitespace-nowrap font-mono text-xs">
          {r.bookingNumber || r.billOfLading ? (
            <>
              {r.bookingNumber ? <span className="block">{r.bookingNumber}</span> : null}
              {r.billOfLading ? <span className="block text-ink-subtle">{r.billOfLading}</span> : null}
            </>
          ) : (
            <span className="text-ink-subtle">—</span>
          )}
        </span>
      ),
    },
    {
      id: 'containerNumbers',
      header: 'Container numbers',
      exportValue: (r) => r.containerNumbers.join(', '),
      cell: (r) => (
        <span className="block whitespace-nowrap font-mono text-xs">
          {r.containerNumbers.length > 0 ? r.containerNumbers.join(', ') : '—'}
        </span>
      ),
    },
    eta,
    {
      ...origin,
      defaultHidden: true,
    },
    {
      ...loadPort,
      defaultHidden: true,
    },
    {
      ...dischargePort,
      defaultHidden: true,
    },
    {
      id: 'sold',
      header: 'Sold / left',
      numeric: true,
      hideable: true,
      defaultHidden: true,
      exportValue: (r) => `${r.sold} of ${r.quantity}`,
      cell: (r) => (
        <span className="block whitespace-nowrap">
          <Badge tone={SALE_META[r.saleStatus].tone}>{SALE_META[r.saleStatus].label}</Badge>
          <span className="mt-0.5 block text-xs text-ink-subtle">{r.available} left</span>
        </span>
      ),
    },
    { ...documents, hideable: true, defaultHidden: true },
    { ...payment, hideable: true, defaultHidden: true },
    { ...remarks, defaultHidden: true },
    allocationsColumn,
    actions,
  ];

  return (
    <>
      <DataTable
      prefsKey="loading-sheet"
        data={rows}
        columns={isDubai ? dubaiColumns : moroccoColumns}
        getRowId={(r) => r.id}
        dense
        pageSize={50}
        exportHref={canExport ? '/api/export/loading-sheet' : undefined}
        expandedContent={(r) => <ContainerBreakdown lines={r.lines} />}
        searchValue={(r) =>
          [
            r.contractReference,
            r.contractNumber,
            r.exporter,
            r.consignee,
            itemNames(r),
            ...r.lines.map((line) => `${line.lotNumber} ${line.batchNumber} ${line.warehouseNames}`),
            ...r.containerNumbers,
            r.billOfLading,
            r.bookingNumber,
            r.shippingLine,
            r.origin,
            r.destination,
            r.remarks,
            ...r.allocations.map((a) => a.customerName),
          ]
            .filter(Boolean)
            .join(' ')
        }
        searchPlaceholder="Search contract, coffee, container, B/L, customer…"
        emptyTitle="Nothing loading yet"
        emptyDescription="Approve a purchase order and its shipment appears here automatically — there is no separate sheet to fill in."
      />

      {editingEta ? (
        <EtaDialog
          shipmentId={editingEta.shipmentId}
          contractLabel={editingEta.contractReference}
          currentEta={editingEta.etaIso}
          onClose={() => setEditingEta(null)}
        />
      ) : null}

      {arrivingRow ? (
        <ArrivedDialog
          shipmentId={arrivingRow.shipmentId}
          contractLabel={arrivingRow.contractReference}
          onClose={() => setArrivingRow(null)}
        />
      ) : null}

      {loadingRow ? (
        <MarkLoadedDialog
          open
          onOpenChange={(open) => !open && setLoadingRow(null)}
          shipmentId={loadingRow.shipmentId}
          contractLabel={loadingRow.contractReference}
          shippingLines={shippingLines}
          ports={ports}
          defaults={{
            etaDate: loadingRow.etaIso,
            bookingNumber: loadingRow.bookingNumber,
            billOfLading: loadingRow.billOfLading,
            shippingLineId: loadingRow.shippingLineId,
            portOfLoading: loadingRow.portOfLoading,
            portOfDischarge: loadingRow.portOfDischarge,
            containerNumbers: loadingRow.containerNumbers,
            containers: loadingRow.containers,
          }}
        />
      ) : null}

      {documentsRow ? (
        <DocumentStatusDialog
          shipmentId={documentsRow.shipmentId}
          contractLabel={documentsRow.contractReference}
          currentStatus={documentsRow.documentStatus}
          onClose={() => setDocumentsRow(null)}
        />
      ) : null}

      {containersRow ? (
        <ManageContainersDialog
          shipmentId={containersRow.shipmentId}
          contractLabel={containersRow.contractReference}
          lines={containersRow.lines}
          knownNumbers={containersRow.containerNumbers}
          onClose={() => setContainersRow(null)}
        />
      ) : null}

      {receivingRow ? (
        <GoodsReceiptDialog
          open
          onOpenChange={(open) => !open && setReceivingRow(null)}
          purchaseContractId={receivingRow.contractId}
          contractLabel={receivingRow.contractReference}
          batches={receivableBatches(receivingRow)}
          warehouses={warehouses}
          defaultWarehouseId={defaultWarehouseId}
        />
      ) : null}

      <Dialog open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}>
        {viewing ? (
          <DialogContent
            title={`Sales from ${viewing.contractReference}`}
            description={`${viewing.quantity} purchased. ${viewing.sold} sold, ${viewing.available} still available.`}
          >
            <div className="overflow-x-auto px-5 pb-5">
              <Table>
                <THead>
                  <TR>
                    <TH>Customer</TH>
                    <TH>Invoice</TH>
                    <TH>Warehouse</TH>
                    <TH numeric>Quantity</TH>
                    <TH numeric>Value</TH>
                    <TH numeric>Outstanding</TH>
                    <TH>Payment</TH>
                  </TR>
                </THead>
                <TBody>
                  {viewing.allocations.map((allocation) => {
                    const meta = PAYMENT_META[allocation.settlement] ?? PAYMENT_META.UNPAID;
                    return (
                      <TR key={allocation.invoiceId}>
                        <TD>
                          <Link
                            href={`/customers/${allocation.customerId}`}
                            className="text-forest-700 hover:underline"
                          >
                            {allocation.customerName}
                          </Link>
                        </TD>
                        <TD>
                          <Link
                            href={`/sales/${allocation.invoiceId}`}
                            className="text-forest-700 hover:underline"
                          >
                            {allocation.customerName}
                          </Link>
                          <span className="block text-xs text-ink-subtle">{allocation.invoiceDate}</span>
                        </TD>
                        <TD>{allocation.warehouseNames || '—'}</TD>
                        <TD numeric>{allocation.quantity}</TD>
                        <TD numeric>{allocation.amount}</TD>
                        <TD numeric>{allocation.outstanding}</TD>
                        <TD>
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>

              <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-subtle">
                <Ship className="size-3.5" />
                The original purchase stays one record. These are the customers it was sold to.
              </p>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

/**
 * What is inside each container, and how much of it.
 *
 * A shipment of two coffees across two containers is four facts, and reading
 * them off the contract row means opening the shipment. Grouped by container
 * here, with the items under each and a total per box, so the question "what
 * is in container 2" is answered where it is asked.
 *
 * Lines that have not been assigned a container yet are grouped together and
 * said to be unassigned rather than being quietly dropped.
 */
function ContainerBreakdown({ lines }: { lines: LoadingLine[] }) {
  if (lines.length === 0) {
    return <p className="text-xs text-ink-muted">Nothing has been loaded against this contract yet.</p>;
  }

  const groups = new Map<string, LoadingLine[]>();
  for (const line of lines) {
    const key = line.containerNumber ?? '';
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }

  return (
    <div className="space-y-4">
      {[...groups.entries()].map(([container, group]) => {
        const totalKg = group.reduce((sum, line) => sum + line.quantityKg, 0);
        const bags = group.reduce((sum, line) => sum + line.bags, 0);
        return (
          <div key={container || 'unassigned'}>
            <div className="mb-1 flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs font-semibold text-ink">
                {container || 'No container assigned yet'}
              </span>
              <span className="text-xs text-ink-muted">
                {totalKg.toLocaleString(undefined, { maximumFractionDigits: 2 })} KG ·{' '}
                {bags.toLocaleString()} bags
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                    <th className="py-1.5 pr-3 font-medium">Item</th>
                    <th className="py-1.5 pr-3 font-medium">Batch</th>
                    <th className="py-1.5 pr-3 font-medium">Lot</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Loaded</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Received</th>
                    <th className="py-1.5 text-right font-medium">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {group.map((line) => (
                    <tr key={line.batchId} className="border-b border-line/60 last:border-0">
                      <td className="py-1.5 pr-3 font-medium">{line.itemName}</td>
                      <td className="py-1.5 pr-3">{line.batchNumber}</td>
                      <td className="py-1.5 pr-3 text-xs text-ink-muted">{line.lotNumber}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{line.quantity}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{line.received}</td>
                      <td className="py-1.5 text-right tabular-nums">{line.available}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
