import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Paging that happens in the database, not the browser.
 *
 * The client table paginates whatever it has been given, which is fine for a
 * few hundred rows and useless for a ledger that grows every day. Screens whose
 * row count is unbounded — stock movements, the audit trail — fetch one page at
 * a time and navigate with links, so the payload stays the same size in year
 * three as on day one.
 */
export function ServerPagination({
  page,
  pageSize,
  total,
  basePath,
  params = {},
}: {
  /** Zero-based. */
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  /** Filters to carry across page changes. */
  params?: Record<string, string | undefined>;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;

  const href = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    if (target > 0) search.set('page', String(target + 1));
    const query = search.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  const first = page * pageSize + 1;
  const last = Math.min((page + 1) * pageSize, total);

  const step = (target: number, label: string, disabled: boolean, children: React.ReactNode) =>
    disabled ? (
      <span
        aria-disabled
        className="inline-flex size-9 items-center justify-center rounded-lg border border-line text-ink-subtle opacity-50"
      >
        {children}
      </span>
    ) : (
      <Link
        href={href(target)}
        aria-label={label}
        className={cn(
          'inline-flex size-9 items-center justify-center rounded-lg border border-line-strong bg-surface text-ink',
          'transition-colors hover:border-forest-300 hover:bg-forest-50',
          '[@media(pointer:coarse)]:size-11',
        )}
      >
        {children}
      </Link>
    );

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-col items-center justify-between gap-3 text-xs text-ink-muted sm:flex-row"
    >
      <p>
        Showing <span className="tnum font-medium text-ink">{first.toLocaleString()}</span>–
        <span className="tnum font-medium text-ink">{last.toLocaleString()}</span> of{' '}
        <span className="tnum font-medium text-ink">{total.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-1.5">
        {step(page - 1, 'Previous page', page === 0, <ChevronLeft className="size-4" />)}
        <span className="tnum px-2">
          {page + 1} / {pageCount}
        </span>
        {step(page + 1, 'Next page', page >= pageCount - 1, <ChevronRight className="size-4" />)}
      </div>
    </nav>
  );
}
