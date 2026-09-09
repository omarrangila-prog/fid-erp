'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { RefreshCw, CheckCheck, Check, AlertTriangle, Info, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import {
  refreshAlertsAction,
  markNotificationReadAction,
  markAllNotificationsReadAction,
} from '@/server/actions/notification-actions';

export type AlertRow = {
  id: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  createdAt: string;
  dueAt: string | null;
  isRead: boolean;
  href: string | null;
};

const SEVERITY = {
  CRITICAL: { icon: AlertCircle, className: 'text-red-600 bg-red-50 border-red-200', label: 'Critical' },
  WARNING: { icon: AlertTriangle, className: 'text-amber-700 bg-amber-50 border-amber-200', label: 'Warning' },
  INFO: { icon: Info, className: 'text-sky-700 bg-sky-50 border-sky-200', label: 'For information' },
} as const;

export function NotificationsClient({ rows }: { rows: AlertRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [filter, setFilter] = React.useState<'all' | 'unread'>('unread');

  const visible = filter === 'unread' ? rows.filter((r) => !r.isRead) : rows;
  const unreadCount = rows.filter((r) => !r.isRead).length;

  function refresh() {
    startTransition(async () => {
      const result = await refreshAlertsAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        result.data.created > 0
          ? `${result.data.created} new alert${result.data.created === 1 ? '' : 's'}.`
          : 'No new alerts — everything is up to date.',
      );
      router.refresh();
    });
  }

  function markRead(id: string) {
    startTransition(async () => {
      await markNotificationReadAction(id);
      router.refresh();
    });
  }

  function markAll() {
    startTransition(async () => {
      await markAllNotificationsReadAction();
      toast.success('All alerts marked as read.');
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line-strong bg-surface p-0.5">
          {(['unread', 'all'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors',
                filter === value ? 'bg-navy-800 text-white' : 'text-ink-muted hover:text-ink',
              )}
            >
              {value}
              {value === 'unread' && unreadCount > 0 ? ` (${unreadCount})` : ''}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <Button variant="outline" onClick={refresh} loading={pending}>
          <RefreshCw />
          Check now
        </Button>
        {unreadCount > 0 ? (
          <Button variant="subtle" onClick={markAll} disabled={pending}>
            <CheckCheck />
            Mark all read
          </Button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={filter === 'unread' ? 'Nothing needs your attention' : 'No alerts yet'}
          description="Alerts appear when a shipment is approaching its ETA with money still outstanding, when documents are late, or when an invoice goes overdue."
          action={
            <Button variant="outline" onClick={refresh} loading={pending}>
              <RefreshCw />
              Check now
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {visible.map((row) => {
            const meta = SEVERITY[row.severity];
            const Icon = meta.icon;
            const body = (
              <Card className={cn('p-4 transition-colors', !row.isRead && 'border-l-4 border-l-navy-700')}>
                <div className="flex items-start gap-3">
                  <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg border', meta.className)}>
                    <Icon className="size-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <p className={cn('text-sm', row.isRead ? 'text-ink-muted' : 'font-semibold text-ink')}>
                        {row.title}
                      </p>
                      <span className="text-[11px] text-ink-subtle">{row.createdAt}</span>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{row.message}</p>
                  </div>

                  {!row.isRead ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Mark as read"
                      disabled={pending}
                      onClick={(event) => {
                        event.preventDefault();
                        markRead(row.id);
                      }}
                    >
                      <Check />
                    </Button>
                  ) : null}
                </div>
              </Card>
            );

            return row.href ? (
              <Link key={row.id} href={row.href} className="block">
                {body}
              </Link>
            ) : (
              <div key={row.id}>{body}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
