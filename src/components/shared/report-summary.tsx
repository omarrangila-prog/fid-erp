import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The three to five figures a report is actually about, stated once at the top.
 *
 * Every report in the application shows these the same way, so a person who
 * has read one has read them all: the label small and quiet, the figure large
 * and aligned, an optional line underneath saying what it is made of. The
 * last figure is the answer — the net profit, the closing balance, the
 * difference — so it is the one that carries the emphasis.
 *
 * Deliberately small: a wall of a dozen cards is not a summary, it is another
 * table with worse alignment.
 */

export type SummaryFigure = {
  label: string;
  value: string;
  /** What the figure is made of, or the same amount in the other currency. */
  hint?: string;
  /** The answer the report exists to give. Gets the emphasis. */
  lead?: boolean;
  tone?: 'default' | 'positive' | 'negative';
};

export function ReportSummary({
  figures,
  status,
}: {
  figures: SummaryFigure[];
  /** "Balanced", "Attention required" — the one-word verdict, where there is one. */
  status?: { label: string; ok: boolean; detail?: string };
}) {
  const columns = Math.min(figures.length, 5);

  return (
    <div className="space-y-3">
      <div
        className={cn(
          'grid gap-3',
          columns <= 2 && 'sm:grid-cols-2',
          columns === 3 && 'sm:grid-cols-3',
          columns === 4 && 'sm:grid-cols-2 lg:grid-cols-4',
          columns >= 5 && 'sm:grid-cols-2 lg:grid-cols-5',
        )}
      >
        {figures.map((figure) => (
          <div
            key={figure.label}
            className={cn(
              'rounded-xl border bg-surface p-4',
              figure.lead ? 'border-forest-300 bg-forest-50/40' : 'border-line',
            )}
          >
            <p className="text-xs font-medium text-ink-muted">{figure.label}</p>
            <p
              className={cn(
                'mt-1 text-lg font-semibold tabular-nums',
                figure.tone === 'positive' && 'text-gold-700',
                figure.tone === 'negative' && 'text-red-600',
                !figure.tone && (figure.lead ? 'text-forest-800' : 'text-ink'),
              )}
            >
              {figure.value}
            </p>
            {figure.hint ? <p className="mt-0.5 text-[11px] text-ink-subtle">{figure.hint}</p> : null}
          </div>
        ))}
      </div>

      {status ? (
        <div
          className={cn(
            'flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl border px-4 py-3 text-sm',
            status.ok
              ? 'border-forest-300 bg-forest-50/40 text-forest-800'
              : 'border-red-300 bg-red-50/60 text-red-700',
          )}
        >
          <span className="font-semibold">{status.label}</span>
          {status.detail ? <span className="text-xs opacity-80">{status.detail}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A heading row inside a statement — INCOME, EXPENSES — and its subtotal. */
export function StatementSection({
  title,
  children,
  total,
  columns,
}: {
  title: string;
  children: ReactNode;
  total?: ReactNode;
  columns: number;
}) {
  return (
    <>
      <tr className="bg-forest-50/40">
        <td colSpan={columns} className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {title}
        </td>
      </tr>
      {children}
      {total}
    </>
  );
}
