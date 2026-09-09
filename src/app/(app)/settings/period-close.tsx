'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Lock, LockOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Callout } from '@/components/ui/feedback';
import { ConfirmDialog } from '@/components/ui/confirm';
import { setPeriodCloseAction } from '@/server/actions/admin-actions';

/**
 * Closing the books.
 *
 * Deliberately blunt about what it does: after this, nobody — including the
 * person pressing the button — can post into those dates without reopening the
 * period, which is itself audited.
 */
export function PeriodClose({
  closedUntil,
  entriesInPeriod,
  canManage,
}: {
  closedUntil: string | null;
  entriesInPeriod: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [date, setDate] = React.useState(closedUntil ?? '');
  const [confirming, setConfirming] = React.useState<'close' | 'reopen' | null>(null);

  function apply(next: string | null) {
    startTransition(async () => {
      const result = await setPeriodCloseAction(next);
      setConfirming(null);
      if (result.ok) {
        toast.success(next ? `Books closed to ${next}.` : 'Period reopened.');
        router.refresh();
      } else {
        toast.error(result.error ?? 'The period could not be changed.');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounting period</CardTitle>
        <CardDescription>
          Freeze reported months so a back-dated entry cannot quietly change a statement somebody has already acted on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {closedUntil ? (
          <Callout tone="warning" title={`Closed up to ${closedUntil}`}>
            Nothing can be posted on or before this date. {entriesInPeriod.toLocaleString()} posted entr
            {entriesInPeriod === 1 ? 'y is' : 'ies are'} inside the closed period.
          </Callout>
        ) : (
          <Callout tone="info" title="The books are open">
            Every date is currently writable. Once you have reported a month, close it here.
          </Callout>
        )}

        {canManage ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field
              label="Close everything up to and including"
              htmlFor="period-date"
              hint="Usually the last day of a reported month."
              className="sm:max-w-56"
            >
              <Input id="period-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setConfirming('close')} disabled={!date || pending}>
                <Lock />
                Close period
              </Button>
              {closedUntil ? (
                <Button variant="outline" onClick={() => setConfirming('reopen')} disabled={pending}>
                  <LockOpen />
                  Reopen
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-xs text-ink-subtle">
            You do not have permission to close or reopen an accounting period.
          </p>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirming === 'close'}
        onOpenChange={(open) => setConfirming(open ? 'close' : null)}
        title="Close the accounting period?"
        description={`Nothing will be postable on or before ${date}, for anybody, until the period is reopened. This is recorded in the audit trail.`}
        confirmLabel="Close period"
        onConfirm={() => apply(date)}
      />

      <ConfirmDialog
        open={confirming === 'reopen'}
        onOpenChange={(open) => setConfirming(open ? 'reopen' : null)}
        title="Reopen the closed period?"
        description="Back-dated entries will be possible again, which can change statements that have already been reported. This is recorded in the audit trail."
        confirmLabel="Reopen"
        variant="danger"
        onConfirm={() => apply(null)}
      />
    </Card>
  );
}
