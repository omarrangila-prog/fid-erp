import Link from 'next/link';
import { ArrowRight, TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The headline figure.
 *
 * Each card carries one number, the unit it is in, and one line saying whether
 * that is good news. The coloured tile is how the eye finds the card it wants
 * without reading every label — so the colour is tied to the kind of figure,
 * not decoration.
 */

export type KpiTone = 'sales' | 'receivable' | 'payable' | 'inventory' | 'cash' | 'profit';

const TILE: Record<KpiTone, string> = {
  sales: 'bg-emerald-50 text-emerald-700',
  receivable: 'bg-amber-50 text-amber-700',
  payable: 'bg-red-50 text-red-700',
  inventory: 'bg-sky-50 text-sky-700',
  cash: 'bg-forest-50 text-forest-700',
  profit: 'bg-gold-50 text-gold-700',
};

export function KpiCard({
  label,
  currency,
  value,
  icon: Icon,
  tone,
  deltaPct,
  deltaLabel,
  note,
  noteTone = 'muted',
  href,
  linkLabel,
}: {
  label: string;
  /** Shown small before the figure, because a bare number is ambiguous here. */
  currency?: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: KpiTone;
  deltaPct?: number | null;
  deltaLabel?: string;
  note?: string;
  noteTone?: 'muted' | 'warning' | 'danger';
  href?: string;
  linkLabel?: string;
}) {
  const rising = (deltaPct ?? 0) >= 0;

  return (
    <div className="flex h-full flex-col rounded-xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-forest-200">
      <div className="flex items-start justify-between gap-3">
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', TILE[tone])}>
          <Icon className="size-[18px]" />
        </span>
        {deltaPct !== undefined && deltaPct !== null ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold',
              rising ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700',
            )}
          >
            {rising ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {rising ? '↑' : '↓'} {Math.abs(deltaPct).toFixed(0)}%
          </span>
        ) : null}
      </div>

      <p className="mt-3 text-xs font-medium text-ink-muted">{label}</p>
      <p className="tnum mt-0.5 text-xl font-semibold tracking-tight text-ink">
        {currency ? <span className="mr-1 text-sm font-medium text-ink-muted">{currency}</span> : null}
        {value}
      </p>

      <div className="mt-auto pt-2">
        {note ? (
          <p
            className={cn(
              'text-[11px] font-medium',
              noteTone === 'danger' ? 'text-red-700' : noteTone === 'warning' ? 'text-amber-700' : 'text-ink-subtle',
            )}
          >
            {note}
          </p>
        ) : deltaLabel ? (
          <p className="text-[11px] text-ink-subtle">{deltaLabel}</p>
        ) : null}

        {href ? (
          <Link
            href={href}
            className="mt-1 inline-flex min-h-8 items-center gap-1 text-[11px] font-medium text-forest-700 hover:underline [@media(pointer:coarse)]:min-h-11"
          >
            {linkLabel ?? 'View details'}
            <ArrowRight className="size-3" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
