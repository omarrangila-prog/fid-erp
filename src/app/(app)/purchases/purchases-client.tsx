'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { SHIPMENT_STATUS_META } from '@/lib/constants';
import { Ship, PackageCheck, BookOpen } from 'lucide-react';
import { RowActions, viewAction, editAction } from '@/components/shared/row-actions';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { TRANSACTION_STATUS_META } from '@/lib/constants';

export type PurchaseShipmentRow = {
  /** The batch, or the shipment when it has none yet. */
  id: string;
  shipmentId: string;
  ordinal: number;
  status: string;
  itemName: string;
  containerNumber: string | null;
  lotNumber: string | null;
  batchNumber: string | null;
  quantityLabel: string;
  receivedLabel: string;
  arrived: boolean;
  received: boolean;
  date: string;
  warehouseNames: string;
};

export type PurchaseRow = {
  id: string;
  contractNumber: string;
  contractReference: string;
  supplierContractNo: string | null;
  contractDate: string;
  contractDateSort: number;
  vendorName: string;
  origin: string | null;
  itemNames: string;
  currency: string;
  totalValueLabel: string;
  totalValueUsd: number;
  quantityLabel: string;
  quantityKg: number;
  bags: number;
  containers: number;
  status: string;
  /** Set only when the order has exactly one shipment; otherwise the child rows carry them. */
  shipmentId: string | null;
  shipmentStatus: string | null;
  shipmentCount: number;
  arrivedCount: number;
  shipments: PurchaseShipmentRow[];
  receivedPct: number;
  receivedLabel: string;
  outstandingLabel: string;
  outstandingUsd: number;
  warehouseNames: string;
};

/** "2 of 3 arrived" — the order's arrival in the client's own words. */
function arrivalLabel(r: PurchaseRow): string {
  if (r.shipmentCount === 0) return '';
  if (r.shipmentCount === 1 && r.shipmentStatus) return SHIPMENT_STATUS_META[r.shipmentStatus]?.label ?? r.shipmentStatus;
  if (r.arrivedCount === r.shipmentCount) return 'Fully arrived';
  if (r.arrivedCount === 0) return 'Not arrived';
  return `${r.arrivedCount} of ${r.shipmentCount} arrived`;
}

