'use client';

import * as React from 'react';
import { CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The filter strip above a report: one panel, its settings side by side in
 * labelled cells, read like the header of a statement rather than a form.
 * Each cell is a small caps label over a borderless value; the panel carries
 * the border, so a row of filters does not become a row of boxes.
 */
export function FilterBar({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-filter-bar=""
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-card print:hidden md:flex-row md:flex-wrap md:items-stretch md:max-w-full',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** One labelled cell in the bar. */
export function FilterCell({
  label,
  htmlFor,
  icon,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const Tag = htmlFor ? 'div' : 'label';
  return (
    <Tag
      className={cn(
        'group/cell relative flex min-w-0 flex-col justify-center gap-0.5 border-b border-line px-4 py-2.5 transition-colors last:border-b-0 md:last:border-r-0 focus-within:bg-forest-50/60 hover:bg-surface-sunken/50 md:border-b-0 md:border-r',
        className,
      )}
    >
      {htmlFor ? (
        <label htmlFor={htmlFor} className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          {icon}
          {label}
        </label>
      ) : (
        <span className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          {icon}
          {label}
        </span>
      )}
      {children}
      <span aria-hidden className="pointer-events-none absolute inset-x-4 bottom-0 h-0.5 scale-x-0 rounded-full bg-forest-600 transition-transform group-focus-within/cell:scale-x-100" />
    </Tag>
  );
}

/** A value inside a cell: no box of its own. */
export const filterControl =
  'h-7 w-full min-w-0 cursor-pointer appearance-none border-0 bg-transparent p-0 text-sm font-semibold text-ink focus:outline-none focus:ring-0';

/** A native select styled as a cell value, with a quiet chevron. */
export const FilterSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        filterControl,
        'bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 20 20\'%3E%3Cpath stroke=\'%23736d61\' stroke-linecap=\'round\' stroke-width=\'1.5\' d=\'m6 8 4 4 4-4\'/%3E%3C/svg%3E")] bg-[length:18px_18px] bg-[right_-2px_center] bg-no-repeat pr-6',
        className,
      )}
      {...props}
    />
  ),
);
FilterSelect.displayName = 'FilterSelect';

/** Free text in a cell, such as a reference to search for. */
export const FilterInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(filterControl, 'cursor-text placeholder:font-normal placeholder:text-ink-subtle', className)}
      {...props}
    />
  ),
);
FilterInput.displayName = 'FilterInput';

const DISPLAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "1 Oct 2026" for a yyyy-mm-dd value; the empty text otherwise. */
export function displayDate(value: string, empty: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return empty;
  return DISPLAY.format(new Date(`${value}T00:00:00Z`));
}

/**
 * A date shown as words ("1 Oct 2026") rather than the browser's
 * mm/dd/yyyy mask. The real date input sits over it, transparent, so a click
 * opens the browser's calendar and typing still works.
 */
export function FilterDate({
  id,
  value,
  onChange,
  empty = 'Any date',
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  empty?: string;
  'aria-label'?: string;
}) {
  return (
    <span className="relative flex h-7 items-center gap-2">
      <CalendarDays aria-hidden className="size-4 shrink-0 text-forest-600" />
      <span className={cn('truncate text-sm font-semibold tabular-nums', value ? 'text-ink' : 'text-ink-subtle')}>
        {displayDate(value, empty)}
      </span>
      <input
        id={id}
        type="date"
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker?.();
          } catch {
            // Older browsers open the calendar from their own icon.
          }
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </span>
  );
}

/** The bar's action: fills the end of the row, solid when there is something to apply. */
export function FilterApply({
  dirty,
  onClick,
  type = 'button',
  children = 'Apply',
}: {
  dirty: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-end px-3 py-2.5 md:ml-auto">
      <button
        type={type}
        onClick={onClick}
        data-button=""
        className={cn(
          'inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg px-5 text-sm font-semibold transition-colors md:w-auto [@media(pointer:coarse)]:min-h-11',
          dirty
            ? 'bg-forest-800 text-white shadow-card hover:bg-forest-700'
            : 'border border-line text-ink-muted hover:border-forest-300 hover:text-ink',
        )}
      >
        {children}
      </button>
    </div>
  );
}

/** Quick choices under or beside a bar: one pill per option, the chosen one filled. */
export function FilterChips({
  label,
  options,
  value,
  onSelect,
  className,
}: {
  label?: string;
  options: ReadonlyArray<{ value: string; label: string; href?: string }>;
  value: string | null;
  onSelect?: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 print:hidden', className)} role="group" aria-label={label}>
      {label ? <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">{label}</span> : null}
      {options.map((o) => {
        const active = o.value === value;
        const cls = cn(
          'rounded-full border px-3 py-1 text-xs font-medium transition-colors [@media(pointer:coarse)]:py-2',
          active
            ? 'border-forest-800 bg-forest-800 text-white shadow-card'
            : 'border-line bg-surface text-ink-muted hover:border-forest-300 hover:text-ink',
        );
        return o.href ? (
          <a key={o.value} href={o.href} aria-current={active ? 'true' : undefined} className={cls}>
            {o.label}
          </a>
        ) : (
          <button key={o.value} type="button" aria-pressed={active} onClick={() => onSelect?.(o.value)} className={cls}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
