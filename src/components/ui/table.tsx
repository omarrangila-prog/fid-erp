import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Table primitives. The wrapper scrolls horizontally on its own so a wide
 * financial table never forces the whole page sideways on a phone, and draws
 * the outer frame; the table draws the lines between every row and column
 * (the `data-grid` standard in globals.css), so every figure sits in its own
 * cell.
 */
export function TableWrap({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // `relative`: anything absolutely placed inside (a screen-reader label) scrolls with the table instead of widening the page.
        'relative w-full overflow-x-auto overscroll-x-contain rounded-xl border border-grid bg-surface shadow-card',
        className,
      )}
      {...props}
    />
  );
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('data-grid w-full min-w-max text-sm', className)} {...props} />;
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-surface', className)} {...props} />;
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors hover:bg-forest-50/70', className)} {...props} />;
}

export function TH({
  className,
  numeric,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-3 text-left text-[11px] font-bold uppercase tracking-wide whitespace-nowrap text-ink',
        numeric && 'text-right',
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  numeric,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn('px-3 py-2.5 align-middle text-ink', numeric && 'tnum text-right whitespace-nowrap', className)}
      {...props}
    />
  );
}

export function TFoot({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tfoot
      className={cn('font-semibold text-ink', className)}
      {...props}
    />
  );
}
