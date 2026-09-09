'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpDown, ArrowUp, ArrowDown, Search, SlidersHorizontal, ChevronLeft, ChevronRight } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export type DataColumn<T> = {
  id: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  numeric?: boolean;
  /** Returns a comparable value; omit to make the column unsortable. */
  sortValue?: (row: T) => string | number;
  /** Column can be hidden from the column picker. */
  hideable?: boolean;
  defaultHidden?: boolean;
  /** Where this column appears in the mobile card layout. */
  mobile?: 'title' | 'badge' | 'meta' | 'hidden';
  className?: string;
  footer?: React.ReactNode;
};

type SortState = { columnId: string; direction: 'asc' | 'desc' } | null;

/**
 * The table used across every list screen.
 *
 * Below `md` it stops being a table: each row becomes a card built from the
 * columns tagged `title`, `badge` and `meta`. Squeezing twelve financial
 * columns into a phone-width table would make the data unreadable, which is the
 * one thing this application cannot afford.
 */
export function DataTable<T>({
  data,
  columns,
  getRowId,
  rowHref,
  searchValue,
  searchPlaceholder = 'Search…',
  emptyTitle = 'Nothing to show',
  emptyDescription,
  emptyAction,
  pageSize = 25,
  toolbar,
  showFooter = false,
  dense = false,
}: {
  data: T[];
  columns: DataColumn<T>[];
  getRowId: (row: T) => string;
  rowHref?: (row: T) => string;
  /** Concatenated searchable text for a row. Omit to hide the search box. */
  searchValue?: (row: T) => string;
  searchPlaceholder?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  pageSize?: number;
  toolbar?: React.ReactNode;
  showFooter?: boolean;
  dense?: boolean;
}) {
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<SortState>(null);
  const [page, setPage] = React.useState(0);
  const [hidden, setHidden] = React.useState<Set<string>>(
    () => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.id)),
  );

  const visibleColumns = columns.filter((c) => !hidden.has(c.id));

  const filtered = React.useMemo(() => {
    if (!searchValue || !query.trim()) return data;
    const q = query.trim().toLowerCase();
    return data.filter((row) => searchValue(row).toLowerCase().includes(q));
  }, [data, query, searchValue]);

  const sorted = React.useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((c) => c.id === sort.columnId);
    if (!column?.sortValue) return filtered;

    return [...filtered].sort((a, b) => {
      const av = column.sortValue!(a);
      const bv = column.sortValue!(b);
      let result: number;
      if (typeof av === 'number' && typeof bv === 'number') result = av - bv;
      else result = String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sort.direction === 'asc' ? result : -result;
    });
  }, [filtered, sort, columns]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);

  function toggleSort(columnId: string) {
    setSort((current) => {
      if (current?.columnId !== columnId) return { columnId, direction: 'asc' };
      if (current.direction === 'asc') return { columnId, direction: 'desc' };
      return null;
    });
  }

  const hideableColumns = columns.filter((c) => c.hideable);

  return (
    <div className="space-y-3">
      {(searchValue || toolbar || hideableColumns.length > 0) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {searchValue ? (
            <div className="relative flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
              <Input
                value={query}
                onChange={(e) => {
                  // A new search means a new result set, so go back to page one.
                  setQuery(e.target.value);
                  setPage(0);
                }}
                placeholder={searchPlaceholder}
                className="pl-9"
                aria-label={searchPlaceholder}
              />
            </div>
          ) : (
            <div className="flex-1" />
          )}

          <div className="flex items-center gap-2">
            {toolbar}
            {hideableColumns.length > 0 ? (
              <Popover.Root>
                <Popover.Trigger asChild>
                  <Button variant="outline" size="md" className="shrink-0">
                    <SlidersHorizontal />
                    <span className="hidden sm:inline">Columns</span>
                  </Button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    align="end"
                    sideOffset={4}
                    className="animate-in-soft z-50 w-56 rounded-lg border border-line bg-surface p-1 shadow-lg"
                  >
                    {hideableColumns.map((column) => (
                      <label
                        key={column.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-navy-50"
                      >
                        <input
                          type="checkbox"
                          className="size-4 accent-teal-600"
                          checked={!hidden.has(column.id)}
                          onChange={() =>
                            setHidden((prev) => {
                              const next = new Set(prev);
                              if (next.has(column.id)) next.delete(column.id);
                              else next.add(column.id);
                              return next;
                            })
                          }
                        />
                        {column.header}
                      </label>
                    ))}
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            ) : null}
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
      ) : (
        <>
          {/* Desktop and tablet: a real table. */}
          <TableWrap className="hidden md:block">
            <Table>
              <THead className="sticky-head">
                <TR className="hover:bg-transparent">
                  {visibleColumns.map((column) => (
                    <TH key={column.id} numeric={column.numeric} className={column.className}>
                      {column.sortValue ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(column.id)}
                          className={cn(
                            'inline-flex items-center gap-1 rounded transition-colors hover:text-ink',
                            column.numeric && 'flex-row-reverse',
                          )}
                        >
                          {column.header}
                          {sort?.columnId === column.id ? (
                            sort.direction === 'asc' ? (
                              <ArrowUp className="size-3" />
                            ) : (
                              <ArrowDown className="size-3" />
                            )
                          ) : (
                            <ArrowUpDown className="size-3 opacity-40" />
                          )}
                        </button>
                      ) : (
                        column.header
                      )}
                    </TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {pageRows.map((row) => {
                  const href = rowHref?.(row);
                  return (
                    <TR key={getRowId(row)} className={cn(href && 'cursor-pointer', dense && '[&>td]:py-1.5')}>
                      {visibleColumns.map((column, index) => (
                        <TD key={column.id} numeric={column.numeric} className={column.className}>
                          {href && index === 0 ? (
                            <Link href={href} className="block font-medium text-navy-800 hover:text-teal-700">
                              {column.cell(row)}
                            </Link>
                          ) : href ? (
                            <Link href={href} className="block text-inherit">
                              {column.cell(row)}
                            </Link>
                          ) : (
                            column.cell(row)
                          )}
                        </TD>
                      ))}
                    </TR>
                  );
                })}
              </TBody>
              {showFooter ? (
                <TFoot>
                  <tr>
                    {visibleColumns.map((column) => (
                      <TD key={column.id} numeric={column.numeric}>
                        {column.footer ?? null}
                      </TD>
                    ))}
                  </tr>
                </TFoot>
              ) : null}
            </Table>
          </TableWrap>

          {/* Mobile: cards built from the tagged columns. */}
          <div className="space-y-2 md:hidden">
            {pageRows.map((row) => {
              const href = rowHref?.(row);
              const title = columns.find((c) => c.mobile === 'title');
              const badge = columns.find((c) => c.mobile === 'badge');
              const metas = columns.filter((c) => c.mobile === 'meta' && !hidden.has(c.id));
              const body = (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 font-medium text-navy-800">
                      {title ? title.cell(row) : columns[0].cell(row)}
                    </div>
                    {badge ? <div className="shrink-0">{badge.cell(row)}</div> : null}
                  </div>
                  {metas.length > 0 ? (
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                      {metas.map((column) => (
                        <div key={column.id} className="min-w-0">
                          <dt className="text-[11px] text-ink-subtle">{column.header}</dt>
                          <dd className={cn('truncate text-sm text-ink', column.numeric && 'tnum')}>
                            {column.cell(row)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </>
              );

              return href ? (
                <Link
                  key={getRowId(row)}
                  href={href}
                  className="block rounded-xl border border-line bg-surface p-4 transition-colors active:bg-navy-50"
                >
                  {body}
                </Link>
              ) : (
                <div key={getRowId(row)} className="rounded-xl border border-line bg-surface p-4">
                  {body}
                </div>
              );
            })}
          </div>

          {pageCount > 1 ? (
            <div className="flex items-center justify-between gap-3 text-xs text-ink-muted">
              <p>
                Showing <span className="tnum font-medium text-ink">{safePage * pageSize + 1}</span>–
                <span className="tnum font-medium text-ink">
                  {Math.min((safePage + 1) * pageSize, sorted.length)}
                </span>{' '}
                of <span className="tnum font-medium text-ink">{sorted.length}</span>
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  aria-label="Previous page"
                >
                  <ChevronLeft />
                </Button>
                <span className="tnum px-2">
                  {safePage + 1} / {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={safePage >= pageCount - 1}
                  aria-label="Next page"
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
