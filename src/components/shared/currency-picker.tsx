'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { CURRENCIES } from '@/lib/currencies';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Choose any of the world's currencies: type to search by code or name, click to
 * add, click a chip to remove. The `fixed` currency (the company's own) is
 * always on and cannot be removed.
 */
export function CurrencyPicker({
  value,
  onChange,
  fixed,
  max = 40,
  'aria-label': ariaLabel,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  fixed?: string;
  max?: number;
  'aria-label'?: string;
}) {
  const [query, setQuery] = React.useState('');
  const chosen = new Set(value);
  const matches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return CURRENCIES.filter((c) => !chosen.has(c.code) && (c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))).slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `chosen` is derived from `value`
  }, [query, value]);

  function add(code: string) {
    if (value.length >= max) return;
    onChange([...value, code]);
    setQuery('');
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" aria-label={ariaLabel}>
        {fixed && !chosen.has(fixed) ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-muted px-2 py-1 text-xs font-semibold text-ink">
            {fixed} <span className="font-normal text-ink-subtle">· company currency</span>
          </span>
        ) : null}
        {value.map((code) => (
          <span key={code} className="inline-flex items-center gap-1 rounded-md border border-forest-200 bg-forest-50 px-2 py-1 text-xs font-semibold text-forest-800">
            {code}
            {code === fixed ? (
              <span className="font-normal text-ink-subtle">· company currency</span>
            ) : (
              <button
                type="button"
                onClick={() => onChange(value.filter((c) => c !== code))}
                className="rounded p-0.5 hover:bg-forest-100"
                aria-label={`Remove ${code}`}
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      <div className="relative">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Add a currency — type EUR, pound, rupee…"
          aria-label="Search currencies"
          autoComplete="off"
        />
        {matches.length > 0 ? (
          <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-surface p-1 shadow-overlay" role="listbox">
            {matches.map((c) => (
              <li key={c.code}>
                <button
                  type="button"
                  onClick={() => add(c.code)}
                  className={cn('flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-forest-50')}
                >
                  <span className="font-semibold">{c.code}</span>
                  <span className="truncate text-xs text-ink-muted">{c.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
