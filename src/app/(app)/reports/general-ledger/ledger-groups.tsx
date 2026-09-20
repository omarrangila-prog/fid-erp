'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { journalSourceHref } from '@/lib/journal-source';
import { cn } from '@/lib/utils';

export type LedgerGroupView = {
  accountId: string;
  name: string;
  type: string;
  opening: string;
  closing: string;
  debit: string;
  credit: string;
  lines: Array<{
    entryId: string;
    date: string;
    type: string;
    sourceType: string;
    sourceId: string;
    reference: string;
    party: string;
    description: string;
    debit: string;
    credit: string;
    balance: string;
  }>;
};

const OPEN_KEY = 'fid.reports.general-ledger.open';

/**
 * The printed general ledger: one register per account — date, type,
 * reference, party, description, debit, credit, running balance — with the
 * opening balance above and the closing balance below. Each account opens
 * and closes, and the reader's choice is remembered.
 */
export function LedgerGroups({ groups }: { groups: LedgerGroupView[] }) {
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
          <section key={group.accountId} className="rounded-lg border border-line">
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
              <div className="overflow-x-auto border-t border-line">
                <table className="w-full min-w-[48rem] text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-ink-muted">
                      <th className="px-3 py-1.5 font-medium">Date</th>
                      <th className="px-3 py-1.5 font-medium">Type</th>
                      <th className="px-3 py-1.5 font-medium">Reference</th>
                      <th className="px-3 py-1.5 font-medium">Party</th>
                      <th className="px-3 py-1.5 font-medium">Description</th>
                      <th className="px-3 py-1.5 text-right font-medium">Debit</th>
                      <th className="px-3 py-1.5 text-right font-medium">Credit</th>
                      <th className="px-3 py-1.5 text-right font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="bg-surface-sunken/40 text-xs text-ink-muted">
                      <td className="px-3 py-1.5" colSpan={7}>
                        Opening balance
                      </td>
                      <td className="tnum px-3 py-1.5 text-right">{group.opening}</td>
                    </tr>
                    {group.lines.map((line) => {
                      const href = journalSourceHref(line.sourceType, line.sourceId);
                      return (
                        <tr key={`${line.entryId}-${line.balance}-${line.debit}-${line.credit}`} className="border-t border-line/60 hover:bg-surface-sunken/40">
                          <td className="whitespace-nowrap px-3 py-1.5">{line.date}</td>
                          <td className="px-3 py-1.5 text-xs">{line.type}</td>
                          <td className="px-3 py-1.5 text-xs">
                            {href ? (
                              <Link href={href} className="text-forest-800 hover:text-gold-700 hover:underline">
                                {line.reference || 'Open'}
                              </Link>
                            ) : (
                              line.reference || '—'
                            )}
                          </td>
                          <td className="px-3 py-1.5">{line.party || '—'}</td>
                          <td className="max-w-[24rem] truncate px-3 py-1.5 text-ink-muted">{line.description}</td>
                          <td className={cn('tnum px-3 py-1.5 text-right', line.debit === '—' && 'text-ink-subtle')}>{line.debit}</td>
                          <td className={cn('tnum px-3 py-1.5 text-right', line.credit === '—' && 'text-ink-subtle')}>{line.credit}</td>
                          <td className="tnum px-3 py-1.5 text-right">{line.balance}</td>
                        </tr>
                      );
                    })}
                    <tr className="border-t border-line-strong bg-surface-sunken/40 font-semibold">
                      <td className="px-3 py-2" colSpan={5}>
                        Closing balance
                      </td>
                      <td className="tnum px-3 py-2 text-right">{group.debit}</td>
                      <td className="tnum px-3 py-2 text-right">{group.credit}</td>
                      <td className="tnum px-3 py-2 text-right">{group.closing}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
