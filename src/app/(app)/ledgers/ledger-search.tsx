'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { LEDGER_SECTIONS, SECTION_ORDER, type LedgerSection } from '@/lib/ledger-sections';

export type LedgerSearchRow = {
  key: string;
  name: string;
  kind: 'Customer' | 'Supplier' | 'Agent' | 'Bank' | 'Cash' | 'Loan' | 'Account';
  detail: string;
  currency: string;
  balanceLabel: string;
  /** The same balance in USD, where the ledger is kept in another currency. */
  usdLabel?: string | null;
  balanceSort: number;
  balanceMeaning: string;
  href: string;
  keywords: string;
  /** A customer or supplier: its ledger is the dedicated one, not this list. */
  elsewhere?: boolean;
  /** The accounts that belong to this one party, read underneath it. */
  children?: LedgerSearchRow[];
  /** "Radouan owes FID: MAD 46,000" — said in words, not in debits. */
  summary?: Array<{ label: string; value: string }>;
  /** An account that belongs to a party row, so it is only listed on its own in the accountant's view. */
  advancedOnly?: boolean;
  /** Which heading this is read under. */
  section: LedgerSection;
  /** What the figure is, in this account's own words: Balance, Stock value, Owes FID. */
  amountLabel: string;
  /** For a control account: why it is not a second balance. */
  controlNote?: string;
  systemKey?: string | null;
};

const KINDS: Array<LedgerSearchRow['kind'] | 'All'> = ['All', 'Cash', 'Bank', 'Agent', 'Loan', 'Account'];
const TONES: Record<LedgerSearchRow['kind'], 'info' | 'success' | 'progress' | 'neutral' | 'warning'> = {
  Customer: 'info',
  Supplier: 'progress',
  Agent: 'warning',
  Bank: 'success',
  Cash: 'success',
  Loan: 'neutral',
  Account: 'neutral',
};

