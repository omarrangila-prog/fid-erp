'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Ship, Anchor, PackageCheck, FileText, Boxes, CalendarClock, Calculator, Undo2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm';
import { undoLoadingAction } from '@/server/actions/trading-actions';
import { RowActions } from '@/components/shared/row-actions';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
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
  const [undoRow, setUndoRow] = React.useState<LoadingRow | null>(null);
  const router = useRouter();





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

  /** Everything one container / shipment allows at its stage. */
  function shipmentActions(r: LoadingRow) {
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
              label: 'Undo loading',
              icon: Undo2,
              show: canUpdate && sailing,
              onSelect: () => setUndoRow(r),
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
            // Who bought this container's coffee, and whether they have paid.
            { label: 'View sales', icon: FileText, show: r.allocations.length > 0, onSelect: () => setViewing(r), overflowOnly: true },
            { label: 'View shipment', href: `/shipments/${r.shipmentId}`, icon: Ship, overflowOnly: true },
            { label: 'Purchase order', href: `/purchases/${r.contractId}`, icon: FileText, overflowOnly: true },
            { label: 'Shipment costing', href: `/shipments/${r.shipmentId}`, icon: Calculator, overflowOnly: true },
          ]}
        />
      );
  }






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


  /*
   * One parent row per order.
   *
   * Each container is its own shipment, with its own ETA, status and
   * actions, and it used to be its own top-level row — so an order of three
   * items in three containers read as three unrelated shipments. The client
   * prefers the way the 21 May order reads: one consignment, its coffees
   * underneath. Every order now reads that way. The parent row summarises;
   * expanding it lists each item and container with its own ETA and its own
   * Update ETA, because containers on one order do not always arrive together.
   */
  type OrderGroup = {
    id: string;
    contractId: string;
    contractReference: string;
    contractDate: string;
    contractDateSort: number;
    exporter: string;
    shipments: LoadingRow[];
  };

  const groups = React.useMemo(() => {
    const byContract = new Map<string, OrderGroup>();
    for (const row of rows) {
      const group = byContract.get(row.contractId) ?? {
        id: row.contractId,
        contractId: row.contractId,
        contractReference: row.contractReference,
        contractDate: row.contractDate,
        contractDateSort: row.contractDateSort,
        exporter: row.exporter,
        shipments: [],
      };
      group.shipments.push(row);
      byContract.set(row.contractId, group);
    }
    for (const group of byContract.values()) group.shipments.sort((a, b) => a.shipmentOrdinal - b.shipmentOrdinal);
    return [...byContract.values()];
  }, [rows]);

  const lineCount = (g: OrderGroup) => g.shipments.reduce((n, r) => n + r.lines.length, 0);
  const containerCount = (g: OrderGroup) => g.shipments.reduce((n, r) => n + Math.max(r.containers, 1), 0);
  const totalKg = (g: OrderGroup) => g.shipments.reduce((n, r) => n + r.quantityKg, 0);
  const distinct = (values: Array<string | null | undefined>) => [...new Set(values.filter((v): v is string => Boolean(v)))];

  /** "22 Sept 2026" when every container shares it, "22–28 Sept 2026" when they differ. */
  function etaSummary(g: OrderGroup): string {
    const dates = distinct(g.shipments.map((r) => r.etaIso)).sort();
    if (dates.length === 0) return '—';
    const fmt = (iso: string, parts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-GB', { ...parts, timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
    if (dates.length === 1) return fmt(dates[0], { day: '2-digit', month: 'short', year: 'numeric' });
    const [first, last] = [dates[0], dates[dates.length - 1]];
    const sameMonth = first.slice(0, 7) === last.slice(0, 7);
    return sameMonth
      ? `${fmt(first, { day: '2-digit' })}–${fmt(last, { day: '2-digit', month: 'short', year: 'numeric' })}`
      : `${fmt(first, { day: '2-digit', month: 'short' })} – ${fmt(last, { day: '2-digit', month: 'short', year: 'numeric' })}`;
  }

  /** One stage for the order when every container is at it; otherwise the count at each. */
  function statusSummary(g: OrderGroup) {
    const stages = g.shipments.map((r) => displayStatus(r));
    const labels = distinct(stages.map((m) => m.label));
    if (labels.length === 1) return <Badge tone={stages[0].tone}>{labels[0]}</Badge>;
    return (
      <span className="flex flex-wrap gap-1">
        {labels.map((label) => {
          const meta = stages.find((m) => m.label === label)!;
          const count = stages.filter((m) => m.label === label).length;
          return (
            <Badge key={label} tone={meta.tone}>
              {count} {label}
            </Badge>
          );
        })}
      </span>
    );
  }

  function documentsSummary(g: OrderGroup) {
    const statuses = distinct(g.shipments.map((r) => r.documentStatus));
    if (statuses.length === 1) return documents.cell!(g.shipments[0]);
    return <span className="text-xs text-ink-muted">{statuses.map((st) => DOCUMENT_STATUS_META[st]?.label ?? st).join(' · ')}</span>;
  }

  const groupColumns: DataColumn<OrderGroup>[] = [
    {
      id: 'reference',
      header: 'ICUL/FID Reference',
      mobile: 'title',
      sortValue: (g) => g.contractDateSort,
      exportValue: (g) => `${g.contractReference} ${g.contractDate}`,
      cell: (g) => (
        <span className="block min-w-40">
          <Link href={`/purchases/${g.contractId}`} className="font-medium text-forest-700 hover:underline">
            {g.contractReference}
          </Link>
          <span className="block text-xs text-ink-subtle">{g.contractDate}</span>
        </span>
      ),
    },
    {
      id: 'supplier',
      header: 'Supplier',
      mobile: 'meta',
      sortValue: (g) => g.exporter,
      exportValue: (g) => g.exporter,
      cell: (g) => <span className="block min-w-32">{g.exporter}</span>,
    },
    {
      id: 'items',
      header: 'Items',
      mobile: 'meta',
      sortValue: (g) => lineCount(g),
      exportValue: (g) => distinct(g.shipments.flatMap((r) => r.lines.map((l) => l.itemName))).join('; '),
      cell: (g) => {
        const names = distinct(g.shipments.flatMap((r) => r.lines.map((l) => l.itemName)));
        return (
          <span className="block min-w-40 text-xs">
            <span className="block text-sm font-medium text-ink">
              {lineCount(g)} {lineCount(g) === 1 ? 'item' : 'items'}
            </span>
            <span className="block text-ink-muted">{names.join(', ')}</span>
          </span>
        );
      },
    },
    {
      id: 'containers',
      header: 'Containers',
      numeric: true,
      sortValue: (g) => containerCount(g),
      exportValue: (g) => distinct(g.shipments.flatMap((r) => r.containerNumbers)).join(', ') || String(containerCount(g)),
      cell: (g) => {
        const numbers = distinct(g.shipments.flatMap((r) => r.containerNumbers));
        return (
          <span className="block whitespace-nowrap">
            <span className="block font-medium">{containerCount(g)}</span>
            {numbers.length > 0 ? <span className="block font-mono text-[11px] text-ink-subtle">{numbers.join(', ')}</span> : null}
          </span>
        );
      },
    },
    {
      id: 'quantity',
      header: 'Total KG',
      numeric: true,
      sortValue: (g) => totalKg(g),
      exportValue: (g) => totalKg(g),
      cell: (g) => <span className="tnum whitespace-nowrap font-medium">{totalKg(g).toLocaleString('en-US', { maximumFractionDigits: 2 })} KG</span>,
    },
    {
      id: 'shippingLine',
      header: 'Shipping line',
      hideable: true,
      exportValue: (g) => distinct(g.shipments.map((r) => r.shippingLine)).join(', '),
      cell: (g) => distinct(g.shipments.map((r) => r.shippingLine)).join(', ') || <span className="text-ink-subtle">—</span>,
    },
    {
      id: 'booking',
      header: 'Booking / B/L',
      hideable: true,
      exportValue: (g) => distinct(g.shipments.flatMap((r) => [r.bookingNumber, r.billOfLading])).join(', '),
      cell: (g) => (
        <span className="block text-xs">
          <span className="block">{distinct(g.shipments.map((r) => r.bookingNumber)).join(', ') || '—'}</span>
          <span className="block text-ink-subtle">{distinct(g.shipments.map((r) => r.billOfLading)).join(', ')}</span>
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (g) => displayStatus(g.shipments[0]).label,
      exportValue: (g) => distinct(g.shipments.map((r) => displayStatus(r).label)).join(', '),
      cell: (g) => statusSummary(g),
    },
    {
      id: 'eta',
      header: 'ETA',
      mobile: 'meta',
      sortValue: (g) => Math.min(...g.shipments.map((r) => r.etaSort)),
      exportValue: (g) => etaSummary(g),
      cell: (g) =>
        g.shipments.length === 1 ? (
          eta.cell!(g.shipments[0])
        ) : (
          <span className="whitespace-nowrap" title="Expand to see and change each container's ETA">
            {etaSummary(g)}
          </span>
        ),
    },
    {
      id: 'documents',
      header: 'Documents',
      hideable: true,
      exportValue: (g) => distinct(g.shipments.map((r) => DOCUMENT_STATUS_META[r.documentStatus]?.label ?? r.documentStatus)).join(', '),
      cell: (g) => documentsSummary(g),
    },
    // Morocco imports under its own name and sells on afterwards, so only Dubai's sheet names a consignee.
    ...(!isDubai ? [] : [{
      id: 'consignee',
      header: 'Sold to',
      hideable: true,
      exportValue: (g: OrderGroup) => distinct(g.shipments.flatMap((r) => r.allocations.map((a) => a.customerName))).join(', '),
      cell: (g: OrderGroup) => {
        const names = distinct(g.shipments.flatMap((r) => r.allocations.map((a) => a.customerName)));
        return names.length === 0 ? <span className="text-xs text-ink-subtle">Not sold yet</span> : <span className="text-xs">{names.join(', ')}</span>;
      },
    } satisfies DataColumn<OrderGroup>]),
    ...(isDubai ? [{ ...(payment as unknown as DataColumn<OrderGroup>), cell: (g: OrderGroup) => payment.cell!(g.shipments[0]), sortValue: undefined, exportValue: (g: OrderGroup) => g.shipments[0].paymentStatus }] : []),
    {
      id: 'actions',
      header: 'Actions',
      printHidden: true,
      pin: 'right',
      cell: (g) =>
        g.shipments.length === 1 ? (
          shipmentActions(g.shipments[0])
        ) : (
          <RowActions
            inline={1}
            actions={[
              { label: 'Purchase order', href: `/purchases/${g.contractId}`, icon: FileText },
              { label: 'Receive goods', href: `/purchases/${g.contractId}`, icon: PackageCheck, overflowOnly: true },
              { label: 'Trace this reference', href: `/trace?ref=${encodeURIComponent(g.contractReference)}`, icon: Boxes, overflowOnly: true },
            ]}
          />
        ),
    },
  ];

  /** The item and container lines of one order, each with its own ETA, status and actions. */
  function renderOrderLines(group: OrderGroup) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] text-sm" data-testid="order-lines">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
              <th className="py-1.5 pr-3 font-medium">Item</th>
              <th className="py-1.5 pr-3 font-medium">Container</th>
              <th className="py-1.5 pr-3 font-medium">Lot</th>
              <th className="py-1.5 pr-3 font-medium">Batch</th>
              <th className="py-1.5 pr-3 text-right font-medium">KG</th>
              <th className="py-1.5 pr-3 font-medium">ETA</th>
              <th className="py-1.5 pr-3 font-medium">Status</th>
              <th className="py-1.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {group.shipments.flatMap((row) =>
              (row.lines.length > 0 ? row.lines : [null]).map((line, index) => (
                <tr key={`${row.shipmentId}-${line?.batchId ?? 'none'}`} className="border-b border-line/60 align-top last:border-0">
                  <td className="py-1.5 pr-3 font-medium">
                    {line?.itemName ?? itemNames(row)}
                    {group.shipments.length > 1 && index === 0 ? (
                      <span className="block text-[11px] font-normal text-ink-subtle">
                        Shipment {row.shipmentOrdinal} of {row.shipmentsOnOrder}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{line?.containerNumber ?? row.containerNumbers.join(', ') ?? '—'}</td>
                  <td className="py-1.5 pr-3 text-xs text-ink-muted">{line?.lotNumber ?? '—'}</td>
                  <td className="py-1.5 pr-3 text-xs">{line?.batchNumber ?? '—'}</td>
                  <td className="tnum py-1.5 pr-3 text-right">{line?.quantity ?? row.quantity}</td>
                  <td className="py-1.5 pr-3">{index === 0 ? eta.cell!(row) : <span className="text-xs text-ink-subtle">same shipment</span>}</td>
                  <td className="py-1.5 pr-3">{index === 0 ? status.cell!(row) : null}</td>
                  <td className="py-1.5 text-right">{index === 0 ? shipmentActions(row) : null}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    );
  }




  return (
    <>
      <DataTable
      prefsKey="loading-sheet-orders"
        data={groups}
        columns={groupColumns}
        getRowId={(g) => g.id}
        dense
        pageSize={50}
        exportHref={canExport ? '/api/export/loading-sheet' : undefined}
        expandedContent={(g) => renderOrderLines(g)}
        searchValue={(g) =>
          g.shipments.flatMap((r) => [
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
          ])
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

      <ConfirmDialog
          open={undoRow !== null}
          onOpenChange={(open) => {
            if (!open) setUndoRow(null);
          }}
          title="Return this shipment to Pending loading?"
          description="So that you can edit its loading details and mark it loaded again. The shipping line, booking and dates are kept. Refused once the coffee is in stock."
          confirmLabel="Undo loading"
          onConfirm={async () => {
            if (!undoRow) return;
            const result = await undoLoadingAction(undoRow.shipmentId, '');
            if (!result || !result.ok) throw new Error(result?.error ?? 'The loading could not be undone.');
            toast.success(result.message ?? 'Back to pending loading.');
            router.refresh();
          }}
        />

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

