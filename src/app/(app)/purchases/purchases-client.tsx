'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { CONTAINER_STAGE_META, type ContainerStage } from '@/lib/container-stage';
import { Ship, PackageCheck, BookOpen, Zap } from 'lucide-react';
import { RowActions, viewAction, editAction } from '@/components/shared/row-actions';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { TRANSACTION_STATUS_META, type BadgeTone } from '@/lib/constants';
import { QuickUpdatePanel } from '@/components/shipments/quick-update-panel';
import { deletePurchaseContractAction } from '@/server/actions/trading-actions';
import { DeleteShipmentDialog } from '@/components/shipments/delete-shipment-dialog';

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
  stage: ContainerStage;
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
  containerCount: number;
  arrivedContainers: number;
  shipments: PurchaseShipmentRow[];
  receivedPct: number;
  receivedLabel: string;
  outstandingLabel: string;
  outstandingUsd: number;
  warehouseNames: string;
  /** The containers' daily position — loaded, documents, ETA, received — or null before approval. */
  ops: {
    loadingLabel: string;
    loadingTone: BadgeTone;
    loadedShare: number;
    documentsLabel: string;
    documents: Array<{ label: string; count: number; tone: BadgeTone }>;
    etaLabel: string;
    etaVaries: boolean;
    arrivalTone: BadgeTone;
    receiptLabel: string;
    receiptTone: BadgeTone;
    receivedShare: number;
  } | null;
};

/**
 * "3 of 5 containers arrived" — the order's arrival counted the way the
 * client counts it. A one-container order just says where that container is.
 */
function arrivalLabel(r: PurchaseRow): string {
  if (r.shipmentCount === 0) return '';
  if (r.containerCount <= 1 && r.shipments[0]) return CONTAINER_STAGE_META[r.shipments[0].stage].label;
  return `${r.arrivedContainers} of ${r.containerCount} containers arrived`;
}

