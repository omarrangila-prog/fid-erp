'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpDown, Download } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/feedback';
import { downloadCsv, exportFilename } from '@/lib/export-csv';

export type Slice = {
  key: string;
  label: string;
  sublabel: string | null;
  quantityKg: number;
  revenueUsd: number;
  cogsUsd: number;
  grossProfitUsd: number;
  marginPct: number;
  profitPerKgUsd: number;
};

export type Dimension = { id: string; label: string; description: string; rows: Slice[] };

type Measure = 'revenueUsd' | 'grossProfitUsd' | 'quantityKg' | 'marginPct';

const MEASURES: Array<{ id: Measure; label: string; unit: string }> = [
  { id: 'revenueUsd', label: 'Revenue', unit: 'USD' },
  { id: 'grossProfitUsd', label: 'Gross profit', unit: 'USD' },
  { id: 'quantityKg', label: 'Quantity sold', unit: 'KG' },
  { id: 'marginPct', label: 'Margin', unit: '%' },
];

const FOREST = '#274f3f';
const GOLD = '#b47d20';
const RED = '#dc2626';

function money(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toFixed(0);
}

function format(value: number, measure: Measure): string {
  if (measure === 'marginPct') return `${value.toFixed(1)}%`;
  if (measure === 'quantityKg') return `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} KG`;
  return `USD ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The analysis sheet.
 *
 * One question — where is the money coming from — asked along whichever axis
 * matters today: customer, coffee, batch, container or shipment. Pivoting is a
 * click rather than a different report, because the underlying figures are the
 * same and only the grouping changes.
 *
 * Everything here is computed from posted transactions on the server. Sorting
 * and pivoting happen in the browser because the row counts are small; nothing
 * is recalculated client-side, so a figure cannot disagree with its report.
 */
export function AnalyticsClient({
  dimensions,
  companyCode,
  currencyNote,
}: {
  dimensions: Dimension[];
  companyCode: string;
  currencyNote: string;
}) {
  const [dimensionId, setDimensionId] = React.useState(dimensions[0]?.id ?? '');
  const [measure, setMeasure] = React.useState<Measure>('revenueUsd');
  const [sortDesc, setSortDesc] = React.useState(true);

  const dimension = dimensions.find((d) => d.id === dimensionId) ?? dimensions[0];
  const measureMeta = MEASURES.find((m) => m.id === measure)!;

  const rows = React.useMemo(() => {
    if (!dimension) return [];
    return [...dimension.rows].sort((a, b) =>
      sortDesc ? b[measure] - a[measure] : a[measure] - b[measure],
    );
  }, [dimension, measure, sortDesc]);

  const chartData = rows.slice(0, 10).map((row) => ({
    label: row.label.length > 22 ? `${row.label.slice(0, 21)}…` : row.label,
    value: row[measure],
  }));

  const totals = rows.reduce(
    (acc, row) => ({
      quantityKg: acc.quantityKg + row.quantityKg,
      revenueUsd: acc.revenueUsd + row.revenueUsd,
      cogsUsd: acc.cogsUsd + row.cogsUsd,
      grossProfitUsd: acc.grossProfitUsd + row.grossProfitUsd,
    }),
    { quantityKg: 0, revenueUsd: 0, cogsUsd: 0, grossProfitUsd: 0 },
  );
  const totalMargin = totals.revenueUsd > 0 ? (totals.grossProfitUsd / totals.revenueUsd) * 100 : 0;

  function exportRows() {
    downloadCsv(
      exportFilename(companyCode, `analysis-by-${dimension.id}`),
      [dimension.label, 'Detail', 'Quantity KG', 'Revenue USD', 'Cost USD', 'Gross profit USD', 'Margin %', 'Profit per KG USD'],
      rows.map((row) => [
        row.label,
        row.sublabel ?? '',
        row.quantityKg.toFixed(3),
        row.revenueUsd.toFixed(2),
        row.cogsUsd.toFixed(2),
        row.grossProfitUsd.toFixed(2),
        row.marginPct.toFixed(2),
        row.profitPerKgUsd.toFixed(4),
      ]),
    );
  }

  return (
    <div className="space-y-4">
      {/* --- Controls ---------------------------------------------------- */}
      <Card data-print="hide">
        <CardContent className="flex flex-col gap-4 pt-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
                Break down by
              </p>
              <div className="flex flex-wrap gap-1.5">
                {dimensions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setDimensionId(option.id)}
                    aria-pressed={option.id === dimensionId}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors [@media(pointer:coarse)]:min-h-11',
                      option.id === dimensionId
                        ? 'border-forest-700 bg-forest-800 text-white'
                        : 'border-line-strong bg-surface text-ink-muted hover:border-forest-300 hover:text-ink',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">Measure</p>
              <div className="flex flex-wrap gap-1.5">
                {MEASURES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setMeasure(option.id)}
                    aria-pressed={option.id === measure}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors [@media(pointer:coarse)]:min-h-11',
                      option.id === measure
                        ? 'border-gold-600 bg-gold-50 text-gold-800'
                        : 'border-line-strong bg-surface text-ink-muted hover:border-forest-300 hover:text-ink',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setSortDesc((current) => !current)}>
              <ArrowUpDown />
              {sortDesc ? 'Highest first' : 'Lowest first'}
            </Button>
            <Button variant="outline" size="sm" onClick={exportRows} disabled={rows.length === 0}>
              <Download />
              CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* --- Totals ------------------------------------------------------ */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Revenue', value: `USD ${money(totals.revenueUsd)}` },
          { label: 'Cost of sales', value: `USD ${money(totals.cogsUsd)}` },
          { label: 'Gross profit', value: `USD ${money(totals.grossProfitUsd)}` },
          { label: 'Margin', value: `${totalMargin.toFixed(1)}%` },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <p className="text-xs text-ink-muted">{item.label}</p>
            <p className="tnum mt-1 text-lg font-semibold tracking-tight text-ink">{item.value}</p>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={`Nothing to analyse by ${dimension.label.toLowerCase()} yet`}
          description="Post a sale and the analysis fills itself in. Every figure here comes from posted invoices."
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                {measureMeta.label} by {dimension.label.toLowerCase()}
              </CardTitle>
              <CardDescription>
                {dimension.description} Top {Math.min(10, rows.length)} shown. {currencyNote}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={Math.max(220, chartData.length * 38)}>
                <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
                  <CartesianGrid stroke="#e8e4dc" strokeDasharray="3 3" horizontal={false} />
                  <XAxis
                    type="number"
                    stroke="#8a8478"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value: number) => (measure === 'marginPct' ? `${value}%` : money(value))}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    stroke="#8a8478"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={150}
                  />
                  <Tooltip
                    cursor={{ fill: 'rgba(39,79,63,0.06)' }}
                    contentStyle={{
                      borderRadius: '0.6rem',
                      border: '1px solid #e8e4dc',
                      fontSize: 12,
                      boxShadow: '0 8px 24px rgba(34,32,28,0.10)',
                    }}
                    formatter={((value: unknown) => [
                      format(Number(Array.isArray(value) ? value[0] : (value ?? 0)), measure),
                      measureMeta.label,
                    ]) as never}
                  />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={26}>
                    {chartData.map((entry, index) => (
                      <Cell
                        key={index}
                        fill={entry.value < 0 ? RED : measure === 'marginPct' ? GOLD : FOREST}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Every {dimension.label.toLowerCase()}</CardTitle>
              <CardDescription>Sorted by {measureMeta.label.toLowerCase()}.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="w-full overflow-x-auto">
                <table className="w-full min-w-[44rem] text-left text-xs">
                  <thead className="sticky-head">
                    <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-subtle">
                      <th className="pb-2 pr-3 font-semibold">{dimension.label}</th>
                      <th className="pb-2 px-3 text-right font-semibold">Quantity</th>
                      <th className="pb-2 px-3 text-right font-semibold">Revenue</th>
                      <th className="pb-2 px-3 text-right font-semibold">Cost</th>
                      <th className="pb-2 px-3 text-right font-semibold">Gross profit</th>
                      <th className="pb-2 px-3 text-right font-semibold">Margin</th>
                      <th className="pb-2 pl-3 text-right font-semibold">Per KG</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((row) => (
                      <tr key={row.key} className="transition-colors hover:bg-forest-50/50">
                        <td className="py-2.5 pr-3">
                          <span className="block font-medium text-ink">{row.label}</span>
                          {row.sublabel ? (
                            <span className="block text-[11px] text-ink-subtle">{row.sublabel}</span>
                          ) : null}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right text-ink">
                          {row.quantityKg.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right text-ink">{row.revenueUsd.toFixed(2)}</td>
                        <td className="tnum px-3 py-2.5 text-right text-ink-muted">{row.cogsUsd.toFixed(2)}</td>
                        <td
                          className={cn(
                            'tnum px-3 py-2.5 text-right font-medium',
                            row.grossProfitUsd < 0 ? 'text-red-600' : 'text-emerald-700',
                          )}
                        >
                          {row.grossProfitUsd.toFixed(2)}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right text-ink">{row.marginPct.toFixed(1)}%</td>
                        <td className="tnum pl-3 py-2.5 text-right text-ink">{row.profitPerKgUsd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-line-strong font-semibold text-ink">
                      <td className="pt-2.5 pr-3">Total</td>
                      <td className="tnum px-3 pt-2.5 text-right">
                        {totals.quantityKg.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                      </td>
                      <td className="tnum px-3 pt-2.5 text-right">{totals.revenueUsd.toFixed(2)}</td>
                      <td className="tnum px-3 pt-2.5 text-right">{totals.cogsUsd.toFixed(2)}</td>
                      <td className="tnum px-3 pt-2.5 text-right">{totals.grossProfitUsd.toFixed(2)}</td>
                      <td className="tnum px-3 pt-2.5 text-right">{totalMargin.toFixed(1)}%</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <p className="text-center text-[11px] text-ink-subtle" data-print="hide">
        Figures come from posted sales invoices and their batch costs.{' '}
        <Link href="/reports/reconciliation" className="font-medium text-forest-700 hover:underline">
          Reconciliation
        </Link>{' '}
        checks them against the ledger.
      </p>
    </div>
  );
}
