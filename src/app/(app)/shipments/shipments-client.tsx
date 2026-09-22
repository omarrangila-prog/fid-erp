'use client';

import * as React from 'react';
import Link from 'next/link';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Calculator, CalendarClock, Receipt, Search, Ship } from 'lucide-react';
import { RowActions, viewAction } from '@/components/shared/row-actions';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { SHIPMENT_STATUS_META, DOCUMENT_STATUS_META, SETTLEMENT_STATUS_META, type BadgeTone } from '@/lib/constants';
import { EtaDialog } from '@/app/(app)/loading/eta-dialog';

/** One container/item line inside a shipment. */
export type ShipmentLineRow = {
  key: string;
  shipmentId: string;
  /** "2 of 3" when the order's lines are kept on separate shipment records. */
  recordLabel: string | null;
  itemName: string;
  containerNumber: string | null;
  lotNumber: string | null;
  batchNumber: string | null;
  quantityLabel: string;
  warehouse: string;
  etaDate: string;
  etaIso: string | null;
  etaDays: number | null;
  status: string;
  receipt: string;
  bookingNumber: string | null;
  billOfLading: string | null;
  landedUsd: string | null;
  costPerKg: string | null;
};

/** One shipment: the order it was bought on, with its containers and items. */
export type ShipmentGroupRow = {
  id: string;
  label: string;
  sequence: number;
  firstShipmentId: string;
  shipmentIds: string[];
  contractNumber: string;
  contractReference: string;
  vendorName: string;
  customerName: string | null;
  items: string[];
  containers: number;
  kgLabel: string;
  kgSort: number;
  bags: number;
  warehouse: string;
  warehouseNames: string;
  etaLabel: string;
  etaSort: number;
  etaDays: number | null;
  statuses: string[];
  documentStatuses: string[];
  settlements: string[];
  soldPct: number;
  soldLabel: string;
  booking: string | null;
  billOfLading: string | null;
  shippingLine: string | null;
  vesselName: string | null;
  searchText: string;
  purchaseUsd: string | null;
  expensesLocal: string | null;
  expensesUsd: string | null;
  landedUsd: string | null;
  landedLocal: string | null;
  costPerKg: string | null;
  costPerKgLocal: string | null;
  costPerMt: string | null;
  costPerMtLocal: string | null;
  remainingKg: string | null;
  lines: ShipmentLineRow[];
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Every record agrees → that status; otherwise how many are at each. */
function StatusSummary({ values, meta }: { values: string[]; meta: Record<string, { label: string; tone: BadgeTone }> }) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  if (counts.size <= 1) return <StatusBadge status={values[0] ?? ''} meta={meta} />;
  return (
    <span className="flex flex-col items-start gap-0.5">
      {[...counts].map(([value, n]) => (
        <Badge key={value} tone={meta[value]?.tone ?? 'neutral'}>
          {n} {meta[value]?.label ?? value}
        </Badge>
      ))}
    </span>
  );
}

function itemsLabel(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '—';
  const joined = items.join(' + ');
  return joined.length <= 48 ? joined : plural(items.length, 'item', 'items');
}

