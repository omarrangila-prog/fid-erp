'use client';

import * as React from 'react';
import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

export type LedgerSearchRow = {
  key: string;
  name: string;
  kind: 'Customer' | 'Supplier' | 'Agent' | 'Bank' | 'Cash' | 'Loan' | 'Account';
  detail: string;
  currency: string;
  balanceLabel: string;
  balanceSort: number;
  balanceMeaning: string;
  href: string;
  keywords: string;
};

const KINDS: Array<LedgerSearchRow['kind'] | 'All'> = ['All', 'Customer', 'Supplier', 'Agent', 'Bank', 'Cash', 'Loan', 'Account'];
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
  const hay = `${row.name} ${row.kind} ${row.detail} ${row.keywords} ${row.currency}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

export function LedgerSearch({ rows, initialQuery }: { rows: LedgerSearchRow[]; initialQuery: string }) {
  const [query, setQuery] = React.useState(initialQuery);
  const [kind, setKind] = React.useState<(typeof KINDS)[number]>('All');

  const shown = rows.filter((r) => (kind === 'All' || r.kind === kind) && (!query.trim() || matches(r, query)));
  // With nothing typed, lead with the ledgers that carry a balance — the ones people open.
  const ordered = query.trim() ? shown : [...shown].sort((a, b) => Math.abs(b.balanceSort) - Math.abs(a.balanceSort));
  const limit = query.trim() ? ordered : ordered.slice(0, 40);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a name, phone or account…"
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
      </div>

      {limit.length === 0 ? (
        <EmptyState title={`No ledger matches “${query}”`} description="Try part of the name, a phone number or the kind of account." />
      ) : (
        <Card className="divide-y divide-line overflow-hidden p-0">
          {limit.map((row) => (
            <div key={row.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-sunken/40">
              <div className="min-w-0">
                <Link href={row.href} className="font-medium text-ink hover:text-gold-700 hover:underline">
                  {row.name}
                </Link>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  <Badge tone={TONES[row.kind]}>{row.kind}</Badge>
                  {row.detail ? <span>{row.detail}</span> : null}
                  <span>{row.currency}</span>
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="tnum text-sm font-semibold text-ink">{row.balanceLabel}</p>
                  <p className="text-[11px] text-ink-subtle">{row.balanceMeaning}</p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link href={row.href}>Open ledger</Link>
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {!query.trim() && ordered.length > limit.length ? (
        <p className="text-xs text-ink-subtle">Showing the {limit.length} with the largest balances of {ordered.length}. Type to search them all.</p>
      ) : null}
    </div>
  );
}
