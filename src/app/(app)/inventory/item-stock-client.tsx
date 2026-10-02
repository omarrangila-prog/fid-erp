'use client';

import * as React from 'react';
import Link from 'next/link';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { DualText } from '@/components/shared/dual-text';
import { RowActions } from '@/components/shared/row-actions';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { STOCK_STATUS_META as STATUS_META, type PairText } from '@/components/inventory/item-profit-format';
import { Eye, Layers, History, ShoppingCart, ArrowLeftRight } from 'lucide-react';

export type ItemStockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'SOLD_OUT';

export type ItemStockRow = {
  id: string;
  href: string;
  itemName: string;
  itemCode: string;
  origin: string;
  status: ItemStockStatus;
  receivedLabel: string;
  soldLabel: string;
  availableLabel: string;
  /** Held for drafts, when any — the difference between on hand and available. */
  reservedLabel: string | null;
  receivedSort: number;
  soldSort: number;
  availableSort: number;
  warehouseNames: string;
  warehouses: Array<{
    name: string;
    receivedLabel: string;
    transferInLabel: string;
    transferOutLabel: string;
    soldLabel: string;
    availableLabel: string;
  }>;
  warehouseTotal: { receivedLabel: string; transferInLabel: string; transferOutLabel: string; soldLabel: string; availableLabel: string };
  /** Null when this person may not see purchase costs. */
  avgCost: PairText | null;
  cogs: PairText | null;
  stockValue: PairText | null;
  /** Null when this person may not see sales. */
  avgSell: PairText | null;
  revenue: PairText | null;
  collected: PairText | null;
  outstanding: PairText | null;
  /** Needs both. */
  profit: (PairText & { loss: boolean }) | null;
  profitPerKg: PairText | null;
  margin: string | null;
  sort: { avgCost: number; avgSell: number; revenue: number; collected: number; outstanding: number; cogs: number; profit: number; margin: number; stockValue: number };
};


const money = (text: PairText | null) => (text ? <DualText primary={text.primary} equivalent={text.equivalent} /> : <span className="text-ink-subtle">—</span>);

/**
 * Stock on Hand, one row per coffee: how much came in, how much sold, what is
 * left and where, what it cost, what it sold for, what has been collected and
 * whether it made money. Every figure is read by the server from the shared
 * item service; this only lays it out.
 */