export function PurchasesClient({
  rows,
  canCreate,
  showCost,
  canEdit = false,
}: {
  rows: PurchaseRow[];
  canCreate: boolean;
  showCost: boolean;
  canEdit?: boolean;
}) {
  const columns: DataColumn<PurchaseRow>[] = [
    {
      id: 'contract',
      header: 'Contract',
      mobile: 'title',
      sortValue: (r) => r.contractReference,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.contractReference}</span>
        </span>
      ),
    },
    {
      id: 'date',
      header: 'Date',
      mobile: 'meta',
      sortValue: (r) => r.contractDateSort,
      cell: (r) => r.contractDate,
    },
    {
      id: 'vendor',
      header: 'Supplier',
      mobile: 'meta',
      sortValue: (r) => r.vendorName,
      cell: (r) => (
        <span>
          <span className="block">{r.vendorName}</span>
          {r.origin ? <span className="block text-xs text-ink-subtle">{r.origin}</span> : null}
        </span>
      ),
    },
    {
      id: 'coffee',
      header: 'Coffee',
      hideable: true,
      cell: (r) => <span className="block max-w-56 truncate text-xs">{r.itemNames}</span>,
    },
    {
      id: 'warehouse',
      header: 'Warehouse',
      mobile: 'meta',
      sortValue: (r) => r.warehouseNames,
      cell: (r) => r.warehouseNames || '—',
    },
    {
      id: 'quantity',
      header: 'Quantity',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.quantityKg,
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
            id: 'value',
            header: 'Contract value',
            numeric: true,
            mobile: 'meta',
            sortValue: (r: PurchaseRow) => r.totalValueUsd,
            cell: (r: PurchaseRow) => r.totalValueLabel,
          } satisfies DataColumn<PurchaseRow>,
        ]
      : []),
    {
      id: 'received',
      header: 'Received',
      numeric: true,
      hideable: true,
      sortValue: (r) => r.receivedPct,
      cell: (r) => (
        <span className={r.receivedPct >= 100 ? 'text-gold-700' : r.receivedPct > 0 ? 'text-amber-700' : 'text-ink-subtle'}>
          {r.receivedLabel}
        </span>
      ),
    },
    {
      id: 'outstanding',
      header: 'We owe',
      numeric: true,
      hideable: true,
      sortValue: (r) => r.outstandingUsd,
      cell: (r) => r.outstandingLabel,
    },
    {
      id: 'job',
      header: 'Job',
      hideable: true,
      cell: (r) => (r.contractReference ? <Badge tone="neutral">{r.contractReference}</Badge> : '—'),
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      exportValue: (r) => TRANSACTION_STATUS_META[r.status]?.label ?? r.status,
      cell: (r) => <StatusBadge status={r.status} meta={TRANSACTION_STATUS_META} />,
    },
    {
      /*
       * Whether the coffee has actually turned up.
       *
       * "Posted" only says the contract is approved and the supplier is owed.
       * The question asked of this screen every day is a different one — has it
       * arrived — and answering it meant opening the contract and comparing two
       * quantities. The percentage is still in its own column for anyone who
       * wants the detail; this is the answer in a word.
       */
      id: 'goods',
      header: 'Goods',
      mobile: 'badge',
      sortValue: (r) => r.receivedPct,
      exportValue: (r) => goodsState(r).label,
      cell: (r) => {
        if (r.status !== 'POSTED') return <span className="text-ink-subtle">—</span>;
        const state = goodsState(r);
        return <Badge tone={state.tone}>{state.label}</Badge>;
      },
    },
    {
      id: 'containers',
      header: 'Containers',
      numeric: true,
      hideable: true,
      sortValue: (r) => r.containers,
      exportValue: (r) => r.containers,
      cell: (r) => (r.containers > 0 ? r.containers : <span className="text-ink-subtle">—</span>),
    },
    {
      id: 'currency',
      header: 'Currency',
      hideable: true,
      sortValue: (r) => r.currency,
      exportValue: (r) => r.currency,
      cell: (r) => r.currency,
    },
    {
      // Where the consignment is, without opening the order to find out.
      id: 'loading',
      header: 'Arrival',
      mobile: 'badge',
      sortValue: (r) => (r.shipmentCount ? r.arrivedCount / r.shipmentCount : -1),
      exportValue: (r) => arrivalLabel(r),
      cell: (r) => {
        if (r.shipmentCount === 0) return <span className="text-ink-subtle">—</span>;
        if (r.shipmentCount === 1 && r.shipmentStatus) {
          const meta = SHIPMENT_STATUS_META[r.shipmentStatus];
          return <Badge tone={meta?.tone ?? 'neutral'}>{meta?.label ?? r.shipmentStatus}</Badge>;
        }
        return (
          <Badge tone={r.arrivedCount === r.shipmentCount ? 'success' : r.arrivedCount > 0 ? 'warning' : 'neutral'}>
            {arrivalLabel(r)}
          </Badge>
        );
      },
    },
    {
      id: 'shipments',
      header: 'Shipments',
      numeric: true,
      hideable: true,
      sortValue: (r) => r.shipmentCount,
      exportValue: (r) => String(r.shipmentCount),
      cell: (r) => (r.shipmentCount ? r.shipmentCount : <span className="text-ink-subtle">—</span>),
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
            viewAction(`/purchases/${r.id}`),
            editAction(`/purchases/${r.id}/edit`, canEdit && r.status === 'DRAFT'),
            { label: 'Loading sheet', href: '/loading', icon: Ship },
            { label: 'Shipment', href: r.shipmentId ? `/shipments/${r.shipmentId}` : '/shipments', icon: Ship, show: Boolean(r.shipmentId) },
            {
              label: 'Receive',
              href: `/purchases/${r.id}`,
              icon: PackageCheck,
              show: r.status === 'POSTED' && r.receivedPct < 100,
            },
            { label: 'Supplier ledger', href: '/ledgers/vendors', icon: BookOpen },
          ]}
        />
      ),
    },
  ];

  return (
    <DataTable
      prefsKey="purchases"
      data={rows}
      filters={[
      { id: 'status', label: 'Status', value: (r) => r.status },
      { id: 'supplier', label: 'Supplier', value: (r) => r.vendorName },
      { id: 'currency', label: 'Currency', value: (r) => r.currency },
      { id: 'loading', label: 'Arrival', value: (r) => arrivalLabel(r) || null },
      ]}
      expandedContent={(r) =>
        r.shipments.length === 0 ? (
          <p className="px-3 py-2 text-xs text-ink-muted">No shipments yet — approve the contract to open them.</p>
        ) : (
          <div className="overflow-x-auto">
            <p className="mb-2 text-xs text-ink-muted">
              {r.shipments.length === 1 ? 'The one shipment on this order' : `The ${r.shipments.length} shipments on this order`}
            </p>
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th className="py-1.5 pr-3 font-medium">Shipment</th>
                  <th className="py-1.5 pr-3 font-medium">Container</th>
                  <th className="py-1.5 pr-3 font-medium">Item</th>
                  <th className="py-1.5 pr-3 font-medium">Lot</th>
                  <th className="py-1.5 pr-3 font-medium">Batch</th>
                  <th className="py-1.5 pr-3 text-right font-medium">KG</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Received</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 font-medium">Warehouse</th>
                </tr>
              </thead>
              <tbody>
                {r.shipments.map((s) => {
                  const meta = SHIPMENT_STATUS_META[s.status];
                  return (
                    <tr key={s.id} className="border-b border-line/60 last:border-0">
                      <td className="py-1.5 pr-3 font-medium">
                        <Link href={`/shipments/${s.shipmentId}`} className="text-forest-800 hover:text-gold-700">
                          Shipment {s.ordinal}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{s.containerNumber ?? '—'}</td>
                      <td className="py-1.5 pr-3">{s.itemName}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{s.lotNumber ?? '—'}</td>
                      <td className="py-1.5 pr-3">{s.batchNumber ?? '—'}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.quantityLabel}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.receivedLabel}</td>
                      <td className="py-1.5 pr-3">
                        <Badge tone={meta?.tone ?? 'neutral'}>{meta?.label ?? s.status}</Badge>
                      </td>
                      <td className="py-1.5 text-xs text-ink-muted">{s.warehouseNames || (s.arrived ? 'Not yet received' : '—')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      }
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/purchases/${r.id}`}
      searchValue={(r) =>
        `${r.contractNumber} ${r.contractReference} ${r.supplierContractNo ?? ''} ${r.vendorName} ${r.itemNames} ${r.warehouseNames} ${r.shipments.map((s) => `${s.containerNumber ?? ''} ${s.lotNumber ?? ''} ${s.batchNumber ?? ''}`).join(' ')}`
      }
      searchPlaceholder="Search by contract, reference, supplier or coffee…"
      emptyTitle="No purchase contracts yet"
      emptyDescription="A purchase contract creates the supplier liability and opens a job. Goods are received separately."
      emptyAction={
        canCreate ? (
          <Button asChild>
            <Link href="/purchases/new">
              <Plus />
              New contract
            </Link>
          </Button>
        ) : undefined
      }
      toolbar={
        canCreate ? (
          <Button asChild>
            <Link href="/purchases/new">
              <Plus />
              <span className="hidden sm:inline">New contract</span>
              <span className="sm:hidden">New</span>
            </Link>
          </Button>
        ) : undefined
      }
    />
  );
}


/** Received, part received, or still to come. */
function goodsState(row: PurchaseRow): { label: string; tone: 'success' | 'progress' | 'neutral' } {
  if (row.receivedPct >= 100) return { label: 'Received', tone: 'success' };
  if (row.receivedPct > 0) return { label: 'Part received', tone: 'progress' };
  return { label: 'Awaiting goods', tone: 'neutral' };
}
