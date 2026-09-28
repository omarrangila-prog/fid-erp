'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { LedgerReport, type LedgerReportRow } from '@/components/ledger/ledger-report';
import type { LedgerColumnKey, LedgerPrefs } from '@/lib/ledger-columns';

export type LedgerGroupView = {
  accountId: string;
  name: string;
  type: string;
  /** Formatted, for the heading line. */
  opening: string;
  closing: string;
  debit: string;
  credit: string;
  /** Decimal string: the balance before the first row. */
  openingRaw: string;
  rows: LedgerReportRow[];
};

const OPEN_KEY = 'fid.reports.general-ledger.open';

/**
 * The printed general ledger: one register per account, each the same ledger
 * table as everywhere else — opening balance, the rows, totals and closing
 * balance — in the columns this person chose for the general ledger. Each
 * account opens and closes, and the reader's choice is remembered.
 */
export function LedgerGroups({
  groups,
  prefs,
  available,
  companyName,
}: {
  groups: LedgerGroupView[];
  prefs: LedgerPrefs;
  available: LedgerColumnKey[];
  companyName: string;
}) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(OPEN_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- per-browser preference, applied once after mount
      if (raw) setOpen(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      // Nothing remembered: every account opens.
    }
  }, []);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? true) };
      try {
        window.localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // Still toggles for this visit.
      }
      return next;
    });
  }

  function setAll(value: boolean) {
    const next = Object.fromEntries(groups.map((g) => [g.accountId, value]));
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    } catch {
      // Fine.
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end gap-2 print:hidden">
        <button type="button" className="text-xs text-ink-muted hover:text-ink" onClick={() => setAll(true)}>
          Expand all
        </button>
        <span className="text-xs text-ink-subtle">·</span>
        <button type="button" className="text-xs text-ink-muted hover:text-ink" onClick={() => setAll(false)}>
          Collapse all
        </button>
      </div>
      {groups.map((group) => {
        const shown = open[group.accountId] ?? true;
        return (
          <section key={group.accountId} className="rounded-lg border border-ink/70">
            <button
              type="button"
              onClick={() => toggle(group.accountId)}
              aria-expanded={shown}
              className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-sunken/60"
            >
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-ink">
                {shown ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                {group.name}
              </span>
              <span className="tnum text-xs text-ink-muted">
                Opening {group.opening} · debits {group.debit} · credits {group.credit} ·{' '}
                <span className="font-semibold text-ink">closing {group.closing}</span>
              </span>
            </button>
            {shown ? (
              <div className="overflow-x-auto border-t border-ink/70 p-2">
                <LedgerReport
                  mode="document"
                  report="general-ledger"
                  title="General ledger"
                  subject={group.name}
                  currency="USD"
                  balanceSide="debit"
                  opening={group.openingRaw}
                  rows={group.rows}
                  available={available}
                  initialPrefs={prefs}
                  companyName={companyName}
                />
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
