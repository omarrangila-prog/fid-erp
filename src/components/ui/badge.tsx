import * as React from 'react';
import { cn } from '@/lib/utils';
import type { BadgeTone } from '@/lib/constants';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-forest-100 text-forest-700 ring-forest-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
  progress: 'bg-amber-50 text-amber-700 ring-amber-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warning: 'bg-orange-50 text-orange-700 ring-orange-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    />
  );
}

/** Renders a status against a metadata map, falling back to a readable label. */
export function StatusBadge({
  status,
  meta,
  className,
}: {
  status: string | null | undefined;
  meta: Record<string, { label: string; tone: BadgeTone }>;
  className?: string;
}) {
  if (!status) return <span className="text-ink-subtle">—</span>;
  const entry = meta[status] ?? { label: status.replaceAll('_', ' '), tone: 'neutral' as BadgeTone };
  return (
    <Badge tone={entry.tone} className={className}>
      {entry.label}
    </Badge>
  );
}
