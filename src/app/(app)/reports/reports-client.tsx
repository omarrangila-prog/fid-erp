'use client';

import * as React from 'react';
import Link from 'next/link';
import { Search, Star, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/feedback';

export type ReportEntry = {
  href: string;
  title: string;
  description: string;
  category: string;
  /** Marked by the business as an everyday report. */
  pinned: boolean;
  keywords: string;
};

const STORAGE_KEY = 'fid.reports.favourites';

/**
 * Favourites live in the browser, which makes them an external store as far as
 * React is concerned. Subscribing to it rather than copying it into state in an
 * effect avoids the cascading render that pattern causes, and keeps the server
 * render (no favourites) consistent with the first client paint.
 */
const EMPTY: ReadonlySet<string> = new Set<string>();
let cachedRaw: string | null = null;
let cachedValue: ReadonlySet<string> = EMPTY;
const listeners = new Set<() => void>();

function readFavourites(): ReadonlySet<string> {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY;
  }
  // The snapshot must be referentially stable or React re-renders forever.
  if (raw === cachedRaw) return cachedValue;
  cachedRaw = raw;
  try {
    cachedValue = raw ? new Set(JSON.parse(raw) as string[]) : EMPTY;
  } catch {
    cachedValue = EMPTY;
  }
  return cachedValue;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function writeFavourites(next: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    /* storage unavailable; the choice simply will not persist */
  }
  for (const listener of listeners) listener();
}

/**
 * The reports index.
 *
 * Forty-odd reports is too many to scan, so the ones the business actually
 * opens every day are pinned at the top and everything else is grouped and
 * searchable. Favourites are a per-person convenience kept in the browser —
 * they change nothing about the reports themselves, so they do not belong in
 * the database.
 */
export function ReportsClient({ reports }: { reports: ReportEntry[] }) {
  const [query, setQuery] = React.useState('');
  const favourites = React.useSyncExternalStore(subscribe, readFavourites, () => EMPTY);

  function toggleFavourite(href: string) {
    const next = new Set(favourites);
    if (next.has(href)) next.delete(href);
    else next.add(href);
    writeFavourites(next);
  }

  const trimmed = query.trim().toLowerCase();
  const matches = React.useMemo(
    () =>
      trimmed.length === 0
        ? reports
        : reports.filter((report) =>
            `${report.title} ${report.description} ${report.category} ${report.keywords}`
              .toLowerCase()
              .includes(trimmed),
          ),
    [reports, trimmed],
  );

  const starred = matches.filter((r) => favourites.has(r.href));
  const everyday = matches.filter((r) => r.pinned && !favourites.has(r.href));
  const categories = [...new Set(matches.map((r) => r.category))];

  function tile(report: ReportEntry) {
    const isFavourite = favourites.has(report.href);
    return (
      <div key={report.href} className="relative">
        <Link href={report.href} className="block h-full">
          <Card className="h-full p-4 pr-11 transition-colors hover:border-forest-300 hover:bg-forest-50/40">
            <p className="text-sm font-semibold text-ink">{report.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{report.description}</p>
            <p className="mt-2 text-[11px] uppercase tracking-wide text-ink-subtle">{report.category}</p>
          </Card>
        </Link>
        <button
          type="button"
          onClick={() => toggleFavourite(report.href)}
          aria-label={isFavourite ? `Remove ${report.title} from favourites` : `Add ${report.title} to favourites`}
          aria-pressed={isFavourite}
          className="absolute right-2 top-2 rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-forest-50 hover:text-gold-700 [@media(pointer:coarse)]:p-2.5"
        >
          <Star className={cn('size-4', isFavourite && 'fill-gold-500 text-gold-600')} />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="relative sm:max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search reports…"
          aria-label="Search reports"
          className="pl-9 pr-9"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear the search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-subtle hover:text-ink"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {matches.length === 0 ? (
        <EmptyState
          title={`No report matches “${query}”`}
          description="Try the name of a statement, a ledger, or what you are trying to find out."
        />
      ) : null}

      {starred.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-ink">Your favourites</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{starred.map(tile)}</div>
        </section>
      ) : null}

      {everyday.length > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Everyday reports</h2>
            <p className="text-xs text-ink-muted">
              The ones a coffee trading business opens most. Star any report to pin your own.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{everyday.map(tile)}</div>
        </section>
      ) : null}

      {categories.map((category) => {
        const inCategory = matches.filter(
          (r) => r.category === category && !favourites.has(r.href) && !r.pinned,
        );
        if (inCategory.length === 0) return null;
        return (
          <section key={category} className="space-y-3">
            <h2 className="text-sm font-semibold text-ink">{category}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{inCategory.map(tile)}</div>
          </section>
        );
      })}
    </div>
  );
}