export function ShipmentsClient({
  rows,
  emptyAction,
  showCost = false,
  canAddExpense = false,
  canUpdateEta = false,
}: {
  rows: ShipmentGroupRow[];
  emptyAction?: React.ReactNode;
  showCost?: boolean;
  canAddExpense?: boolean;
  canUpdateEta?: boolean;
}) {
  const [editingEta, setEditingEta] = React.useState<{ line: ShipmentLineRow; reference: string } | null>(null);

  const columns: DataColumn<ShipmentGroupRow>[] = [
    {
      id: 'number',
      header: 'Shipment',
      mobile: 'title',
      sortValue: (r) => r.sequence,
      exportValue: (r) => r.label,
      cell: (r) => <span className="block min-w-24 font-medium">{r.label}</span>,
    },
    {
      id: 'contract',
      header: 'ICUL/FID Reference',
      sortValue: (r) => r.contractReference,
      exportValue: (r) => r.contractReference,
      cell: (r) => <span className="block min-w-44 font-mono text-xs font-medium">{r.contractReference}</span>,
    },
    {
      id: 'items',
      header: 'Items',
      mobile: 'meta',
      sortValue: (r) => r.items.join(' '),
      exportValue: (r) => r.items.join(' + '),
      cell: (r) => (
        <span className="block min-w-32" title={r.items.join('\n')}>
          <span className="block">{itemsLabel(r.items)}</span>
          {r.items.length > 1 ? (
            <span className="block text-xs text-ink-subtle">{plural(r.items.length, 'item', 'items')}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'containers',
      header: 'Containers',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.containers,
      exportValue: (r) => r.containers,
      cell: (r) => plural(r.containers, 'container', 'containers'),
    },
    {
      id: 'quantity',
      header: 'Total KG',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.kgSort,
      exportValue: (r) => r.kgLabel,
      cell: (r) => (
        <span>
          <span className="block">{r.kgLabel}</span>
          <span className="block text-xs text-ink-subtle">{r.bags.toLocaleString()} bags</span>
        </span>
      ),
    },
    {
      id: 'warehouse',
      header: 'Warehouse',
      mobile: 'meta',
      sortValue: (r) => r.warehouse,
      exportValue: (r) => r.warehouseNames || r.warehouse,
      cell: (r) => <span title={r.warehouseNames}>{r.warehouse}</span>,
    },
    { id: 'vendor', header: 'Supplier', hideable: true, sortValue: (r) => r.vendorName, cell: (r) => r.vendorName },
    ...(showCost
      ? [
          {
            id: 'purchase',
            header: 'Purchase USD',
            hideable: true,
            numeric: true,
            cell: (r: ShipmentGroupRow) => <span className="font-medium">{r.purchaseUsd ?? '—'}</span>,
          } satisfies DataColumn<ShipmentGroupRow>,
          {
            id: 'expensesLocal',
            header: 'Local expenses',
            hideable: true,
            numeric: true,
            cell: (r: ShipmentGroupRow) => (
              <span>
                <span className="block">{r.expensesLocal ?? '—'}</span>
                {r.expensesUsd ? <span className="block text-xs text-ink-subtle">{r.expensesUsd}</span> : null}
              </span>
            ),
          } satisfies DataColumn<ShipmentGroupRow>,
          {
            id: 'landed',
            header: 'Landed USD',
            hideable: true,
            numeric: true,
            cell: (r: ShipmentGroupRow) => (
              <span>
                <span className="block font-medium">{r.landedUsd ?? '—'}</span>
                {r.landedLocal ? <span className="block text-xs text-ink-subtle">{r.landedLocal}</span> : null}
              </span>
            ),
          } satisfies DataColumn<ShipmentGroupRow>,
          {
            id: 'costKg',
            header: 'Cost / KG',
            hideable: true,
            numeric: true,
            exportValue: (r: ShipmentGroupRow) => r.costPerKg ?? '',
            cell: (r: ShipmentGroupRow) => (
              <span>
                <span className="block font-medium">{r.costPerKg ?? '—'}</span>
                {r.costPerKgLocal ? <span className="block text-xs text-ink-subtle">{r.costPerKgLocal}</span> : null}
                {r.costPerMt ? (
                  <span className="block text-[11px] text-ink-subtle">
                    {r.costPerMt} / MT
                    {r.costPerMtLocal ? ` · ${r.costPerMtLocal} / MT` : ''}
                  </span>
                ) : null}
              </span>
            ),
          } satisfies DataColumn<ShipmentGroupRow>,
          {
            id: 'remaining',
            header: 'Remaining KG',
            hideable: true,
            defaultHidden: true,
            numeric: true,
            cell: (r: ShipmentGroupRow) => r.remainingKg ?? '—',
          } satisfies DataColumn<ShipmentGroupRow>,
        ]
      : []),
    {
      id: 'sold',
      header: 'Sold',
      hideable: true,
      defaultHidden: true,
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
      defaultHidden: true,
      cell: (r) => (
        <span className="text-xs">
          <span className="block">{r.booking ?? '—'}</span>
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
      exportValue: (r) => r.etaLabel,
      cell: (r) => (
        <span>
          <span className="block whitespace-nowrap">{r.etaLabel}</span>
          {r.etaDays !== null ? (
            <span className={`block text-xs ${r.etaDays <= 3 ? 'font-medium text-amber-700' : 'text-ink-subtle'}`}>
              {r.etaDays < 0 ? `${Math.abs(r.etaDays)}d late` : r.etaDays === 0 ? 'today' : `in ${r.etaDays}d`}
            </span>
          ) : r.lines.length > 1 && r.etaLabel.includes('–') ? (
            <span className="block text-xs text-ink-subtle">Multiple ETAs</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'documents',
      header: 'Documents',
      hideable: true,
      defaultHidden: true,
      cell: (r) => <StatusSummary values={r.documentStatuses} meta={DOCUMENT_STATUS_META} />,
    },
    {
      id: 'payment',
      header: 'Payment',
      hideable: true,
      defaultHidden: true,
      cell: (r) => <StatusSummary values={r.settlements} meta={SETTLEMENT_STATUS_META} />,
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.statuses.join(' '),
      exportValue: (r) => [...new Set(r.statuses.map((s) => SHIPMENT_STATUS_META[s]?.label ?? s))].join(', '),
      cell: (r) => <StatusSummary values={r.statuses} meta={SHIPMENT_STATUS_META} />,
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
            viewAction(`/shipments/${r.firstShipmentId}`),
            { label: 'Costing', href: `/shipments/${r.firstShipmentId}#costing`, icon: Calculator },
            {
              label: 'Add expense',
              href: `/finance/expenses/new?job=${r.firstShipmentId}`,
              icon: Receipt,
              show: canAddExpense,
              overflowOnly: true,
            },
            {
              label: 'Trace this reference',
              href: `/trace?ref=${encodeURIComponent(r.contractReference)}`,
              icon: Search,
              overflowOnly: true,
            },
            { label: 'Loading sheet', href: '/loading', icon: Ship, overflowOnly: true },
          ]}
        />
      ),
    },
  ];

  function renderLines(row: ShipmentGroupRow) {
    return (
      <div className="px-4 py-3">
        <p className="mb-2 text-xs text-ink-muted">
          <span className="font-medium text-ink">{row.label}</span> · {row.contractReference} ·{' '}
          {plural(row.items.length, 'item', 'items')} · {plural(row.containers, 'container', 'containers')} ·{' '}
          {row.kgLabel}
        </p>
        <table className="w-full min-w-[56rem] text-sm" data-testid="shipment-lines">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink-subtle">
              <th className="py-1.5 pr-3 font-medium">Item</th>
              <th className="py-1.5 pr-3 font-medium">Container</th>
              <th className="py-1.5 pr-3 font-medium">Lot</th>
              <th className="py-1.5 pr-3 font-medium">Batch</th>
              <th className="py-1.5 pr-3 text-right font-medium">KG</th>
              <th className="py-1.5 pr-3 font-medium">Warehouse</th>
              <th className="py-1.5 pr-3 font-medium">ETA</th>
              <th className="py-1.5 pr-3 font-medium">Arrival</th>
              <th className="py-1.5 pr-3 font-medium">Receipt</th>
              {showCost ? <th className="py-1.5 pr-3 text-right font-medium">Landed USD</th> : null}
              <th className="py-1.5 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {row.lines.map((line) => (
              <tr key={line.key} className="border-t border-line align-top">
                <td className="py-1.5 pr-3">
                  <span className="block font-medium">{line.itemName}</span>
                  {line.recordLabel ? (
                    <span className="block text-[11px] text-ink-subtle">record {line.recordLabel}</span>
                  ) : null}
                </td>
                <td className="py-1.5 pr-3 font-mono text-xs">{line.containerNumber ?? '—'}</td>
                <td className="py-1.5 pr-3 text-xs">{line.lotNumber ?? '—'}</td>
                <td className="py-1.5 pr-3 text-xs">{line.batchNumber ?? '—'}</td>
                <td className="tnum py-1.5 pr-3 text-right">{line.quantityLabel}</td>
                <td className="py-1.5 pr-3 text-xs">{line.warehouse}</td>
                <td className="py-1.5 pr-3 text-xs">
                  {canUpdateEta ? (
                    <button
                      type="button"
                      onClick={() => setEditingEta({ line, reference: row.contractReference })}
                      className="whitespace-nowrap rounded px-1 py-0.5 text-left underline decoration-dotted underline-offset-2 hover:bg-forest-50"
                      title="Change the expected arrival"
                    >
                      {line.etaIso ? line.etaDate : <span className="text-ink-subtle">Set ETA</span>}
                    </button>
                  ) : (
                    <span className="whitespace-nowrap">{line.etaDate}</span>
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  <StatusBadge status={line.status} meta={SHIPMENT_STATUS_META} />
                </td>
                <td className="py-1.5 pr-3 text-xs">{line.receipt}</td>
                {showCost ? (
                  <td className="tnum py-1.5 pr-3 text-right text-xs">
                    <span className="block">{line.landedUsd ?? '—'}</span>
                    {line.costPerKg ? <span className="block text-ink-subtle">{line.costPerKg} / KG</span> : null}
                  </td>
                ) : null}
                <td className="py-1.5 text-right">
                  <RowActions
                    actions={[
                      viewAction(`/shipments/${line.shipmentId}`),
                      ...(canUpdateEta
                        ? [
                            {
                              label: 'Update ETA',
                              icon: CalendarClock,
                              onSelect: () => setEditingEta({ line, reference: row.contractReference }),
                            },
                          ]
                        : []),
                      { label: 'Costing', href: `/shipments/${line.shipmentId}#costing`, icon: Calculator, overflowOnly: true },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-ink-subtle">
          <Link href={`/shipments/${row.firstShipmentId}`} className="text-forest-800 hover:text-gold-700">
            Open the full shipment
          </Link>{' '}
          for documents, costs and history.
        </p>
      </div>
    );
  }

  return (
    <>
      <DataTable
        prefsKey="shipments-grouped"
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        rowHref={(r) => `/shipments/${r.firstShipmentId}`}
        expandedContent={renderLines}
        searchValue={(r) => `${r.label} ${r.searchText}`}
        searchPlaceholder="Search by reference, item, container, lot, booking, B/L or vessel…"
        emptyAction={emptyAction}
        emptyTitle="No shipments yet"
        emptyDescription="A shipment is opened automatically when a purchase order is approved."
      />
      {editingEta ? (
        <EtaDialog
          shipmentId={editingEta.line.shipmentId}
          contractLabel={editingEta.reference}
          currentEta={editingEta.line.etaIso}
          onClose={() => setEditingEta(null)}
        />
      ) : null}
    </>
  );
}
