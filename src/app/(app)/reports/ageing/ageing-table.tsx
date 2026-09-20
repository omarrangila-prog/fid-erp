'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export type AgeingRowView = {
  key: string;
  partyName: string;
  currency: string;
  ledgerHref: string;
  buckets: string[];
  total: string;
  lines: Array<{
    key: string;
    document: string;
    href: string;
    date: string;
    due: string;
    daysOverdue: number;
    original: string;
    paid: string;
    outstanding: string;
    bucket: string;
  }>;
};

/**
 * The standard ageing layout: party down the side, buckets across, totals
 * on the right and at the bottom. A row opens into its documents — date,
 * due date, days overdue, original, paid, outstanding, bucket — so the
 * summary and the detail are the same report at two depths.
 */
export function AgeingTable({
  rows,
  bucketLabels,
  totals,
  partyLabel,
  documentLabel,
}: {
  rows: AgeingRowView[];
  bucketLabels: string[];
  /** Per currency, so dirhams and dollars are never added together. */
  totals: Array<{ currency: string; buckets: string[]; total: string }>;
  partyLabel: string;
  documentLabel: string;
}) {
  const [open, setOpen] = React.useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const columns = bucketLabels.length + 3;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-strong text-[11px] uppercase tracking-wider text-ink-muted">
            <th className="px-3 py-2 text-left font-semibold">{partyLabel}</th>
            {bucketLabels.map((label) => (
              <th key={label} className="whitespace-nowrap px-3 py-2 text-right font-semibold">
                {label}
              </th>
            ))}
            <th className="px-3 py-2 text-right font-semibold">Total</th>
            <th className="w-8 px-1 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const shown = open.has(row.key);
            return (
              <React.Fragment key={row.key}>
                <tr className="border-t border-line hover:bg-surface-sunken/40">
                  <td className="px-3 py-2">
                    <Link href={row.ledgerHref} className="font-medium text-ink hover:text-gold-700 hover:underline">
                      {row.partyName}
                    </Link>
                    <span className="ml-2 text-xs text-ink-subtle">{row.currency}</span>
                  </td>
                  {row.buckets.map((value, i) => (
                    <td key={i} className={cn('tnum px-3 py-2 text-right', value === '—' && 'text-ink-subtle')}>
                      {value}
                    </td>
                  ))}
                  <td className="tnum px-3 py-2 text-right font-semibold">{row.total}</td>
                  <td className="px-1 py-2">
                    <button
                      type="button"
                      onClick={() => toggle(row.key)}
                      aria-expanded={shown}
                      aria-label={shown ? `Hide ${row.partyName}'s documents` : `Show ${row.partyName}'s documents`}
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
                            <th className="py-1 pr-3 font-medium">{documentLabel}</th>
                            <th className="py-1 pr-3 font-medium">Date</th>
                            <th className="py-1 pr-3 font-medium">Due</th>
                            <th className="py-1 pr-3 text-right font-medium">Days overdue</th>
                            <th className="py-1 pr-3 text-right font-medium">Original</th>
                            <th className="py-1 pr-3 text-right font-medium">Paid</th>
                            <th className="py-1 pr-3 text-right font-medium">Outstanding</th>
                            <th className="py-1 font-medium">Bucket</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.lines.map((line) => (
                            <tr key={line.key} className="border-t border-line/60">
                              <td className="py-1 pr-3">
                                <Link href={line.href} className="text-forest-800 hover:text-gold-700 hover:underline">
                                  {line.document}
                                </Link>
                              </td>
                              <td className="py-1 pr-3">{line.date}</td>
                              <td className="py-1 pr-3">{line.due}</td>
                              <td className={cn('tnum py-1 pr-3 text-right', line.daysOverdue > 0 && 'text-red-700')}>
                                {line.daysOverdue > 0 ? line.daysOverdue : '—'}
                              </td>
                              <td className="tnum py-1 pr-3 text-right">{line.original}</td>
                              <td className="tnum py-1 pr-3 text-right">{line.paid}</td>
                              <td className="tnum py-1 pr-3 text-right font-medium">{line.outstanding}</td>
                              <td className="py-1">{line.bucket}</td>
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
          {totals.map((total) => (
            <tr key={total.currency} className="border-t-2 border-line-strong bg-surface-sunken/40 font-semibold">
              <td className="px-3 py-2">Total {total.currency}</td>
              {total.buckets.map((value, i) => (
                <td key={i} className="tnum px-3 py-2 text-right">
                  {value}
                </td>
              ))}
              <td className="tnum px-3 py-2 text-right">{total.total}</td>
              <td />
            </tr>
          ))}
        </tfoot>
      </table>
    </div>
  );
}
