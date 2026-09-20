'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Star } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The accounting-statement shell every financial report is built on.
 *
 * The client reads QuickBooks reports, so this reproduces that reading
 * experience — not its branding: a centred header (company, REPORT NAME,
 * period), a row of plain controls (period, display columns by, compare),
 * and a statement whose sections open and close, whose figures are
 * right-aligned, whose subtotals are bold, and whose every line opens the
 * transactions behind it.
 *
 * Everything the reader chooses lives in the address, so a report is a link
 * that can be sent to somebody, and the choices they make on a report are
 * remembered per browser so the report opens the way they left it.
 */

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function StatementHeader({
  company,
  title,
  period,
  basis = 'Accrual basis',
  meta,
}: {
  company: string;
  title: string;
  period: string;
  basis?: string;
  meta?: React.ReactNode;
}) {
  return (
    <div className="space-y-1 py-4 text-center">
      <p className="text-sm font-medium text-ink-muted">{company}</p>
      <h2 className="text-xl font-semibold uppercase tracking-wide text-ink">{title}</h2>
      <p className="text-sm text-ink-muted">{period}</p>
      <p className="text-[11px] uppercase tracking-wider text-ink-subtle">{basis}</p>
      {meta}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls: display columns by, compare, favourite
// ---------------------------------------------------------------------------

export type ColumnsBy = 'total' | 'month' | 'quarter' | 'year';
export type CompareWith = 'none' | 'previous' | 'year';

/** Rewrites one search parameter, keeping the rest. */
export function useSearchParamSetter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      router.push(`${pathname}?${next.toString()}`);
    },
    [router, pathname, searchParams],
  );
}

