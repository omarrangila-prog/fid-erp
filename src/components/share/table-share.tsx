'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { ShareDialog, WhatsAppIcon, type ShareChoice, type ShareSpec } from '@/components/share/share-dialog';
import { textOf } from '@/lib/share/dom';
import type { ShareReportKey, ShareSection } from '@/lib/share/model';

/**
 * Sharing for the list screens (DataTable): invoices, expenses, stock,
 * receipts and the rest.
 *
 * A list shows one page at a time, but "the current filtered list" means
 * every row the search and filters let through. Those rows are drawn once,
 * out of sight, with the table's own cell renderers, and read back as text —
 * so a shared amount is the amount the list shows, in the same words, and
 * the columns are the ones the reader has switched on.
 */

export type TableShareConfig = {
  report: ShareReportKey;
  title: string;
  subject?: string;
  period?: string;
  /** Filters the page applied before the list got its rows ("Outstanding only"). */
  filters?: string[];
};

type ShareColumn<T> = {
  id: string;
  header: string;
  numeric?: boolean;
  cell: (row: T) => React.ReactNode;
  footer?: React.ReactNode;
};

type Job<T> = {
  id: number;
  rows: T[];
  columns: ShareColumn<T>[];
  footer: boolean;
  resolve: (read: { body: string[][]; foot: string[] | null }) => void;
};

function OffscreenText<T>({ job, onDone }: { job: Job<T>; onDone: () => void }) {
  const ref = React.useRef<HTMLTableElement>(null);
  React.useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const body = [...(table.tBodies[0]?.rows ?? [])].map((tr) => [...tr.cells].map((td) => textOf(td)));
    const foot = table.tFoot?.rows[0] ? [...table.tFoot.rows[0].cells].map((td) => textOf(td)) : null;
    job.resolve({ body, foot });
    onDone();
  }, [job, onDone]);
  return createPortal(
    <div aria-hidden="true" data-share="offscreen" style={{ position: 'fixed', left: -100_000, top: 0, width: 1400, opacity: 0, pointerEvents: 'none' }}>
      <table ref={ref}>
        <tbody>
          {job.rows.map((row, i) => (
            <tr key={i}>
              {job.columns.map((c) => (
                <td key={c.id}>{c.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {job.footer ? (
          <tfoot>
            <tr>
              {job.columns.map((c) => (
                <td key={c.id}>{c.footer ?? null}</td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>,
    document.body,
  );
}

export function useTableShare<T>({
  config,
  data,
  filtered,
  pageRows,
  columns,
  visibleIds,
  getRowId,
  filterWords,
  hasFooter,
}: {
  config?: TableShareConfig;
  data: T[];
  filtered: T[];
  pageRows: T[];
  columns: ShareColumn<T>[];
  visibleIds: Set<string>;
  getRowId: (row: T) => string;
  filterWords: string[];
  hasFooter: boolean;
}) {
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [share, setShare] = React.useState<{ id: number; spec: ShareSpec } | null>(null);
  const [job, setJob] = React.useState<Job<T> | null>(null);
  const jobs = React.useRef(0);
  const clearJob = React.useCallback(() => setJob(null), []);

  const read = (rows: T[], cols: ShareColumn<T>[], footer: boolean) =>
    new Promise<{ body: string[][]; foot: string[] | null }>((resolve) => {
      jobs.current += 1;
      setJob({ id: jobs.current, rows, columns: cols, footer, resolve });
    });

  function open(scope?: string) {
    if (!config) return;
    const narrowed = filtered.length !== data.length;
    const paged = pageRows.length < filtered.length;
    const spec: ShareSpec = {
      report: config.report,
      title: config.title,
      subject: config.subject,
      period: config.period,
      scopes: [
        { key: 'filtered', label: narrowed ? `Current filtered list (${filtered.length} rows)` : `Current list (${filtered.length} rows)`, hint: 'Every row the search and filters show, not only this page.' },
        ...(paged ? [{ key: 'view', label: `Current page only (${pageRows.length} rows)` }] : []),
        ...(narrowed ? [{ key: 'all', label: `Entire list, without the filters (${data.length} rows)` }] : []),
        ...(selected.size ? [{ key: 'selected', label: `Selected rows (${selected.size})` }] : []),
      ],
      defaultScope: scope ?? 'filtered',
      columns: columns.map((c) => ({ key: c.id, label: c.header || c.id, checked: visibleIds.has(c.id) })),
      onChooseRows: () => setSelecting(true),
      build: async (choice: ShareChoice) => {
        const rows =
          choice.scope === 'view'
            ? pageRows
            : choice.scope === 'all'
              ? data
              : choice.scope === 'selected'
                ? filtered.filter((r) => selected.has(getRowId(r)))
                : filtered;
        const chosen = columns.filter((c) => choice.columns.includes(c.id));
        const cols = chosen.length ? chosen : columns.filter((c) => visibleIds.has(c.id));
        // The list's own totals line only describes the whole list.
        const footer = hasFooter && rows.length === data.length;
        const { body, foot } = await read(rows, cols, footer);
        const section: ShareSection = {
          columns: cols.map((c) => ({ label: c.header, numeric: c.numeric })),
          rows: [
            ...body.map((cells) => ({ cells: cells.map((text) => ({ text: text || '—' })) })),
            ...(foot && foot.some(Boolean) ? [{ kind: 'total' as const, cells: foot.map((text) => ({ text })) }] : []),
          ],
        };
        return {
          filters: [...(config.filters ?? []), ...(choice.scope === 'all' ? [] : filterWords)],
          scopeLabel:
            choice.scope === 'view'
              ? 'Current page'
              : choice.scope === 'all'
                ? 'Entire list'
                : choice.scope === 'selected'
                  ? `${rows.length} selected row${rows.length === 1 ? '' : 's'}`
                  : narrowed
                    ? 'Current filtered list'
                    : 'Current list',
          facts: [],
          sections: [section],
        };
      },
    };
    setShare((s) => ({ id: (s?.id ?? 0) + 1, spec }));
  }

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const elements = config ? (
    <>
      {selecting ? (
        <div
          className="fixed inset-x-3 bottom-20 z-40 mx-auto flex max-w-xl flex-wrap items-center justify-between gap-2 rounded-xl border border-forest-300 bg-surface px-4 py-3 shadow-xl sm:bottom-6"
          data-print="hide"
          data-testid="table-selection-bar"
        >
          <span className="text-sm font-medium text-ink">
            {selected.size} row{selected.size === 1 ? '' : 's'} selected
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => (setSelecting(false), setSelected(new Set()))}>
              Cancel
            </Button>
            <Button size="sm" disabled={selected.size === 0} onClick={() => open('selected')} data-testid="table-share-selected">
              <WhatsAppIcon className="fill-white" /> Share selected
            </Button>
          </span>
        </div>
      ) : null}
      {share ? <ShareDialog key={`share-${share.id}`} open onOpenChange={(o) => !o && setShare(null)} spec={share.spec} /> : null}
      {job ? <OffscreenText key={`read-${job.id}`} job={job} onDone={clearJob} /> : null}
    </>
  ) : null;

  return { selecting, selected, toggle, open, elements };
}

/** The tick box in front of a row while rows are being chosen. */
export function RowSelectBox({ checked, label, onChange }: { checked: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="size-4 shrink-0 accent-forest-700"
      data-testid="table-select-row"
    />
  );
}