export function PurchasesClient({
  rows,
  canCreate,
  showCost,
  canEdit = false,
  canQuickUpdate = false,
  canDeleteDraft = false,
  canReverse = false,
}: {
  rows: PurchaseRow[];
  canCreate: boolean;
  showCost: boolean;
  canEdit?: boolean;
  /** May open Quick Update; what it may change inside is checked again there. */
  canQuickUpdate?: boolean;
  canDeleteDraft?: boolean;
  /** Deleting an approved order (and its shipment) reverses it. */
  canReverse?: boolean;
}) {
  const [quick, setQuick] = React.useState<{ id: string; label: string } | null>(null);
  const [deleting, setDeleting] = React.useState<{ id: string; label: string } | null>(null);

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
      sortValue: (r) => (r.containerCount ? r.arrivedContainers / r.containerCount : -1),
      exportValue: (r) => arrivalLabel(r),
      cell: (r) => {
        if (r.shipmentCount === 0) return <span className="text-ink-subtle">—</span>;
        if (r.containerCount <= 1 && r.shipments[0]) {
          const meta = CONTAINER_STAGE_META[r.shipments[0].stage];
          return <Badge tone={meta.tone}>{meta.label}</Badge>;
        }
        return (
          <Badge tone={r.arrivedContainers === r.containerCount ? 'success' : r.arrivedContainers > 0 ? 'warning' : 'neutral'}>
            {arrivalLabel(r)}
          </Badge>
        );
      },
    },
    {
      id: 'loadStatus',
      header: 'Load Status',
      mobile: 'meta',
      sortValue: (r) => r.ops?.loadedShare ?? -1,
      exportValue: (r) => r.ops?.loadingLabel ?? '',
      cell: (r) => (r.ops ? <Badge tone={r.ops.loadingTone}>{r.ops.loadingLabel}</Badge> : <span className="text-ink-subtle">—</span>),
    },
    {
      id: 'documents',
      header: 'Documents',
      hideable: true,
      exportValue: (r) => r.ops?.documentsLabel ?? '',
      cell: (r) => {
        if (!r.ops) return <span className="text-ink-subtle">—</span>;
        if (r.ops.documents.length === 1) return <Badge tone={r.ops.documents[0].tone}>{r.ops.documents[0].label}</Badge>;
        return (
          <span className="block min-w-28 text-xs">
            {r.ops.documents.map((d) => (
              <span key={d.label} className="block whitespace-nowrap">
                <span className="tnum font-semibold">{d.count}</span> {d.label}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      id: 'eta',
      header: 'ETA',
      hideable: true,
      exportValue: (r) => r.ops?.etaLabel ?? '',
      cell: (r) =>
        r.ops ? (
          <span className="block whitespace-nowrap">
            {r.ops.etaLabel}
            {r.ops.etaVaries ? <span className="block text-[11px] text-ink-subtle">Multiple ETAs</span> : null}
          </span>
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
    },
    {
      id: 'receipt',
      header: 'Receipt',
      mobile: 'meta',
      sortValue: (r) => r.ops?.receivedShare ?? -1,
      exportValue: (r) => r.ops?.receiptLabel ?? '',
      cell: (r) => (r.ops ? <Badge tone={r.ops.receiptTone}>{r.ops.receiptLabel}</Badge> : <span className="text-ink-subtle">—</span>),
    },
    {
      id: 'shipments',
      header: 'Shipments',
      numeric: true,
      hideable: true,
      defaultHidden: true,
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
        <div className="flex items-center justify-end gap-1">
          {canQuickUpdate && r.status === 'POSTED' && r.shipmentCount > 0 ? (
            <Button size="sm" variant="accent" className="shrink-0" onClick={() => setQuick({ id: r.id, label: r.contractReference })} data-testid="quick-update-open">
              <Zap />
              Quick Update
            </Button>
          ) : null}
        <RowActions
          destructive={{
            status: r.status,
            noun: r.status === 'DRAFT' ? 'purchase order' : 'shipment',
            cancelLabel: 'Delete shipment',
            show: r.status === 'DRAFT' ? canDeleteDraft : r.status === 'POSTED' && canReverse,
            // An approved order: the Delete Shipment window, which undoes what it must.
            ...(r.status === 'POSTED' ? { onSelect: () => setDeleting({ id: r.id, label: r.contractReference }) } : {}),
            run: async () => {
              const result = await deletePurchaseContractAction(r.id);
              return result.ok ? { ok: true } : { ok: false, error: result.error };
            },
          }}
          actions={[
            viewAction(`/purchases/${r.id}`),
            editAction(`/purchases/${r.id}/edit`, canEdit && r.status === 'DRAFT'),
            { label: 'Edit order', href: `/purchases/${r.id}/correct`, icon: 'edit', show: canEdit && r.status === 'POSTED' && r.receivedPct === 0 },
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
        </div>
      ),
    },
  ];

  return (
    <>
    <DataTable
      share={{ report: 'purchase-orders', title: 'Purchase Orders' }}
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
              {r.shipments.length === 1 ? 'The one container on this order' : `The ${r.shipments.length} containers on this order`}
              {r.containerCount !== r.shipments.length ? ` (${r.containerCount} containers on ${r.shipmentCount} ${r.shipmentCount === 1 ? 'shipment' : 'shipments'})` : ''}
            </p>
            <table className="data-grid grid-framed w-full min-w-[40rem] text-sm">
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
                  const meta = CONTAINER_STAGE_META[s.stage];
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
                        <Badge tone={meta.tone}>{meta.label}</Badge>
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
    {deleting ? (
      <DeleteShipmentDialog
        open
        contractId={deleting.id}
        label={deleting.label}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    ) : null}
    {quick ? (
      <QuickUpdatePanel
        open
        contractId={quick.id}
        contractLabel={quick.label}
        onOpenChange={(open) => {
          if (!open) setQuick(null);
        }}
      />
    ) : null}
    </>
  );
}


/** Received, part received, or still to come. */
function goodsState(row: PurchaseRow): { label: string; tone: 'success' | 'progress' | 'neutral' } {
  if (row.receivedPct >= 100) return { label: 'Received', tone: 'success' };
  if (row.receivedPct > 0) return { label: 'Part received', tone: 'progress' };
  return { label: 'Awaiting goods', tone: 'neutral' };
}
