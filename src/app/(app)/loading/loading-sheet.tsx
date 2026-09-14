'use client';

import * as React from 'react';
import Link from 'next/link';
import { Ship, Users, Anchor, PackageCheck, FileText, Boxes } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { SHIPMENT_STATUS_META, DOCUMENT_STATUS_META, type BadgeTone } from '@/lib/constants';
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
};

export type LoadingRow = {
  id: string;
  shipmentId: string;
  contractId: string;
  contractDate: string;
  contractDateSort: number;
  contractNumber: string;
  contractReference: string;
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
 * The four statuses the follow-up sheet actually uses.
 *
 * Older rows may still hold Awaiting Loading, In Transit or Customs internally.
 * Those are shown as Pending Loading, Loaded or Arrived so the sheet does not
 * invent stages the workflow does not have.
 */
function displayStatus(row: LoadingRow): { label: string; tone: BadgeTone } {
  if (row.fullyReceived) return { label: 'PO Received', tone: 'success' };
  if (NOT_YET_LOADED.includes(row.status)) return { label: 'Pending Loading', tone: 'neutral' };
  if (row.status === 'IN_TRANSIT') return { label: 'Loaded', tone: 'info' };
  if (LANDED.includes(row.status) && row.status !== 'ARRIVED') return { label: 'Arrived', tone: 'info' };
  return SHIPMENT_STATUS_META[row.status] ?? { label: row.status, tone: 'neutral' };
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
          </span>
        </span>
      ))}
    </span>
  );
}

