'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The screens opened lately, as tabs under the top bar.
 *
 * Working through a shipment, its costs, an invoice and the agent's ledger
 * means going back and forth between the same few screens; each one opened
 * becomes a tab, named after the page's own heading, and stays until it is
 * closed or pushed out by newer ones. The order holds still like a browser's
 * tabs — the current one is highlighted — and the oldest-used tab goes first
 * when there are too many.
 *
 * Kept in this browser only, per user and per company, so Dubai's screens do
 * not appear while working in Morocco. Nothing here is saved to the books.
 */

type Tab = { path: string; href: string; title: string; usedAt: number };

const MAX_TABS = 12;
/** Screens that are not worth a tab. */
const SKIP = [/^\/login/, /^\/select-company/, /\/new$/, /\/edit$/, /\/clone$/];

// A tiny store over localStorage, so React reads the tabs the same way on
// every render and hears about changes from other tabs of the browser too.
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; tabs: Tab[] }>();
const NONE: Tab[] = [];

function read(key: string): Tab[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return NONE;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.tabs;
  let tabs: Tab[] = NONE;
  try {
    const parsed = raw ? (JSON.parse(raw) as Tab[]) : [];
    tabs = Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.path === 'string') : NONE;
  } catch {
    tabs = NONE;
  }
  cache.set(key, { raw, tabs });
  return tabs;
}

function write(key: string, tabs: Tab[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(tabs));
  } catch {
    // Private windows and full storage simply keep no tabs.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** The page's own heading, or its document title without the product name. */
function titleOfPage(): string | null {
  const heading = document.querySelector('main h1')?.textContent?.trim();
  if (heading) return heading;
  const title = document.title.replace(/\s*[·|–-]\s*FID Trading.*$/i, '').trim();
  return title || null;
}

function RecentTabsInner({ storageKey }: { storageKey: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const href = search.toString() ? `${pathname}?${search.toString()}` : pathname;
  const tabs = React.useSyncExternalStore(
    subscribe,
    () => read(storageKey),
    () => NONE,
  );

  React.useEffect(() => {
    if (SKIP.some((pattern) => pattern.test(pathname))) return;
    // The heading is on the page a moment after the route changes; a slow
    // page gets a second look, so its tab is named after its heading.
    const record = () => {
      const title = titleOfPage();
      if (!title) return;
      {
        const current = read(storageKey);
        const existing = current.find((t) => t.path === pathname);
        let next: Tab[];
        if (existing) {
          next = current.map((t) => (t.path === pathname ? { ...t, href, title, usedAt: Date.now() } : t));
        } else {
          next = [...current, { path: pathname, href, title, usedAt: Date.now() }];
          while (next.length > MAX_TABS) {
            const oldest = next
              .filter((t) => t.path !== pathname)
              .reduce((a, b) => (b.usedAt < a.usedAt ? b : a));
            next = next.filter((t) => t !== oldest);
          }
        }
        write(storageKey, next);
      }
    };
    const first = window.setTimeout(record, 150);
    const second = window.setTimeout(() => {
      if (document.querySelector('main h1')) record();
    }, 1200);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
    };
  }, [pathname, href, storageKey]);

  function close(path: string) {
    write(storageKey, read(storageKey).filter((t) => t.path !== path));
  }

  function clear() {
    write(storageKey, read(storageKey).filter((t) => t.path === pathname));
  }

  if (tabs.length === 0) return null;

  return (
    <nav
      aria-label="Recently opened"
      data-print="hide"
      data-testid="recent-tabs"
      className="sticky top-[4.5rem] z-20 hidden border-b border-line bg-surface-sunken/95 px-3 backdrop-blur sm:px-5 lg:block"
    >
      <div className="flex items-center gap-1 overflow-x-auto py-1.5">
        {tabs.map((tab) => {
          const active = tab.path === pathname;
          return (
            <span
              key={tab.path}
              className={cn(
                'group flex shrink-0 items-center rounded-md border text-xs transition-colors',
                active
                  ? 'border-forest-300 bg-surface font-semibold text-ink shadow-sm'
                  : 'border-transparent text-ink-muted hover:border-line hover:bg-surface hover:text-ink',
              )}
            >
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                title={tab.title}
                className="max-w-[13rem] truncate py-1 pl-2.5 pr-1"
                data-testid="recent-tab"
              >
                {tab.title}
              </Link>
              <button
                type="button"
                onClick={() => close(tab.path)}
                aria-label={`Close ${tab.title}`}
                className="mr-1 rounded p-0.5 text-ink-subtle opacity-60 hover:bg-forest-50 hover:text-ink group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        {tabs.length > 1 ? (
          <button
            type="button"
            onClick={clear}
            className="ml-auto shrink-0 rounded-md px-2 py-1 text-[11px] text-ink-subtle hover:text-ink"
          >
            Close others
          </button>
        ) : null}
      </div>
    </nav>
  );
}

export function RecentTabs({ userId, companyId }: { userId: string; companyId: string }) {
  // Reading the query string needs a boundary of its own in the app router.
  return (
    <React.Suspense fallback={null}>
      <RecentTabsInner storageKey={`fid_tabs_${userId}_${companyId}`} />
    </React.Suspense>
  );
}
