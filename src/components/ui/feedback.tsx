import * as React from 'react';
import { FileQuestion, AlertTriangle, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-forest-100', className)} {...props} />;
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {Array.from({ length: cols }).map((__, c) => (
              <Skeleton key={c} className={cn('h-4', r === 0 && 'bg-forest-200')} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface px-6 py-14 text-center',
        className,
      )}
    >
      <div className="rounded-full bg-forest-50 p-3">
        <Icon className="size-5 text-forest-400" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {description ? <p className="mx-auto max-w-sm text-xs text-ink-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title={title}
      description={description}
      action={action}
      className="border-red-200 bg-red-50/40"
    />
  );
}

export function NotFoundState({ entity }: { entity: string }) {
  return (
    <EmptyState
      icon={FileQuestion}
      title={`${entity} not found`}
      description={`The ${entity.toLowerCase()} you asked for does not exist, or it belongs to a company you cannot access.`}
    />
  );
}

/** Inline callout used above forms for a rule the user needs to know. */
export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning' | 'danger';
  title?: string;
  children: React.ReactNode;
}) {
  const tones = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    danger: 'border-red-200 bg-red-50 text-red-900',
  } as const;

  return (
    <div className={cn('rounded-lg border px-4 py-3 text-xs leading-relaxed', tones[tone])}>
      {title ? <p className="mb-0.5 font-semibold">{title}</p> : null}
      {children}
    </div>
  );
}
