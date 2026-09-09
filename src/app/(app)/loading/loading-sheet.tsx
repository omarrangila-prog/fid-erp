'use client';

import * as React from 'react';
import Link from 'next/link';
import { Ship, Users } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { SHIPMENT_STATUS_META, DOCUMENT_STATUS_META, type BadgeTone } from '@/lib/constants';

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
}: {
  rows: LoadingRow[];
  isDubai: boolean;
  canExport: boolean;
}) {
  const [viewing, setViewing] = React.useState<LoadingRow | null>(null);

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
          Lot {r.lotNumber} · {r.batchNumber}
        </span>
      </span>
    ),
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

  const eta: DataColumn<LoadingRow> = {
    id: 'eta',
    header: 'ETA',
    mobile: 'meta',
    sortValue: (r) => r.etaSort,
    exportValue: (r) => r.etaDate,
    cell: (r) => <span className="whitespace-nowrap">{r.etaDate}</span>,
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
    consignee,
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
  ];

  return (
    <>
      <DataTable
        data={rows}
        columns={isDubai ? dubaiColumns : moroccoColumns}
        getRowId={(r) => r.id}
        dense
        pageSize={50}
        exportFileName={canExport ? 'loading-sheet' : undefined}
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
