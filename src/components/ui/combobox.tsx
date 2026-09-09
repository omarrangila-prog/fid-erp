'use client';

import * as React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ComboOption = {
  value: string;
  label: string;
  /** Second line, e.g. a code or a currency. */
  hint?: string;
  /** Extra text matched by the search box but not displayed. */
  keywords?: string;
  disabled?: boolean;
};

/**
 * Searchable single-select. Customer, vendor, item and batch pickers all use
 * this — those lists get long, and a native select becomes unusable.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  emptyText = 'No matches',
  disabled,
  id,
  className,
  invalid,
  'aria-label': ariaLabel,
}: {
  options: ComboOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Marks the control as failing validation. */
  invalid?: boolean;
  /** Needed where the visible label appears only on the first row of a list. */
  'aria-label'?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      `${o.label} ${o.hint ?? ''} ${o.keywords ?? ''}`.toLowerCase().includes(q),
    );
  }, [options, query]);

  // Clearing the search on close belongs in the handler: doing it in an effect
  // makes React render twice for a state change we already know about.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery('');
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          id={id}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          type="button"
          disabled={disabled}
          data-invalid={invalid ? 'true' : undefined}
          className={cn(
            'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface px-3 text-left text-sm transition-colors hover:border-forest-300 focus:border-gold-500 focus:outline-none focus:ring-2 focus:ring-gold-500/20 disabled:cursor-not-allowed disabled:bg-forest-50 data-[invalid=true]:border-red-400',
            className,
          )}
        >
          <span className={cn('truncate', selected ? 'text-ink' : 'text-ink-subtle')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-ink-subtle" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="animate-in-soft z-50 w-[var(--radix-popover-trigger-width)] min-w-56 overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="size-4 shrink-0 text-ink-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-ink-subtle"
            />
          </div>

          <div className="max-h-64 overflow-y-auto p-1" role="listbox" aria-label={ariaLabel ?? 'Options'}>
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-ink-subtle">{emptyText}</p>
            ) : (
              filtered.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  onClick={() => {
                    onChange(option.value === value ? null : option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-forest-50 disabled:cursor-not-allowed disabled:opacity-50',
                    option.value === value && 'bg-gold-50',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-ink">{option.label}</span>
                    {option.hint ? (
                      <span className="block truncate text-xs text-ink-subtle">{option.hint}</span>
                    ) : null}
                  </span>
                  {option.value === value ? <Check className="size-4 shrink-0 text-gold-600" /> : null}
                </button>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
