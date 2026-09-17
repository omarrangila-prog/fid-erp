'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, Repeat } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { makeRecurringAction } from '@/server/actions/finance-actions';

/**
 * Turn this voucher into one that comes round by itself.
 *
 * Asks for the three things the voucher cannot know: what to call it, how
 * often, and when the next one is due. Everything else — the category, the
 * party, the account, the amount — is taken from the expense on screen.
 */
export function MakeRecurringButton({ expenseId, suggestedName }: { expenseId: string; suggestedName: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Repeat />
        Make recurring
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <MakeRecurringBody expenseId={expenseId} suggestedName={suggestedName} onClose={() => setOpen(false)} />
        ) : null}
      </Dialog>
    </>
  );
}

function MakeRecurringBody({
  expenseId,
  suggestedName,
  onClose,
}: {
  expenseId: string;
  suggestedName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState(suggestedName);
  const [frequency, setFrequency] = React.useState<'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY'>('MONTHLY');
  const [nextDate, setNextDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    if (!name.trim()) return setError('Give it a name — it appears on every draft it produces.');
    if (!nextDate) return setError('Say when the next one is due.');

    startTransition(async () => {
      const result = await makeRecurringAction(
        expenseId,
        JSON.stringify({ name: name.trim(), frequency, nextDate, endDate: endDate || '' }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(result.message ?? 'Recurring expense saved.');
      onClose();
      router.push('/finance/expenses/recurring');
    });
  }

  return (
    <DialogContent
      title="Make this recurring"
      description="On each due date a draft is prepared from this voucher for you to check and post. Nothing posts on its own."
    >
      <form onSubmit={submit} className="space-y-4">
        {error ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Field label="Name" htmlFor="recurringName" required hint="Becomes the reference on each draft.">
          <Input id="recurringName" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="How often" htmlFor="recurringFrequency" required>
          <Select id="recurringFrequency" value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
            <option value="WEEKLY">Every week</option>
            <option value="MONTHLY">Every month</option>
            <option value="QUARTERLY">Every quarter</option>
            <option value="YEARLY">Every year</option>
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Next due" htmlFor="recurringNext" required>
            <Input id="recurringNext" type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
          </Field>
          <Field label="Until" htmlFor="recurringEnd" hint="Optional. Leave blank to run indefinitely.">
            <Input id="recurringEnd" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
