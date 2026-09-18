'use client';

import * as React from 'react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Layers, History, ShoppingCart, ArrowLeftRight } from 'lucide-react';
import { RowActions } from '@/components/shared/row-actions';
import { Select } from '@/components/ui/input';

export type StockRow = {
  id: string;
  itemName: string;
  itemCode: string;
  origin: string;
  category: string;
  warehouse: string;
  warehouseId: string;
  onHandLabel: string;
  onHandSort: number;
  reservedLabel: string;
  availableLabel: string;
  availableSort: number;
  inTransitLabel: string;
  bags: number;
  valueLabel: string;
  costPerKgLabel: string;
  valueSort: number;
  /** Every batch making up this row, with where it came from. */
  lots: Array<{
    batchNumber: string;
    reference: string;
    contractNumber: string;
    jobNumber: string;
    container: string;
    onHandLabel: string;
    availableLabel: string;
    bags: number;
  }>;
};

/**
 * Current stock, one row per coffee and warehouse.
 *
 * The company total and the per-warehouse split are both visible: "100,000 KG,
 * of which 75,000 in Warehouse A and 25,000 in Warehouse B" is the question
 * this screen exists to answer.
 */
export function StockClient({
  rows,
  warehouses,
  showValue,
  canExport,
  emptyAction,
}: {
  rows: StockRow[];
  warehouses: Array<{ id: string; name: string }>;
  showValue: boolean;
  canExport: boolean;
  /** Rendered inside the empty state; built on the server so permissions are checked there. */
  emptyAction?: React.ReactNode;
}) {
  const [warehouse, setWarehouse] = React.useState('ALL');

  const filtered = React.useMemo(
    () => (warehouse === 'ALL' ? rows : rows.filter((r) => r.warehouseId === warehouse)),
    [rows, warehouse],
  );

  const columns: DataColumn<StockRow>[] = [
    {
      id: 'item',
      header: 'Coffee',
      mobile: 'title',
      sortValue: (r) => r.itemName,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.itemName}</span>
          <span className="block text-xs text-ink-subtle">
            {r.origin}
          </span>
        </span>
      ),
    },
    {
      id: 'reference',
      header: 'Reference',
      mobile: 'meta',
      sortValue: (r) => r.lots[0]?.reference ?? '',
      exportValue: (r) => [...new Set(r.lots.map((l) => l.reference))].join(', '),
      // Where this coffee came from. Usually one contract; when a row holds
      // stock from more than one, the rest are counted rather than listed so
      // the column stays readable, and the breakdown below names them all.
      cell: (r) => {
        const refs = [...new Set(r.lots.map((l) => l.reference).filter((v) => v !== '—'))];
        if (refs.length === 0) return <span className="text-ink-subtle">—</span>;
        return (
          <span className="block min-w-40">
            <span className="block font-mono text-xs">{refs[0]}</span>
            {refs.length > 1 ? (
              <span className="block text-[11px] text-ink-subtle">+{refs.length - 1} more</span>
            ) : null}
          </span>
        );
      },
    },
    { id: 'warehouse', header: 'Warehouse', mobile: 'meta', sortValue: (r) => r.warehouse, cell: (r) => r.warehouse },
    {
      id: 'onHand',
      header: 'On hand',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.onHandSort,
      cell: (r) => r.onHandLabel,
    },
    { id: 'reserved', header: 'Reserved', numeric: true, hideable: true, cell: (r) => r.reservedLabel },
    {
      id: 'available',
      header: 'Available',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.availableSort,
      cell: (r) => <span className="font-medium">{r.availableLabel}</span>,
    },
    { id: 'bags', header: 'Bags', numeric: true, hideable: true, cell: (r) => r.bags.toLocaleString() },
    ...(showValue
      ? [
          {
            id: 'costPerKg',
            header: 'Landed cost / KG',
            numeric: true,
            mobile: 'meta',
            sortValue: (r: StockRow) => (r.onHandSort > 0 ? r.valueSort / r.onHandSort : 0),
            cell: (r: StockRow) => r.costPerKgLabel,
          } satisfies DataColumn<StockRow>,
          {
            id: 'value',
            header: 'Stock value',
            numeric: true,
            mobile: 'meta',
            sortValue: (r: StockRow) => r.valueSort,
            cell: (r: StockRow) => r.valueLabel,
          } satisfies DataColumn<StockRow>,
        ]
      : []),
    {
      id: 'actions',
      header: 'Actions',
      mobile: 'action',
      pin: 'right',
      printHidden: true,
      // Visibility only: the figures come from the stock ledger and are not
      // edited here. These are where a person goes from a stock line.
      cell: (r: StockRow) => (
        <RowActions
          actions={[
            { label: 'Batches', href: `/inventory/batches?q=${encodeURIComponent(r.itemName)}`, icon: Layers },
            { label: 'Movements', href: `/inventory/movements?q=${encodeURIComponent(r.itemName)}`, icon: History },
            { label: 'Sell', href: '/sales/new', icon: ShoppingCart, show: r.availableSort > 0 },
            { label: 'Transfer', href: '/inventory/transfers/new', icon: ArrowLeftRight, show: r.availableSort > 0 },
          ]}
        />
      ),
    } satisfies DataColumn<StockRow>,
  ];

  return (
    <DataTable
      prefsKey="stock"
      data={filtered}
      columns={columns}
      getRowId={(r) => r.id}
      pageSize={50}
      filters={[
        { id: 'warehouse', label: 'Warehouse', value: (r) => r.warehouse },
        { id: 'item', label: 'Coffee', value: (r) => r.itemName },
        { id: 'origin', label: 'Origin', value: (r) => r.origin },
      ]}
      expandedContent={(r) => (
        <div className="overflow-x-auto">
          <p className="mb-2 text-xs text-ink-muted">
            {r.lots.length === 1 ? 'The batch behind this stock' : `The ${r.lots.length} batches behind this stock`}
          </p>
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="py-1.5 pr-3 font-medium">Reference</th>
                <th className="py-1.5 pr-3 font-medium">Batch</th>
                <th className="py-1.5 pr-3 font-medium">Container</th>
                <th className="py-1.5 pr-3 font-medium">Job</th>
                <th className="py-1.5 pr-3 text-right font-medium">On hand</th>
                <th className="py-1.5 pr-3 text-right font-medium">Available</th>
                <th className="py-1.5 text-right font-medium">Bags</th>
              </tr>
            </thead>
            <tbody>
              {r.lots.map((lot, i) => (
                <tr key={`${lot.batchNumber}-${i}`} className="border-b border-line/60 last:border-0">
                  <td className="py-1.5 pr-3 font-mono text-xs">{lot.reference}</td>
                  <td className="py-1.5 pr-3">{lot.batchNumber}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{lot.container}</td>
                  
                  <td className="py-1.5 pr-3 text-right tabular-nums">{lot.onHandLabel}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{lot.availableLabel}</td>
                  <td className="py-1.5 text-right tabular-nums">{lot.bags.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      searchValue={(r) =>
        `${r.itemName} ${r.itemCode} ${r.origin} ${r.warehouse} ${r.lots
          .map((l) => `${l.reference} ${l.batchNumber} ${l.container}`)
          .join(' ')}`
      }
      searchPlaceholder="Search coffee, warehouse, reference, batch or container…"
      exportHref={canExport ? '/api/export/stock-on-hand' : undefined}
      emptyAction={emptyAction}
      emptyTitle="No stock on hand"
      emptyDescription="Receive an approved purchase contract into a warehouse to bring coffee into stock."
      toolbar={
        <div className="flex items-center gap-2">
          <Select
            aria-label="Filter by warehouse"
            value={warehouse}
            onChange={(e) => setWarehouse(e.target.value)}
            className="h-10 w-auto min-w-44"
          >
            <option value="ALL">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
      }
    />
  );
}