export function ItemStockClient({
  rows,
  showCost,
  showProfit,
  showSales,
  canExport,
  canSell,
  canTransfer,
  period,
  filters,
}: {
  rows: ItemStockRow[];
  showCost: boolean;
  /** Cost of goods sold, profit and margin: "View profit" on top of cost. */
  showProfit: boolean;
  showSales: boolean;
  canExport: boolean;
  canSell: boolean;
  canTransfer: boolean;
  period?: string;
  filters?: string[];
}) {
  const columns: DataColumn<ItemStockRow>[] = [
    {
      id: 'item',
      header: 'Item',
      mobile: 'title',
      pin: 'left',
      sortValue: (r) => r.itemName,
      exportValue: (r) => r.itemName,
      cell: (r) => (
        <span className="block min-w-44">
          <Link href={r.href} className="font-medium text-forest-800 underline-offset-2 hover:underline" data-testid="item-link">
            {r.itemName}
          </Link>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-subtle">
            {r.origin}
            <Badge tone={STATUS_META[r.status].tone} data-testid="item-status">
              {STATUS_META[r.status].label}
            </Badge>
          </span>
        </span>
      ),
    },
    {
      id: 'received',
      header: 'Received KG',
      numeric: true,
      hideable: true,
      mobile: 'hidden',
      sortValue: (r) => r.receivedSort,
      exportValue: (r) => r.receivedSort,
      exportType: 'quantity',
      cell: (r) => r.receivedLabel,
    },
    {
      id: 'sold',
      header: 'Sold KG',
      numeric: true,
      hideable: true,
      mobile: 'meta',
      sortValue: (r) => r.soldSort,
      exportValue: (r) => r.soldSort,
      exportType: 'quantity',
      cell: (r) => r.soldLabel,
    },
    {
      id: 'available',
      header: 'Available KG',
      numeric: true,
      hideable: true,
      mobile: 'meta',
      sortValue: (r) => r.availableSort,
      exportValue: (r) => r.availableSort,
      exportType: 'quantity',
      cell: (r) => (
        <span>
          <span className="block font-semibold">{r.availableLabel}</span>
          {r.reservedLabel ? <span className="block text-[11px] text-ink-subtle">{r.reservedLabel} held for drafts</span> : null}
        </span>
      ),
    },
    {
      id: 'warehouses',
      header: 'Warehouses',
      hideable: true,
      mobile: 'hidden',
      sortValue: (r) => r.warehouseNames,
      exportValue: (r) => r.warehouses.map((w) => `${w.name}: ${w.availableLabel}`).join('; '),
      cell: (r) =>
        r.warehouses.length === 0 ? (
          <span className="text-ink-subtle">—</span>
        ) : (
          <span className="block min-w-48 text-xs">
            {r.warehouses.map((w) => (
              <span key={w.name} className="flex justify-between gap-3">
                <span className="truncate">{w.name}</span>
                <span className="tnum font-medium">{w.availableLabel}</span>
              </span>
            ))}
          </span>
        ),
    },
    ...(showCost
      ? ([
          {
            id: 'avgCost',
            header: 'Avg Cost/KG',
            numeric: true,
            hideable: true,
            mobile: 'meta',
            sortValue: (r) => r.sort.avgCost,
            exportValue: (r) => r.sort.avgCost,
            cell: (r) => money(r.avgCost),
          },
        ] satisfies DataColumn<ItemStockRow>[])
      : []),
    ...(showSales
      ? ([
          {
            id: 'avgSell',
            header: 'Avg Sell/KG',
            numeric: true,
            hideable: true,
            mobile: 'meta',
            sortValue: (r) => r.sort.avgSell,
            exportValue: (r) => r.sort.avgSell,
            cell: (r) => money(r.avgSell),
          },
          {
            id: 'revenue',
            header: 'Sales Revenue',
            numeric: true,
            hideable: true,
            mobile: 'hidden',
            sortValue: (r) => r.sort.revenue,
            exportValue: (r) => r.sort.revenue,
            exportType: 'money',
            cell: (r) => money(r.revenue),
          },
          {
            id: 'collected',
            header: 'Collected',
            numeric: true,
            hideable: true,
            mobile: 'hidden',
            sortValue: (r) => r.sort.collected,
            exportValue: (r) => r.sort.collected,
            exportType: 'money',
            cell: (r) => money(r.collected),
          },
          {
            id: 'outstanding',
            header: 'Outstanding',
            numeric: true,
            hideable: true,
            mobile: 'hidden',
            sortValue: (r) => r.sort.outstanding,
            exportValue: (r) => r.sort.outstanding,
            exportType: 'money',
            cell: (r) => money(r.outstanding),
          },
        ] satisfies DataColumn<ItemStockRow>[])
      : []),
    ...(showCost && showProfit
      ? ([
          {
            id: 'cogs',
            header: 'COGS',
            numeric: true,
            hideable: true,
            mobile: 'hidden',
            sortValue: (r) => r.sort.cogs,
            exportValue: (r) => r.sort.cogs,
            exportType: 'money',
            cell: (r) => money(r.cogs),
          },
        ] satisfies DataColumn<ItemStockRow>[])
      : []),
    ...(showCost && showProfit && showSales
      ? ([
          {
            id: 'profit',
            header: 'Gross Profit / Loss',
            numeric: true,
            hideable: true,
            mobile: 'meta',
            sortValue: (r) => r.sort.profit,
            exportValue: (r) => r.sort.profit,
            exportType: 'money',
            cell: (r) =>
              r.profit ? (
                <span className={cn(r.profit.loss ? 'text-red-700' : 'text-emerald-800')} data-testid="item-profit">
                  <DualText primary={r.profit.primary} equivalent={r.profit.equivalent} />
                </span>
              ) : (
                <span className="text-ink-subtle">—</span>
              ),
          },
          {
            id: 'margin',
            header: 'Margin',
            numeric: true,
            hideable: true,
            mobile: 'hidden',
            sortValue: (r) => r.sort.margin,
            exportValue: (r) => r.margin ?? '',
            cell: (r) => r.margin ?? <span className="text-ink-subtle">—</span>,
          },
          {
            id: 'profitPerKg',
            header: 'Profit/KG',
            numeric: true,
            hideable: true,
            defaultHidden: true,
            mobile: 'hidden',
            exportValue: (r) => r.profitPerKg?.primary ?? '',
            cell: (r) => money(r.profitPerKg),
          },
        ] satisfies DataColumn<ItemStockRow>[])
      : []),
    ...(showCost
      ? ([
          {
            id: 'stockValue',
            header: 'Stock Value',
            numeric: true,
            hideable: true,
            mobile: 'hidden',
            sortValue: (r) => r.sort.stockValue,
            exportValue: (r) => r.sort.stockValue,
            exportType: 'money',
            cell: (r) => money(r.stockValue),
          },
        ] satisfies DataColumn<ItemStockRow>[])
      : []),
    {
      id: 'actions',
      header: 'Actions',
      mobile: 'action',
      pin: 'right',
      printHidden: true,
      cell: (r) => (
        <RowActions
          actions={[
            { label: 'Open item', href: r.href, icon: Eye },
            { label: 'Batches', href: `/inventory/batches?q=${encodeURIComponent(r.itemName)}`, icon: Layers },
            { label: 'Movements', href: `/inventory/movements?q=${encodeURIComponent(r.itemName)}`, icon: History },
            { label: 'Sell', href: '/sales/new', icon: ShoppingCart, show: canSell && r.availableSort > 0 },
            { label: 'Transfer', href: '/inventory/transfers/new', icon: ArrowLeftRight, show: canTransfer && r.availableSort > 0 },
          ]}
        />
      ),
    },
  ];

  const sortOptions = [
    { label: 'Highest stock', columnId: 'available', direction: 'desc' as const },
    { label: 'Lowest stock', columnId: 'available', direction: 'asc' as const },
    ...(showSales
      ? [
          { label: 'Highest sales', columnId: 'revenue', direction: 'desc' as const },
          { label: 'Highest outstanding', columnId: 'outstanding', direction: 'desc' as const },
        ]
      : []),
    ...(showSales && showCost && showProfit
      ? [
          { label: 'Highest profit', columnId: 'profit', direction: 'desc' as const },
          { label: 'Highest loss', columnId: 'profit', direction: 'asc' as const },
        ]
      : []),
  ];

  return (
    <div data-testid="item-stock-table">
      <DataTable
        share={{ report: 'stock-on-hand', title: 'Stock on Hand', subject: 'By item', period, filters }}
        prefsKey="stock-items"
        columnsLabel="Customize Report"
        sortOptions={sortOptions}
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        pageSize={50}
        filters={[
          { id: 'item', label: 'Item', value: (r) => r.itemName },
          { id: 'status', label: 'Stock status', value: (r) => STATUS_META[r.status].label },
        ]}
        expandedContent={(r) => (
          <div className="overflow-x-auto">
            <p className="mb-2 text-xs text-ink-muted">Where {r.itemName} is — the warehouses add up to the company total.</p>
            <table className="data-grid grid-framed w-full min-w-[40rem] text-sm" data-testid="item-warehouse-split">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th className="py-1.5 pr-3 font-medium">Warehouse</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Received</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Transferred in</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Transferred out</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Sold</th>
                  <th className="py-1.5 text-right font-medium">Available</th>
                </tr>
              </thead>
              <tbody>
                {r.warehouses.map((w) => (
                  <tr key={w.name} className="border-b border-line/60">
                    <td className="py-1.5 pr-3">{w.name}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{w.receivedLabel}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{w.transferInLabel}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{w.transferOutLabel}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{w.soldLabel}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums">{w.availableLabel}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-1.5 pr-3">Total</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{r.warehouseTotal.receivedLabel}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{r.warehouseTotal.transferInLabel}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{r.warehouseTotal.transferOutLabel}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{r.warehouseTotal.soldLabel}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.warehouseTotal.availableLabel}</td>
                </tr>
              </tbody>
            </table>
            <Link href={r.href} className="mt-2 inline-block text-sm font-medium text-forest-800 underline-offset-2 hover:underline">
              Open {r.itemName} — shipments, containers, batches and invoices
            </Link>
          </div>
        )}
        searchValue={(r) => `${r.itemName} ${r.itemCode} ${r.origin} ${r.warehouseNames}`}
        searchPlaceholder="Search item, origin or warehouse…"
        exportFileName={canExport ? 'stock-on-hand-by-item' : undefined}
        exportTitle="Stock on Hand — by item"
        emptyTitle="No stock or sales yet"
        emptyDescription="Receive a purchase into a warehouse, or change the filters above."
      />
    </div>
  );
}
