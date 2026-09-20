'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SalesByRowView = {
  key: string;
  label: string;
  href: string | null;
  invoices: number;
  quantity: string;
  revenue: string;
  cost: string;
  gross: string;
  margin: string;
  negative: boolean;
  detail: Array<{
    key: string;
    invoice: string;
    href: string;
    date: string;
    customer: string;
    item: string;
    warehouse: string;
    batch: string;
    shipment: string;
    quantity: string;
    price: string;
    revenue: string;
    cost: string;
  }>;
};

/** Summary rows that open into the invoice lines behind them. */
export function SalesByRows({ rows, showCost, totals }: { rows: SalesByRowView[]; showCost: boolean; totals: { quantity: string; revenue: string; cost: string; gross: string; margin: string } }) {
  const [open, setOpen] = React.useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const columns = showCost ? 8 : 5;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-strong text-[11px] uppercase tracking-wider text-ink-muted">
            <th className="px-3 py-2 text-left font-semibold">Name</th>
            <th className="px-3 py-2 text-right font-semibold">Invoices</th>
            <th className="px-3 py-2 text-right font-semibold">Qty sold</th>
            <th className="px-3 py-2 text-right font-semibold">Sales</th>
            {showCost ? (
              <>
                <th className="px-3 py-2 text-right font-semibold">COGS</th>
                <th className="px-3 py-2 text-right font-semibold">Gross profit</th>
                <th className="px-3 py-2 text-right font-semibold">Margin</th>
              </>
            ) : null}
            <th className="w-8 px-1 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const shown = open.has(row.key);
            return (
              <React.Fragment key={row.key}>
                <tr className="border-t border-line hover:bg-surface-sunken/40">
                  <td className="px-3 py-2 font-medium">
                    {row.href ? (
                      <Link href={row.href} className="text-ink hover:text-gold-700 hover:underline">
                        {row.label}
                      </Link>
                    ) : (
                      row.label
                    )}
                  </td>
                  <td className="tnum px-3 py-2 text-right text-ink-muted">{row.invoices}</td>
                  <td className="tnum px-3 py-2 text-right">{row.quantity}</td>
                  <td className="tnum px-3 py-2 text-right font-semibold">{row.revenue}</td>
                  {showCost ? (
                    <>
                      <td className="tnum px-3 py-2 text-right">{row.cost}</td>
                      <td className={cn('tnum px-3 py-2 text-right font-semibold', row.negative && 'text-red-700')}>{row.gross}</td>
                      <td className="tnum px-3 py-2 text-right text-ink-muted">{row.margin}</td>
                    </>
                  ) : null}
                  <td className="px-1 py-2">
                    <button
                      type="button"
                      onClick={() => toggle(row.key)}
                      aria-expanded={shown}
                      aria-label={shown ? `Hide ${row.label} detail` : `Show ${row.label} detail`}
                      className="inline-flex size-6 items-center justify-center rounded text-ink-muted hover:bg-surface-sunken hover:text-ink"
                    >
                      {shown ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </button>
                  </td>
                </tr>
                {shown ? (
                  <tr>
                    <td colSpan={columns} className="bg-surface-sunken/40 px-3 py-2">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left uppercase tracking-wider text-ink-muted">
                            <th className="py-1 pr-3 font-medium">Invoice</th>
                            <th className="py-1 pr-3 font-medium">Date</th>
                            <th className="py-1 pr-3 font-medium">Customer</th>
                            <th className="py-1 pr-3 font-medium">Item</th>
                            <th className="py-1 pr-3 font-medium">Warehouse</th>
                            <th className="py-1 pr-3 font-medium">Batch</th>
                            <th className="py-1 pr-3 font-medium">Shipment</th>
                            <th className="py-1 pr-3 text-right font-medium">Qty</th>
                            <th className="py-1 pr-3 text-right font-medium">Price</th>
                            <th className="py-1 pr-3 text-right font-medium">Sales</th>
                            {showCost ? <th className="py-1 text-right font-medium">COGS</th> : null}
                          </tr>
                        </thead>
                        <tbody>
                          {row.detail.map((d) => (
                            <tr key={d.key} className="border-t border-line/60">
                              <td className="py-1 pr-3">
                                <Link href={d.href} className="text-forest-800 hover:text-gold-700 hover:underline">
                                  {d.invoice}
                                </Link>
                              </td>
                              <td className="py-1 pr-3">{d.date}</td>
                              <td className="py-1 pr-3">{d.customer}</td>
                              <td className="py-1 pr-3">{d.item}</td>
                              <td className="py-1 pr-3">{d.warehouse}</td>
                              <td className="py-1 pr-3">{d.batch}</td>
                              <td className="py-1 pr-3 font-mono">{d.shipment}</td>
                              <td className="tnum py-1 pr-3 text-right">{d.quantity}</td>
                              <td className="tnum py-1 pr-3 text-right">{d.price}</td>
                              <td className="tnum py-1 pr-3 text-right">{d.revenue}</td>
                              {showCost ? <td className="tnum py-1 text-right">{d.cost}</td> : null}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line-strong bg-surface-sunken/40 font-semibold">
            <td className="px-3 py-2" colSpan={2}>
              Total
            </td>
            <td className="tnum px-3 py-2 text-right">{totals.quantity}</td>
            <td className="tnum px-3 py-2 text-right">{totals.revenue}</td>
            {showCost ? (
              <>
                <td className="tnum px-3 py-2 text-right">{totals.cost}</td>
                <td className="tnum px-3 py-2 text-right">{totals.gross}</td>
                <td className="tnum px-3 py-2 text-right text-ink-muted">{totals.margin}</td>
              </>
            ) : null}
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
