import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

/**
 * A dashboard figure. `value` is pre-formatted on the server so no Decimal
 * ever crosses into the client bundle.
 */
export function StatCard({
  label,
  value,
  sublabel,
  icon: Icon,
  tone = 'default',
  href,
  className,
}: {
  label: string;
  value: string;
  sublabel?: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'default' | 'positive' | 'negative' | 'warning';
  href?: string;
  className?: string;
}) {
  const toneClass = {
    default: 'text-ink',
    positive: 'text-emerald-700',
    negative: 'text-red-600',
    warning: 'text-amber-700',
  }[tone];

  const body = (
    <Card
      className={cn(
        'h-full p-4 transition-colors',
        href && 'hover:border-forest-300 hover:bg-forest-50/40',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-ink-muted">{label}</p>
        {Icon ? <Icon className="size-4 shrink-0 text-forest-300" /> : null}
      </div>
      <p className={cn('tnum mt-2 text-lg font-semibold tracking-tight sm:text-xl', toneClass)}>{value}</p>
      {sublabel ? <p className="mt-0.5 text-xs text-ink-subtle">{sublabel}</p> : null}
    </Card>
  );

  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Compact figure used inside detail panels rather than on the dashboard. */
export function Metric({
  label,
  value,
  tone = 'default',
  hint,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'positive' | 'negative' | 'muted';
  hint?: string;
}) {
  const toneClass = {
    default: 'text-ink',
    positive: 'text-emerald-700',
    negative: 'text-red-600',
    muted: 'text-ink-muted',
  }[tone];

  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={cn('tnum mt-0.5 text-sm font-semibold', toneClass)}>{value}</dd>
      {hint ? <p className="text-[11px] text-ink-subtle">{hint}</p> : null}
    </div>
  );
}

export function MetricGrid({ className, ...props }: React.HTMLAttributes<HTMLDListElement>) {
  return <dl className={cn('grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4', className)} {...props} />;
}

/** Label/value row used on record detail pages. */
export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-2 last:border-0">
      <dt className="shrink-0 text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-ink">{children}</dd>
    </div>
  );
}