/** Loose matching: "ideal commodities" finds "Ideal commodities uganda". */
function matches(row: LedgerSearchRow, query: string) {
  const own = `${row.name} ${row.kind} ${row.detail} ${row.keywords} ${row.currency}`;
  const under = (row.children ?? []).map((c) => `${c.name} ${c.detail} ${c.keywords}`).join(' ');
  const hay = `${own} ${under}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/**
 * The list of ledgers, read the way the business thinks about them.
 *
 * Simple is what the client opens: one row for each real thing — a person,
 * a drawer of cash, a bank, an expense — with a person's several accounts
 * folded underneath his name. Advanced is the same list with every ledger
 * account standing on its own, which is what an accountant wants and what
 * this screen used to show everybody.
 */
export function LedgerSearch({ rows, initialQuery }: { rows: LedgerSearchRow[]; initialQuery: string }) {
  const [query, setQuery] = React.useState(initialQuery);
  const [kind, setKind] = React.useState<(typeof KINDS)[number]>('All');
  const [advanced, setAdvanced] = React.useState(false);
  const [open, setOpen] = React.useState<Record<string, boolean>>({});

  const general = rows.filter((r) => !r.elsewhere && (advanced || !r.advancedOnly));
  const shown = general.filter((r) => (kind === 'All' || r.kind === kind) && (!query.trim() || matches(r, query)));
  // A customer or supplier typed here is pointed at its own ledger.
  const redirected = query.trim() ? rows.filter((r) => r.elsewhere && matches(r, query)).slice(0, 8) : [];
  // With nothing typed, lead with the ledgers that carry a balance — the ones people open.
  const ordered = query.trim() ? shown : [...shown].sort((a, b) => Math.abs(b.balanceSort) - Math.abs(a.balanceSort));
  // Sections group them, so the cap is only there to keep a company with
  // hundreds of expense accounts from printing all of them unasked.
  const limit = query.trim() ? ordered : ordered.slice(0, 60);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search: a name, cash, bank, loan, fuel, rent…"
            aria-label="Search ledgers"
            className="pl-9 pr-9"
          />
          {query ? (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear the search" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-subtle hover:text-ink">
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Ledger type">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                kind === k ? 'bg-forest-800 text-white' : 'border border-line text-ink-muted hover:text-ink',
              )}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1 rounded-lg border border-line p-0.5" role="group" aria-label="How much detail">
          {[
            { value: false, label: 'Simple' },
            { value: true, label: 'Accounting' },
          ].map((mode) => (
            <button
              key={mode.label}
              type="button"
              onClick={() => setAdvanced(mode.value)}
              aria-pressed={advanced === mode.value}
              data-testid={`ledger-view-${mode.label.toLowerCase()}`}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                advanced === mode.value ? 'bg-white text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
              )}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      {advanced ? (
        <p className="text-xs text-ink-subtle">
          Every ledger account on its own, in its own classification — including the ones opened in a person&rsquo;s
          name. Simple shows each person once instead.
        </p>
      ) : null}

      {redirected.length > 0 ? (
        <Card className="space-y-1 px-4 py-3" data-testid="ledger-elsewhere">
          <p className="text-xs text-ink-muted">Customers and suppliers have their own ledgers:</p>
          {redirected.map((row) => (
            <p key={row.key} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={TONES[row.kind]}>{row.kind}</Badge>
              <Link href={row.href} className="font-medium text-forest-800 hover:text-gold-700">
                {row.name}
              </Link>
              <span className="tnum text-xs text-ink-muted">
                {row.balanceLabel} {row.balanceMeaning}
              </span>
              <Link href={row.href} className="text-xs text-forest-700 underline underline-offset-2">
                Open in {row.kind === 'Customer' ? 'Customer Ledger' : 'Supplier Ledger'}
              </Link>
            </p>
          ))}
        </Card>
      ) : null}

      {limit.length === 0 ? (
        redirected.length > 0 ? null : (
          <EmptyState title={`No ledger matches “${query}”`} description="Try part of the name, a phone number or the kind of account." />
        )
      ) : (
        SECTION_ORDER.filter((section) => limit.some((row) => row.section === section)).map((section) => {
          const inSection = limit.filter((row) => row.section === section);
          /*
           * The control account beside the parties it explains, said once and
           * in words: it is the same money as the rows underneath, not more.
           */
          const control =
            section === 'COUNTERPARTY' && !advanced
              ? rows.find((row) => row.systemKey === 'AGENT_CLEARING' && Math.abs(row.balanceSort) > 0.005)
              : undefined;

          return (
            <section key={section} className="space-y-2" data-testid={`ledger-section-${section.toLowerCase()}`}>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
                {LEDGER_SECTIONS[section]}
              </h2>
              {control ? (
                <p className="text-xs text-ink-muted" data-testid="ledger-control-note">
                  Agent collections held: <span className="tnum font-medium text-ink">{control.balanceLabel}</span> — the
                  same money as the rows below, not more of it.
                </p>
              ) : null}
              <Card className="divide-y divide-line overflow-hidden p-0">
                {inSection.map((row) => {
                  const expandable = !advanced && (row.children?.length ?? 0) > 0;
                  const isOpen = Boolean(open[row.key]);
                  return (
                    <div key={row.key} data-testid="ledger-entry">
                      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-sunken/40">
                        <div className="flex min-w-0 items-start gap-2">
                          {expandable ? (
                            <button
                              type="button"
                              onClick={() => setOpen((prev) => ({ ...prev, [row.key]: !prev[row.key] }))}
                              aria-expanded={isOpen}
                              aria-label={`${isOpen ? 'Hide' : 'Show'} the accounts behind ${row.name}`}
                              data-testid="ledger-expand"
                              className="mt-0.5 rounded p-0.5 text-ink-subtle hover:text-ink"
                            >
                              <ChevronRight className={cn('size-4 transition-transform', isOpen && 'rotate-90')} />
                            </button>
                          ) : (
                            <span className="w-5" aria-hidden />
                          )}
                          <div className="min-w-0">
                            <Link href={row.href} className="font-medium text-ink hover:text-gold-700 hover:underline">
                              {row.name}
                            </Link>
                            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                              <Badge tone={TONES[row.kind]}>{row.kind}</Badge>
                              {row.detail ? <span>{row.detail}</span> : null}
                            </p>
                            {row.summary ? (
                              <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs" data-testid="ledger-party-summary">
                                {row.summary.map((line) => (
                                  <span key={line.label} className="text-ink-muted">
                                    {line.label}: <span className="tnum font-medium text-ink">{line.value}</span>
                                  </span>
                                ))}
                              </p>
                            ) : null}
                            {row.controlNote ? (
                              <p className="mt-1 max-w-prose text-[11px] text-ink-subtle">{row.controlNote}</p>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          {/* The company's own currency is the figure; the dollar
                              value is an equivalent and is written like one. */}
                          <div className="text-right">
                            <p className="text-[11px] text-ink-subtle">{row.amountLabel}</p>
                            <p className="tnum text-sm font-semibold text-ink">{row.balanceLabel}</p>
                            {row.usdLabel ? (
                              <p className="tnum text-[11px] text-ink-subtle">USD Eq. {row.usdLabel.replace(/^USD\s*/, '')}</p>
                            ) : null}
                          </div>
                          <Button asChild variant="outline" size="sm">
                            <Link href={row.href}>Open ledger</Link>
                          </Button>
                        </div>
                      </div>

                      {expandable && isOpen ? (
                        <div className="space-y-1 border-t border-line bg-surface-sunken/40 px-4 py-3" data-testid="ledger-children">
                          <p className="text-[11px] uppercase tracking-wide text-ink-subtle">
                            The accounts behind {row.name} — each still its own account in the books
                          </p>
                          {row.children?.map((child) => (
                            <div key={child.key} className="flex flex-wrap items-center justify-between gap-2 py-1">
                              <Link href={child.href} className="text-sm text-forest-800 hover:text-gold-700 hover:underline">
                                {child.name}
                              </Link>
                              <span className="tnum text-xs text-ink-muted">
                                {child.amountLabel} {child.balanceLabel}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </Card>
            </section>
          );
        })
      )}
      {!query.trim() && ordered.length > limit.length ? (
        <p className="text-xs text-ink-subtle">Showing the {limit.length} with the largest balances of {ordered.length}. Type to search them all.</p>
      ) : null}
    </div>
  );
}
