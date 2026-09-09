'use client';

import * as React from 'react';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/lib/constants';
import { downloadCsv, exportFilename } from '@/lib/export-csv';

export type MovementRow = {
  id: string;
  date: string;
  dateSort: number;
  type: string;
  typeLabel: string;
  batchNumber: string;
  batchId: string;
  itemName: string;
  warehouse: string;
  quantityLabel: string;
  quantitySort: number;
  isInflow: boolean;
  reference: string;
  referenceHref: string | null;
  notes: string | null;
  createdBy: string;
};

const TYPE_TONES: Record<string, BadgeTone> = {
  RECEIPT: 'success',
  OPENING: 'neutral',
  SALE: 'info',
  ADJUSTMENT_IN: 'progress',
  ADJUSTMENT_OUT: 'warning',
  TRANSFER_IN: 'info',
  TRANSFER_OUT: 'info',
  RESERVATION: 'neutral',
  RESERVATION_RELEASE: 'neutral',
  REVERSAL: 'danger',
};

/**
 * The stock movement ledger — the append-only record every stock figure in the
 * system is derived from.
 */
export function MovementsClient({
  rows,
  companyCode,
  canExport,
  emptyAction,
}: {
  rows: MovementRow[];
  companyCode: string;
  canExport: boolean;
  /** Rendered inside the empty state; built on the server so permissions are checked there. */
  emptyAction?: React.ReactNode;
}) {
  const [type, setType] = React.useState('ALL');
  const [warehouse, setWarehouse] = React.useState('ALL');

  const warehouses = React.useMemo(() => [...new Set(rows.map((r) => r.warehouse))].sort(), [rows]);

  const filtered = React.useMemo(
    () =>
      rows.filter(
        (r) => (type === 'ALL' || r.type === type) && (warehouse === 'ALL' || r.warehouse === warehouse),
      ),
    [rows, type, warehouse],
  );

  const columns: DataColumn<MovementRow>[] = [
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.dateSort, cell: (r) => r.date },
    {
      id: 'type',
      header: 'Movement',
      mobile: 'badge',
      sortValue: (r) => r.type,
      cell: (r) => <Badge tone={TYPE_TONES[r.type] ?? 'neutral'}>{r.typeLabel}</Badge>,
    },
    {
      id: 'batch',
      header: 'Batch',
      mobile: 'title',
      sortValue: (r) => r.batchNumber,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.batchNumber}</span>
          <span className="block text-xs text-ink-subtle">{r.itemName}</span>
        </span>
      ),
    },
    { id: 'warehouse', header: 'Warehouse', mobile: 'meta', sortValue: (r) => r.warehouse, cell: (r) => r.warehouse },
    {
      id: 'quantity',
      header: 'Quantity',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.quantitySort,
      cell: (r) => (
        <span className={r.isInflow ? 'font-medium text-teal-700' : 'font-medium text-navy-700'}>
          {r.isInflow ? '+' : ''}
          {r.quantityLabel}
        </span>
      ),
    },
    {
      id: 'reference',
      header: 'Reference',
      hideable: true,
      cell: (r) =>
        r.referenceHref ? (
          <Link href={r.referenceHref} className="text-teal-700 hover:underline">
            {r.reference}
          </Link>
        ) : (
          r.reference
        ),
    },
    { id: 'notes', header: 'Notes', hideable: true, defaultHidden: true, cell: (r) => r.notes ?? '—' },
    { id: 'user', header: 'By', hideable: true, cell: (r) => r.createdBy },
  ];

  function exportCsv() {
    downloadCsv(
      exportFilename(companyCode, 'stock-movements'),
      ['Date', 'Movement', 'Batch', 'Coffee', 'Warehouse', 'Quantity KG', 'Reference', 'Notes', 'By'],
      filtered.map((r) => [
        r.date, r.typeLabel, r.batchNumber, r.itemName, r.warehouse, r.quantitySort, r.reference, r.notes, r.createdBy,
      ]),
    );
  }

  return (
    <DataTable
      data={filtered}
      columns={columns}
      getRowId={(r) => r.id}
      pageSize={100}
      searchValue={(r) => `${r.batchNumber} ${r.itemName} ${r.warehouse} ${r.reference} ${r.notes ?? ''}`}
      searchPlaceholder="Search batch, coffee, reference…"
      emptyAction={emptyAction}
      emptyTitle="No stock movements"
      emptyDescription="Movements are written whenever coffee is received, sold, transferred or adjusted."
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={type} onChange={(e) => setType(e.target.value)} className="h-10 w-auto min-w-40">
            <option value="ALL">All movements</option>
            {Object.keys(TYPE_TONES).map((t) => (
              <option key={t} value={t}>
                {t.replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}
              </option>
            ))}
          </Select>
          <Select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} className="h-10 w-auto min-w-40">
            <option value="ALL">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w} value={w}>
                {w}
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
