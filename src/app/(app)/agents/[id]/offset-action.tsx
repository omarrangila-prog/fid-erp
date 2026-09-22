'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeftRight } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Textarea, MoneyInput } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Callout } from '@/components/ui/feedback';
import { offsetAgentBalancesAction } from '@/server/actions/finance-actions';
import { todayInputValue } from '@/lib/format';
import { useClientKey } from '@/lib/use-client-key';

/**
 * Settle what he owes the company against what the company owes him.
 *
 * The page shows both balances and their net, but the net is a reading, not
 * an entry: the money he is holding and the money he lent are two accounts,
 * and moving one against the other is a decision. So it is a button someone
 * presses, with an amount and a reason, never something the system does on
 * its own while nobody is looking.
 */
export function AgentOffsetAction({
  agentId,
  agentName,
  localCurrency,
  holdingLocal,
  loanFromAgentLocal,
}: {
  agentId: string;
  agentName: string;
  localCurrency: string;
  holdingLocal: string;
  loanFromAgentLocal: string;
}) {
  const router = useRouter();
  const clientKey = useClientKey();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const holding = Number(holdingLocal);
  const loan = Number(loanFromAgentLocal);
  const most = Math.min(holding, loan);
  const [form, setForm] = React.useState({ date: todayInputValue(), amount: '', reason: '' });

  React.useEffect(() => {
    if (open) setForm({ date: todayInputValue(), amount: most > 0 ? most.toFixed(2) : '', reason: '' });
  }, [open, most]);

  function submit() {
    setError(null);
    if (!form.amount || Number(form.amount) <= 0) {
      setError('Enter the amount to settle against each other.');
      return;
    }
    if (!form.reason.trim()) {
      setError('Say why these balances are being settled against each other.');
      return;
    }
    if (pending) return;
    startTransition(async () => {
      const result = await offsetAgentBalancesAction(JSON.stringify({ clientKey: clientKey(), agentId, ...form }));
      if (!result?.ok) {
        setError(result?.error ?? 'This could not be recorded.');
        return;
      }
      toast.success(result.message);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={most <= 0}
        data-testid="agent-offset-open"
      >
        <ArrowLeftRight />
        Settle against each other
      </Button>

      {open ? (
        <Sheet
          open
          onOpenChange={(next) => !next && setOpen(false)}
          title="Settle the two balances against each other"
          description={`Reduce what ${agentName} owes the company and what the company owes him by the same amount.`}
          width="md"
          footer={
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={submit} loading={pending} data-testid="agent-offset-submit">
                Record it
              </Button>
            </div>
          }
        >
          <div className="space-y-5">
            {error ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date" required>
                <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </Field>
              <Field label="Amount" required hint={`At most ${localCurrency} ${most.toFixed(2)}.`}>
                <MoneyInput
                  currency={localCurrency}
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Memo" required hint="It will be on both sides of the entry and in his ledger.">
              <Textarea
                rows={2}
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="Agreed on the phone: he keeps what he collected against the loan."
              />
            </Field>

            <Callout tone="warning" title="What this posts">
              {agentName} is holding {localCurrency} {holding.toFixed(2)} for the company, and the company owes him{' '}
              {localCurrency} {loan.toFixed(2)}. This debits <strong>Loan from {agentName}</strong> and credits{' '}
              <strong>Agent Clearing</strong>, so both fall by the amount entered. No money moves and no profit changes.
              It is only ever posted when someone asks for it here.
            </Callout>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
