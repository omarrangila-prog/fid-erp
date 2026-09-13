'use client';

import * as React from 'react';
import Link from 'next/link';
import { Ship, Users, Anchor, PackageCheck } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { SHIPMENT_STATUS_META, DOCUMENT_STATUS_META, type BadgeTone } from '@/lib/constants';
import { MarkLoadedDialog } from '@/app/(app)/loading/mark-loaded-dialog';
import { EtaDialog, ArrivedDialog } from '@/app/(app)/loading/eta-dialog';

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

export type LoadingRow = {
  id: string;
  serial: number;
  shipmentId: string;
  contractId: string;
  contractDate: string;
  contractDateSort: number;
  contractNumber: string;
  contractReference: string;
  exporter: string;
  importer: string;
  consignee: string | null;
  itemName: string;
  origin: string;
  destination: string | null;
  lotNumber: string;
  batchNumber: string;
  containerNumber: string | null;
  containers: number;
  quantity: string;
  quantitySort: number;
  sold: string;
  available: string;
  bags: number;
  status: string;
  documentStatus: string;
  shippingLine: string | null;
  bookingNumber: string | null;
  billOfLading: string | null;
  etaDate: string;
  etaSort: number;
  traceabilityPending: boolean;
  portOfLoading: string | null;
  portOfDischarge: string | null;
  /** The ETA as `2026-04-18`, or null. Separate from `etaSort`, which is a
   *  sort key and carries a sentinel when there is no date. */
  etaIso: string | null;
  remarks: string | null;
  saleStatus: 'UNSOLD' | 'PARTIALLY_SOLD' | 'FULLY_SOLD';
  paymentStatus: string;
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
 * The loading / contract follow-up sheet.
 *
 * Two column sets, because the two businesses are not the same shape. Dubai
 * trades container to container, so its sheet leads with the container and the
 * consignee. Morocco buys a container and sells it to many customers over
 * weeks, so its sheet leads with the contract and what is left of it.
 *
 * Neither is a card grid. The client scans dozens of rows looking for one, and
 * cards make that slow — this is a table, with the columns the paper sheet
 * already had.
 */
export function LoadingSheet({
  rows,
  isDubai,
  canExport,
  canUpdate,
  shippingLines,
}: {
  rows: LoadingRow[];
  isDubai: boolean;
  canExport: boolean;
  /** Whether this user may move a consignment along. */
  canUpdate: boolean;
  shippingLines: Array<{ id: string; name: string }>;
}) {
  const [viewing, setViewing] = React.useState<LoadingRow | null>(null);
  const [loadingRow, setLoadingRow] = React.useState<LoadingRow | null>(null);
  const [editingEta, setEditingEta] = React.useState<LoadingRow | null>(null);
  const [arrivingRow, setArrivingRow] = React.useState<LoadingRow | null>(null);

  /** Columns shared by both sheets, in the order the paper sheet uses. */
  const serial: DataColumn<LoadingRow> = {
    id: 'serial',
    header: 'S/No',
    sortValue: (r) => r.serial,
    exportValue: (r) => r.serial,
    cell: (r) => <span className="tabular-nums text-ink-subtle">{r.serial}</span>,
  };

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
    sortValue: (r) => r.itemName,
    exportValue: (r) => r.itemName,
    cell: (r) => (
      <span className="block min-w-44">
        <span className="block">{r.itemName}</span>
        <span className="block text-xs text-ink-subtle">
          {r.traceabilityPending
            ? 'Lot not yet advised'
            : `Lot ${r.lotNumber}${r.batchNumber === r.lotNumber ? '' : ` · ${r.batchNumber}`}`}
        </span>
      </span>
    ),
  };

  /**
   * Lot and batch get columns of their own.
   *
   * They also appear under the coffee name, which is where the eye lands, but
   * the client tracks consignments by lot — "120229 and 120230, same Screen 12"
   * — and something you track by needs to be sortable, searchable and in the
   * spreadsheet. Hidden by default on a sheet that is already wide; one click
   * from the Columns control.
   */
  const lot: DataColumn<LoadingRow> = {
    id: 'lot',
    header: 'Lot',
    hideable: true,
    defaultHidden: true,
    sortValue: (r) => r.lotNumber,
    exportValue: (r) => (r.traceabilityPending ? '' : r.lotNumber),
    cell: (r) => (r.traceabilityPending ? <span className="text-ink-subtle">—</span> : r.lotNumber),
  };

  const batch: DataColumn<LoadingRow> = {
    id: 'batch',
    header: 'Batch',
    hideable: true,
    defaultHidden: true,
    sortValue: (r) => r.batchNumber,
    exportValue: (r) => (r.traceabilityPending ? '' : r.batchNumber),
    cell: (r) => (r.traceabilityPending ? <span className="text-ink-subtle">—</span> : r.batchNumber),
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
    sortValue: (r) => r.status,
    exportValue: (r) => SHIPMENT_STATUS_META[r.status]?.label ?? r.status,
    cell: (r) => {
      const meta = SHIPMENT_STATUS_META[r.status];
      return (
        <Link href={`/shipments/${r.shipmentId}`}>
          <Badge tone={meta?.tone ?? 'neutral'}>{meta?.label ?? r.status}</Badge>
        </Link>
      );
    },
  };

  /**
   * The one action this screen needs.
   *
   * Everything else on the sheet is derived — it fills itself in as documents
   * are raised elsewhere. Loading is the exception: it is a real event that
   * somebody has to record, and until now that meant opening the consignment,
   * changing a status and then editing four more fields. One button.
   */
  const actions: DataColumn<LoadingRow> = {
    id: 'actions',
    header: '',
    printHidden: true,
    cell: (r) => {
      if (!canUpdate) return null;

      if (NOT_YET_LOADED.includes(r.status)) {
        return (
          <Button variant="outline" size="sm" onClick={() => setLoadingRow(r)}>
            <Ship />
            Mark loaded
          </Button>
        );
      }

      // Loaded, and on the water. The next real event is that it lands.
      if (r.status === 'LOADED' || r.status === 'IN_TRANSIT') {
        return (
          <Button variant="outline" size="sm" onClick={() => setArrivingRow(r)}>
            <Anchor />
            Mark arrived
          </Button>
        );
      }

      /*
       * Arrived, so the next thing anybody wants is to receive it — and the
       * receipt lives on the purchase order, because that is where the ordered
       * quantities and the batches are. One click from here rather than a
       * hunt through the purchase list.
       */
      if (LANDED.includes(r.status) && Number(r.available.replace(/[^\d.]/g, '')) >= 0) {
        return (
          <Button variant="accent" size="sm" asChild>
            <Link href={`/purchases/${r.contractId}`}>
              <PackageCheck />
              Receive
            </Link>
          </Button>
        );
      }

      return null;
    },
  };

  /*
   * The shipping details, on the sheet rather than inside each consignment.
   *
   * They were only visible by opening the container one at a time, which for
   * eight or fifteen live shipments means eight or fifteen page loads to
   * answer one question. They are entered once when the consignment is marked
   * loaded and appear here immediately; scroll right and the whole book is on
   * one page.
   */
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
      return <Badge tone={meta?.tone ?? 'neutral'}>{meta?.label ?? r.documentStatus}</Badge>;
    },
  };

  /*
   * The ETA is edited here, in the row.
   *
   * A shipping line moves a date every two or three days, and staff walk the
   * live consignments updating fifteen or twenty at a sitting. Opening each
   * shipment to change one date is fifteen page loads to do five minutes of
   * work. There is no limit and no approval: it is a date somebody was told,
   * and every change is written to the audit trail with the date it replaced.
   */
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

  /**
   * Consignee, on the Dubai sheet only.
   *
   * Dubai trades container to container and the consignee is a real party on
   * the bill of lading. Morocco imports under its own name and sells the
   * container on to several customers afterwards, so there is no consignee to
   * name — the client asked for the column to go, and the customers who bought
   * from the container are listed beneath the row anyway.
   */
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
    // A column of buttons has no meaning on a printed sheet.
    printHidden: true,
    cell: (r) =>
      r.allocations.length > 0 ? (
        <Button size="sm" variant="outline" onClick={() => setViewing(r)}>
          View sales
        </Button>
      ) : null,
  };

  // --- Dubai: the paper sheet, container by container ----------------------
  const dubaiColumns: DataColumn<LoadingRow>[] = [
    serial,
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
    lot,
    batch,
    quantity,
    {
      id: 'origin',
      header: 'Origin',
      hideable: true,
      sortValue: (r) => r.origin,
      exportValue: (r) => r.origin,
      cell: (r) => r.origin,
    },
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
      exportValue: (r) => r.containerNumber ?? String(r.containers),
      cell: (r) => (
        <span className="block whitespace-nowrap">
          <span className="block font-mono text-xs">{r.containerNumber ?? '—'}</span>
          <span className="block text-xs text-ink-subtle">{r.containers} ctr</span>
        </span>
      ),
    },
    eta,
    payment,
    remarks,
    documents,
    allocationsColumn,
    actions,
  ];

  // --- Morocco: the simpler follow-up sheet --------------------------------
  const moroccoColumns: DataColumn<LoadingRow>[] = [
    serial,
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
    lot,
    batch,
    quantity,
    {
      id: 'containerQty',
      header: 'Container qty',
      numeric: true,
      sortValue: (r) => r.containers,
      exportValue: (r) => r.containers,
      cell: (r) => <span className="tabular-nums">{r.containers}</span>,
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
      exportValue: (r) => r.billOfLading ?? r.containerNumber ?? '',
      cell: (r) => (
        <span className="block whitespace-nowrap font-mono text-xs">
          {r.billOfLading ?? r.containerNumber ?? '—'}
        </span>
      ),
    },
    {
      id: 'line',
      header: 'Shipping line',
      sortValue: (r) => r.shippingLine ?? '',
      exportValue: (r) => r.shippingLine ?? '',
      cell: (r) => r.shippingLine ?? '—',
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
            r.contractReference, r.contractNumber, r.exporter, r.consignee, r.itemName,
            r.lotNumber, r.batchNumber, r.containerNumber, r.billOfLading, r.bookingNumber,
            r.shippingLine, r.origin, r.destination, r.remarks,
            ...r.allocations.map((a) => `${a.customerName} ${a.invoiceNumber}`),
          ]
            .filter(Boolean)
            .join(' ')
        }
        searchPlaceholder="Search contract, container, B/L, customer…"
        emptyTitle="Nothing loading yet"
        emptyDescription="Approve a purchase contract and its containers appear here automatically — there is no separate sheet to fill in."
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
            // From `etaIso`, not `etaSort`. The sort key holds
            // Number.MAX_SAFE_INTEGER when there is no ETA so the row sorts
            // last, and `new Date(…).toISOString()` on that throws
            // "RangeError: Invalid time value" — which is every consignment
            // that has not shipped, meaning every consignment this button
            // exists for. It crashed the dialog every time it was opened.
            etaDate: loadingRow.etaIso,
            bookingNumber: loadingRow.bookingNumber,
            billOfLading: loadingRow.billOfLading,
            containerNumber: loadingRow.containerNumber,
          }}
        />
      ) : null}

      <Dialog open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}>
        {viewing ? (
          <DialogContent
            title={`Sales from ${viewing.batchNumber}`}
            description={`${viewing.quantity} purchased on ${viewing.contractReference}. ${viewing.sold} sold, ${viewing.available} still available.`}
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