export function StatementControls({
  columnsBy,
  compare,
  showColumnsBy = true,
  showCompare = true,
  showZero,
  children,
}: {
  columnsBy?: ColumnsBy;
  compare?: CompareWith;
  showColumnsBy?: boolean;
  showCompare?: boolean;
  /** Whether zero-balance lines are shown; undefined hides the control. */
  showZero?: boolean;
  children?: React.ReactNode;
}) {
  const set = useSearchParamSetter();
  const control = 'h-10 rounded-lg border border-line-strong bg-surface px-3 text-sm';
  return (
    <div className="flex flex-wrap items-end gap-3 print:hidden">
      {showColumnsBy ? (
        <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
          Display columns by
          <select className={control} value={columnsBy ?? 'total'} onChange={(e) => set({ columns: e.target.value === 'total' ? null : e.target.value })}>
            <option value="total">Total only</option>
            <option value="month">Month</option>
            <option value="quarter">Quarter</option>
            <option value="year">Year</option>
          </select>
        </label>
      ) : null}
      {showCompare ? (
        <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
          Compare
          <select className={control} value={compare ?? 'none'} onChange={(e) => set({ compare: e.target.value === 'none' ? null : e.target.value })}>
            <option value="none">No comparison</option>
            <option value="previous">Previous period</option>
            <option value="year">Previous year</option>
          </select>
        </label>
      ) : null}
      {showZero !== undefined ? (
        <label className="flex h-10 items-center gap-2 text-xs font-medium text-ink-muted">
          <input type="checkbox" className="size-4 accent-gold-600" checked={showZero} onChange={(e) => set({ zero: e.target.checked ? '1' : null })} />
          Show zero-balance accounts
        </label>
      ) : null}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Favourites — per browser, shown at the top of the report centre
// ---------------------------------------------------------------------------

const FAVOURITES_KEY = 'fid.reports.favourites';

function readFavourites(): string[] {
  try {
    const raw = window.localStorage.getItem(FAVOURITES_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
let snapshot: string[] | null = null;
function getSnapshot() {
  if (snapshot === null) snapshot = readFavourites();
  return snapshot;
}
const EMPTY: string[] = [];
function getServerSnapshot() {
  return EMPTY;
}
function writeFavourites(next: string[]) {
  snapshot = next;
  try {
    window.localStorage.setItem(FAVOURITES_KEY, JSON.stringify(next));
  } catch {
    // A private window forgets; the star still works for this visit.
  }
  for (const listener of listeners) listener();
}

export function useFavouriteReports() {
  const favourites = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const toggle = React.useCallback((href: string) => {
    const current = getSnapshot();
    writeFavourites(current.includes(href) ? current.filter((h) => h !== href) : [...current, href]);
  }, []);
  return { favourites, toggle };
}

/** The star on a report's header, and on its card in the report centre. */
export function FavouriteStar({ href, label }: { href: string; label?: string }) {
  const { favourites, toggle } = useFavouriteReports();
  const on = favourites.includes(href);
  return (
    <button
      type="button"
      onClick={() => toggle(href)}
      aria-pressed={on}
      aria-label={on ? `Remove ${label ?? 'this report'} from favourites` : `Add ${label ?? 'this report'} to favourites`}
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-md transition-colors print:hidden',
        on ? 'text-gold-600 hover:bg-gold-50' : 'text-ink-subtle hover:bg-surface-sunken hover:text-ink',
      )}
    >
      <Star className={cn('size-4', on && 'fill-current')} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Statement table: sections that open and close, rows that drill down
// ---------------------------------------------------------------------------

export type StatementCell = { value: string; muted?: boolean; tone?: 'positive' | 'negative' };

export type StatementLine = {
  key: string;
  label: string;
  /** One figure per column; a comparison adds Previous, Change and % columns. */
  cells: StatementCell[];
  href?: string;
  /** Indented under its section, the way account lines sit under a heading. */
  indent?: boolean;
};

export type StatementSectionData = {
  key: string;
  title: string;
  lines: StatementLine[];
  /** The bold row under the section — "TOTAL INCOME". */
  total: { label: string; cells: StatementCell[] };
  /** Opened by default unless the reader closed it last time. */
  defaultOpen?: boolean;
};

const OPEN_KEY = (report: string) => `fid.reports.${report}.open`;

function readOpen(report: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY(report));
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * The statement itself. `columns` are the headings across the top — "Total",
 * or the months, or Current / Previous / Change / %; each line carries one
 * cell per column. Sections collapse to their total row, and the state of
 * each is remembered per browser.
 */
export function Statement({
  report,
  columns,
  sections,
  grandTotals,
}: {
  report: string;
  columns: string[];
  sections: StatementSectionData[];
  /** Rows that sit between or after sections — GROSS PROFIT, NET PROFIT. */
  grandTotals?: Array<{ after: string; label: string; cells: StatementCell[]; emphasis?: 'strong' | 'final' }>;
}) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const hydrated = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  // Remembered state is applied after hydration so the first render agrees
  // with the server's HTML.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- per-browser preference, applied once after mount
    setOpen(readOpen(report));
  }, [report]);

  function toggle(key: string) {
    setOpen((prev) => {
      const next = { ...prev, [key]: !(prev[key] ?? true) };
      try {
        window.localStorage.setItem(OPEN_KEY(report), JSON.stringify(next));
      } catch {
        // Fine: the section still toggles for this visit.
      }
      return next;
    });
  }

  const isOpen = (section: StatementSectionData) =>
    hydrated ? (open[section.key] ?? section.defaultOpen ?? true) : (section.defaultOpen ?? true);

  const cell = (c: StatementCell, extra?: string) => (
    <td
      className={cn(
        'tnum whitespace-nowrap px-3 py-1.5 text-right text-sm',
        c.muted && 'text-ink-muted',
        c.tone === 'negative' && 'text-red-700',
        c.tone === 'positive' && 'text-forest-800',
        extra,
      )}
    >
      {c.value}
    </td>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse">
        <thead>
          <tr className="border-b border-line-strong">
            <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-muted"> </th>
            {columns.map((column) => (
              <th key={column} className="whitespace-nowrap px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => {
            const shown = isOpen(section);
            return (
              <React.Fragment key={section.key}>
                <tr className="border-t border-line">
                  <td colSpan={columns.length + 1} className="px-1 py-2">
                    <button
                      type="button"
                      onClick={() => toggle(section.key)}
                      aria-expanded={shown}
                      className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-ink hover:bg-surface-sunken"
                    >
                      {shown ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      {section.title}
                    </button>
                  </td>
                </tr>
                {shown
                  ? section.lines.length === 0
                    ? (
                        <tr>
                          <td colSpan={columns.length + 1} className="px-8 py-1.5 text-xs text-ink-subtle">
                            Nothing in this period.
                          </td>
                        </tr>
                      )
                    : section.lines.map((line) => (
                        <tr key={line.key} className="hover:bg-surface-sunken/40">
                          <td className={cn('px-3 py-1.5 text-sm', line.indent !== false && 'pl-8')}>
                            {line.href ? (
                              <Link href={line.href} className="text-ink hover:text-gold-700 hover:underline">
                                {line.label}
                              </Link>
                            ) : (
                              line.label
                            )}
                          </td>
                          {line.cells.map((c, i) => (
                            <React.Fragment key={i}>{cell(c)}</React.Fragment>
                          ))}
                        </tr>
                      ))
                  : null}
                <tr className="border-t border-line bg-surface-sunken/40">
                  <td className="px-3 py-2 text-sm font-semibold uppercase tracking-wide">{section.total.label}</td>
                  {section.total.cells.map((c, i) => (
                    <React.Fragment key={i}>{cell(c, 'font-semibold')}</React.Fragment>
                  ))}
                </tr>
                {grandTotals
                  ?.filter((g) => g.after === section.key)
                  .map((g) => (
                    <tr
                      key={g.label}
                      className={cn(
                        'border-t border-line-strong',
                        g.emphasis === 'final' && 'border-b-2 border-b-forest-700 bg-forest-50/60',
                      )}
                    >
                      <td className="px-3 py-2.5 text-sm font-bold uppercase tracking-wide">{g.label}</td>
                      {g.cells.map((c, i) => (
                        <React.Fragment key={i}>{cell(c, 'font-bold')}</React.Fragment>
                      ))}
                    </tr>
                  ))}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
