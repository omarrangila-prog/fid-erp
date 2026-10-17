import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, FileWarning, FileText, HandCoins, Ship, PackageMinus, Receipt, Bell } from 'lucide-react';
import { cn } from '@/lib/utils';

export type AttentionItem = {
  key: string;
  label: string;
  detail: string;
  count: number;
  href: string;
  /** danger = money or goods at risk; warn = needs doing soon; info = for awareness. */
  tone: 'danger' | 'warn' | 'info';
};

const TILE = {
  danger: 'bg-red-50 text-red-700 ring-red-100',
  warn: 'bg-amber-50 text-amber-700 ring-amber-100',
  info: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
} as const;
const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  overdue: FileWarning, outstanding: FileText, payables: HandCoins, expenses: Receipt, arrivals: Ship, lowstock: PackageMinus, alerts: Bell,
};
const NUM = { danger: 'text-red-700', warn: 'text-amber-700', info: 'text-ink' } as const;

/**
 * What needs attention today: only the things that exist, most urgent first.
 * Every row is a link to the screen that resolves it. The tone is also spelled
 * out in the label for screen readers, so colour is never the only signal.
 */
export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const order = { danger: 0, warn: 1, info: 2 } as const;
  const rows = items.filter((i) => i.count > 0).sort((a, b) => order[a.tone] - order[b.tone]);
  return (
    <ul className="space-y-2" data-testid="needs-attention">
      {rows.length === 0 ? (
        <li className="rounded-lg border border-dashed border-line-strong p-4 text-sm text-ink-muted">
          Nothing needs attention right now. Overdue invoices, payments due, arrivals and low stock will appear here.
        </li>
      ) : (
        rows.map((i) => (
          <li key={i.key}>
            <Link
              href={i.href}
              className="group flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 transition-colors hover:border-forest-300 hover:bg-forest-50/50"
            >
              <span aria-hidden className={cn('grid size-9 shrink-0 place-items-center rounded-lg ring-1 ring-inset', TILE[i.tone])}>
                {(() => { const Icon = ICONS[i.key] ?? FileText; return <Icon className="size-[18px]" />; })()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">
                  {i.label}
                  <span className="sr-only"> ({i.tone === 'danger' ? 'urgent' : i.tone === 'warn' ? 'due soon' : 'for your information'})</span>
                </span>
                <span className="tnum block truncate text-xs text-ink-subtle">{i.detail}</span>
              </span>
              <span className={cn('tnum shrink-0 text-base font-semibold', NUM[i.tone])}>{i.count}</span>
              <ChevronRight className="size-4 shrink-0 text-ink-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          </li>
        ))
      )}
    </ul>
  );
}