function receivableBatches(row: LoadingRow): ReceivableBatch[] {
  return row.lines
    .filter((line) => Number(line.outstandingKg) > 0.001)
    .map((line) => ({
      batchId: line.batchId,
      batchNumber: line.batchNumber,
      itemName: line.itemName,
      lotNumber: line.lotNumber,
      containerNumber: line.containerNumber,
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
    exportValue: (r) => `${r.contractDate} ${r.contractReference} (${r.contractNumber})`,
    cell: (r) => (
      <span className="block min-w-40">
        <Link href={`/purchases/${r.contractId}`} className="font-medium text-forest-700 hover:underline">
          {r.contractReference}
        </Link>
        <span className="block text-xs text-ink-subtle">
          {r.contractDate} · {r.contractNumber}
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
      return (
        <Link href={`/shipments/${r.shipmentId}`}>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </Link>
      );
    },
  };

  const actions: DataColumn<LoadingRow> = {
    id: 'actions',
    header: '',
    printHidden: true,
    cell: (r) => {
      const buttons: React.ReactNode[] = [];

      if (NOT_YET_LOADED.includes(r.status) && canUpdate) {
        buttons.push(
          <Button key="load" variant="outline" size="sm" onClick={() => setLoadingRow(r)}>
            <Ship />
            Mark loaded
          </Button>,
        );
      }

      if ((r.status === 'LOADED' || r.status === 'IN_TRANSIT' || LANDED.includes(r.status)) && canUpdate) {
        buttons.push(
          <Button key="docs" variant="outline" size="sm" onClick={() => setDocumentsRow(r)}>
            <FileText />
            Update documents
          </Button>,
        );
        buttons.push(
          <Button key="ctr" variant="outline" size="sm" onClick={() => setContainersRow(r)}>
            <Boxes />
            Manage containers
          </Button>,
        );
      }

      if ((r.status === 'LOADED' || r.status === 'IN_TRANSIT') && canUpdate) {
        buttons.push(
          <Button key="arrived" variant="outline" size="sm" onClick={() => setArrivingRow(r)}>
            <Anchor />
            Mark arrived
          </Button>,
        );
      }

      if (LANDED.includes(r.status) && !r.fullyReceived && receivableBatches(r).length > 0) {
        buttons.push(
          canReceive ? (
            <Button key="receive" variant="accent" size="sm" onClick={() => setReceivingRow(r)}>
              <PackageCheck />
              Receive PO
            </Button>
          ) : (
            <Button key="receive" variant="accent" size="sm" asChild>
              <Link href={`/purchases/${r.contractId}`}>
                <PackageCheck />
                Receive PO
              </Link>
            </Button>
          ),
        );
      }

      if (buttons.length === 0) return null;
      return <div className="flex flex-col items-stretch gap-1">{buttons}</div>;
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
      id: 'company',
      header: 'Company name',
      mobile: 'title',
      sortValue: (r) => r.exporter,
      exportValue: (r) => r.exporter,
      cell: (r) => <span className="block min-w-32 font-medium">{r.exporter}</span>,
    },
    contract,
    itemColumn,
    quantity,
    {
      id: 'containerQty',
      header: 'Container qty',
      numeric: true,
      sortValue: (r) => r.containers,
      exportValue: (r) => r.containers,
      cell: (r) => <span className="tabular-nums font-medium">{r.containers}</span>,
    },
    status,
    origin,
    shippingLine,
    booking,
    loadPort,
    dischargePort,
    {
      id: 'blOrContainer',
      header: 'B/L or container',
      exportValue: (r) => r.billOfLading ?? r.containerNumbers.join(', '),
      cell: (r) => (
        <span className="block whitespace-nowrap font-mono text-xs">
          {r.billOfLading ?? (r.containerNumbers.length > 0 ? r.containerNumbers.join(', ') : '—')}
        </span>
      ),
    },
    {
      id: 'sold',
      header: 'Sold / left',
      numeric: true,
      exportValue: (r) => `${r.sold} of ${r.quantity}`,
      cell: (r) => (
        <span className="block whitespace-nowrap">
          <Badge tone={SALE_META[r.saleStatus].tone}>{SALE_META[r.saleStatus].label}</Badge>
          <span className="mt-0.5 block text-xs text-ink-subtle">{r.available} left</span>
        </span>
      ),
    },
    documents,
    payment,
    eta,
    remarks,
    allocationsColumn,
    actions,
  ];

  return (
    <>
      <DataTable
        data={rows}
        columns={isDubai ? dubaiColumns : moroccoColumns}
        getRowId={(r) => r.id}
        dense
        pageSize={50}
        exportHref={canExport ? '/api/export/loading-sheet' : undefined}
        searchValue={(r) =>
          [
            r.contractReference,
            r.contractNumber,
            r.exporter,
            r.consignee,
            itemNames(r),
            ...r.lines.map((line) => `${line.lotNumber} ${line.batchNumber}`),
            ...r.containerNumbers,
            r.billOfLading,
            r.bookingNumber,
            r.shippingLine,
            r.origin,
            r.destination,
            r.remarks,
            ...r.allocations.map((a) => `${a.customerName} ${a.invoiceNumber}`),
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
          contractNumber={editingEta.contractNumber}
          currentEta={editingEta.etaIso}
          onClose={() => setEditingEta(null)}
        />
      ) : null}

      {arrivingRow ? (
        <ArrivedDialog
          shipmentId={arrivingRow.shipmentId}
          contractNumber={arrivingRow.contractNumber}
          onClose={() => setArrivingRow(null)}
        />
      ) : null}

      {loadingRow ? (
        <MarkLoadedDialog
          open
          onOpenChange={(open) => !open && setLoadingRow(null)}
          shipmentId={loadingRow.shipmentId}
          contractNumber={loadingRow.contractNumber}
          shippingLines={shippingLines}
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
          contractNumber={documentsRow.contractNumber}
          currentStatus={documentsRow.documentStatus}
          onClose={() => setDocumentsRow(null)}
        />
      ) : null}

      {containersRow ? (
        <ManageContainersDialog
          shipmentId={containersRow.shipmentId}
          contractNumber={containersRow.contractNumber}
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
          contractNumber={receivingRow.contractNumber}
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
                            {allocation.invoiceNumber}
                          </Link>
                          <span className="block text-xs text-ink-subtle">{allocation.invoiceDate}</span>
                        </TD>
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
