'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { downloadCsv, exportFilename } from '@/lib/export-csv';

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
  valueSort: number;
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
  companyCode,
  showValue,
  canExport,
  emptyAction,
}: {
  rows: StockRow[];
  warehouses: Array<{ id: string; name: string }>;
  companyCode: string;
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
            {r.itemCode} · {r.origin}
          </span>
        </span>
      ),
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
            id: 'value',
            header: 'Stock value',
            numeric: true,
            mobile: 'meta',
            sortValue: (r: StockRow) => r.valueSort,
            cell: (r: StockRow) => r.valueLabel,
          } satisfies DataColumn<StockRow>,
        ]
      : []),
  ];

  function exportCsv() {
    downloadCsv(
      exportFilename(companyCode, 'stock'),
      ['Coffee', 'Code', 'Origin', 'Warehouse', 'On hand KG', 'Reserved KG', 'Available KG', 'Bags', 'Value USD'],
      filtered.map((r) => [
        r.itemName, r.itemCode, r.origin, r.warehouse,
        r.onHandSort, r.reservedLabel, r.availableSort, r.bags, showValue ? r.valueSort : '',
      ]),
    );
  }

  return (
    <DataTable
      data={filtered}
      columns={columns}
      getRowId={(r) => r.id}
      pageSize={50}
      searchValue={(r) => `${r.itemName} ${r.itemCode} ${r.origin} ${r.warehouse}`}
      searchPlaceholder="Search coffee or warehouse…"
      emptyAction={emptyAction}
      emptyTitle="No stock on hand"
      emptyDescription="Receive an approved purchase contract into a warehouse to bring coffee into stock."
      toolbar={
        <div className="flex items-center gap-2">
          <Select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} className="h-10 w-auto min-w-44">
            <option value="ALL">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          {canExport ? (
            <Button variant="outline" onClick={exportCsv}>
              <Download />
              <span className="hidden sm:inline">Export</span>
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
