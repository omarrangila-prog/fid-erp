'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

const FIELD_BASE =
  'w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink transition-colors placeholder:text-ink-subtle hover:border-navy-300 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 disabled:cursor-not-allowed disabled:bg-navy-50 disabled:text-ink-subtle aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-500/20';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(FIELD_BASE, 'h-10', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(FIELD_BASE, 'min-h-20 py-2 leading-relaxed', className)} {...props} />
  ),
);
Textarea.displayName = 'Textarea';

/**
 * A native select styled to match. Used wherever the option list is short and
 * known; long lists use the searchable Combobox instead.
 */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        FIELD_BASE,
        'h-10 appearance-none bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 20 20\'%3E%3Cpath stroke=\'%235a6782\' stroke-linecap=\'round\' stroke-width=\'1.5\' d=\'m6 8 4 4 4-4\'/%3E%3C/svg%3E")] bg-[length:20px_20px] bg-[right_0.5rem_center] bg-no-repeat pr-9',
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = 'Select';

/**
 * Amount input. Right-aligned tabular figures with the ISO code shown inline,
 * because a bare number in a three-currency system is ambiguous.
 */
export const MoneyInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { currency?: string }
>(({ className, currency, ...props }, ref) => (
  <div className="relative">
    {currency ? (
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-medium text-ink-subtle">
        {currency.toUpperCase()}
      </span>
    ) : null}
    <input
      ref={ref}
      inputMode="decimal"
      className={cn(FIELD_BASE, 'tnum h-10 text-right', currency ? 'pl-14' : '', className)}
      {...props}
    />
  </div>
));
MoneyInput.displayName = 'MoneyInput';

export const QuantityInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { unit?: string }
>(({ className, unit, ...props }, ref) => (
  <div className="relative">
    <input
      ref={ref}
      inputMode="decimal"
      className={cn(FIELD_BASE, 'tnum h-10 text-right', unit ? 'pr-12' : '', className)}
      {...props}
    />
    {unit ? (
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-ink-subtle">
        {unit}
      </span>
    ) : null}
  </div>
));
QuantityInput.displayName = 'QuantityInput';
