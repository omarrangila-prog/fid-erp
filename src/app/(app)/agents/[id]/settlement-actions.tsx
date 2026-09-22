'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, Banknote, HandCoins } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea, MoneyInput } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Callout } from '@/components/ui/feedback';
import { recordAgentSettlementAction } from '@/server/actions/finance-actions';
import { todayInputValue } from '@/lib/format';
import { useClientKey } from '@/lib/use-client-key';

type Account = { id: string; name: string; code: string; currency: string };

/**
 * The two things that actually move money between the company and an agent:
 * he hands over what he collected, or he is paid the commission he was owed.
 *
 * Both are a single action. A settlement saved as a draft would leave the
 * agent still appearing to hold money he has already handed over, and there is
 * no reason anyone would want that half-state.
 */
export function AgentSettlementActions({
  agentId,
  agentName,
  accounts,
  localCurrency,
  defaultLocalRate,
  holdingUsd,
  holdingLocal,
  commissionPayableUsd,
}: {
  agentId: string;
  agentName: string;
  accounts: Account[];
  localCurrency: string;
  defaultLocalRate: string;
  holdingUsd: string;
  holdingLocal: string;
  commissionPayableUsd: string;
}) {
  const [open, setOpen] = React.useState<'COLLECTION' | 'COMMISSION' | null>(null);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen('COLLECTION')} data-testid="agent-received-open">
        <HandCoins />
        Received from agent
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen('COMMISSION')}
        disabled={Number(commissionPayableUsd) <= 0}
      >
        <Banknote />
        Pay commission
      </Button>

      {open ? (
        <SettlementSheet
          key={open}
          direction={open}
          agentId={agentId}
          agentName={agentName}
          accounts={accounts}
          localCurrency={localCurrency}
          defaultLocalRate={defaultLocalRate}
          limitUsd={open === 'COLLECTION' ? holdingUsd : commissionPayableUsd}
          holdingLocal={holdingLocal}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

function SettlementSheet({
  direction,
  agentId,
  agentName,
  accounts,
  localCurrency,
  defaultLocalRate,
  limitUsd,
  holdingLocal,
  onClose,
}: {
  direction: 'COLLECTION' | 'COMMISSION';
  agentId: string;
  agentName: string;
  accounts: Account[];
  localCurrency: string;
  defaultLocalRate: string;
  limitUsd: string;
  holdingLocal: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const clientKey = useClientKey();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const collecting = direction === 'COLLECTION';
  const [form, setForm] = React.useState({
    settlementDate: todayInputValue(),
    cashBankAccountId: '',
    currency: localCurrency,
    amount: '',
    rateToUsd: localCurrency === 'USD' ? '1' : defaultLocalRate,
    rateLocalPerUsd: defaultLocalRate,
    reference: '',
    notes: '',
    excess: '' as '' | 'LOAN',
  });

  const set = (patch: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...patch }));
  const options = accounts.filter((a) => a.currency === form.currency);

  /*
   * What he is holding, in the currency he is handing over, so the form can
   * tell the two parts of the money apart before anything is posted.
   */
  const holding =
    form.currency === 'USD'
      ? Number(limitUsd)
      : form.currency === localCurrency
        ? Number(holdingLocal)
        : Number(limitUsd) * (Number(form.rateToUsd) || 0);
  const entered = Number(form.amount) || 0;
  const excessAmount = collecting ? Math.max(0, entered - holding) : 0;
  const mustClassify = excessAmount > 0.005;

  function submit() {
    setError(null);

    if (!form.cashBankAccountId) {
      setError(
        collecting
          ? 'Choose the account the money was paid into.'
          : 'Choose the account the commission was paid from.',
      );
      return;
    }
    if (!form.amount || Number(form.amount) <= 0) {
      setError('Enter the amount.');
      return;
    }
    if (mustClassify && form.excess !== 'LOAN') {
      setError(
        `${agentName} is holding ${form.currency} ${holding.toFixed(2)}. Say what the extra ${form.currency} ` +
          `${excessAmount.toFixed(2)} is before this is recorded.`,
      );
      return;
    }

    if (pending) return;
    startTransition(async () => {
      const result = await recordAgentSettlementAction(
        JSON.stringify({
          clientKey: clientKey(),
          agentId,
          direction,
          ...form,
          excess: mustClassify ? form.excess : null,
        }),
      );
      if (!result?.ok) {
        setError(result?.error ?? 'This could not be recorded.');
        return;
      }
      toast.success(result.message);
      onClose();
      router.refresh();
    });
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => !next && onClose()}
      title={collecting ? 'Received from agent' : 'Pay commission'}
      description={
        collecting
          ? `${agentName} has handed over money collected from customers.`
          : `Pay ${agentName} commission already charged to the shipments.`
      }
      width="md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {collecting ? 'Record money received' : 'Record commission paid'}
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
            <Input
              type="date"
              value={form.settlementDate}
              onChange={(e) => set({ settlementDate: e.target.value })}
            />
          </Field>

          <Field label="Currency" required>
            <Select
              value={form.currency}
              onChange={(e) =>
                set({
                  currency: e.target.value,
                  cashBankAccountId: '',
                  rateToUsd: e.target.value === 'USD' ? '1' : defaultLocalRate,
                })
              }
            >
              <option value="USD">USD — US Dollar</option>
              <option value="AED">AED — UAE Dirham</option>
              <option value="MAD">MAD — Moroccan Dirham</option>
            </Select>
          </Field>

          <Field
            label={collecting ? 'Paid into' : 'Paid from'}
            required
            hint={`Only ${form.currency} accounts are shown.`}
          >
            <Select
              value={form.cashBankAccountId}
              onChange={(e) => set({ cashBankAccountId: e.target.value })}
            >
              <option value="">Choose an account…</option>
              {options.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Amount" required>
            <MoneyInput
              currency={form.currency}
              value={form.amount}
              onChange={(e) => set({ amount: e.target.value })}
            />
          </Field>

          {form.currency !== 'USD' ? (
            <Field label={`Rate (${form.currency} per USD)`} required>
              <Input value={form.rateToUsd} onChange={(e) => set({ rateToUsd: e.target.value })} className="tnum" />
            </Field>
          ) : null}

          <Field label="Reference">
            <Input value={form.reference} onChange={(e) => set({ reference: e.target.value })} />
          </Field>
        </div>

        <Field label="Memo">
          <Textarea rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>

        {mustClassify ? (
          <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3" data-testid="excess-choice">
            <p className="text-xs text-amber-900">
              {agentName} is holding <strong>{form.currency} {holding.toFixed(2)}</strong> of the company&rsquo;s money,
              and this hand-over is {form.currency} {entered.toFixed(2)}. The extra{' '}
              <strong>{form.currency} {excessAmount.toFixed(2)}</strong> is not a collection — say what it is. The
              system will not decide it, because the wrong guess puts the amount in the wrong account for good.
            </p>
            <label className="flex items-start gap-2 text-xs text-amber-900">
              <input
                type="radio"
                name="excess"
                className="mt-0.5"
                checked={form.excess === 'LOAN'}
                onChange={() => set({ excess: 'LOAN' })}
                data-testid="excess-loan"
              />
              <span>
                It is his own money, lent to the company. The extra is posted as{' '}
                <strong>Loan from {agentName}</strong>, a liability, and the company owes it back to him.
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-amber-900">
              <input
                type="radio"
                name="excess"
                className="mt-0.5"
                checked={form.excess === ''}
                onChange={() => set({ excess: '' })}
                data-testid="excess-none"
              />
              <span>Neither — the amount is wrong. Change it above; nothing will be recorded until this is settled.</span>
            </label>
          </div>
        ) : null}

        <Callout tone="info">
          {collecting ? (
            <>
              {agentName} is holding <strong>{form.currency} {holding.toFixed(2)}</strong>
              {form.currency === 'USD' ? null : <> (USD {Number(limitUsd).toFixed(2)})</>}. Up to that, this settles
              what he collected for the company. Anything beyond it is his own money and has to be classified before it
              is recorded.
            </>
          ) : (
            <>
              <strong>USD {Number(limitUsd).toFixed(2)}</strong> of commission is outstanding. It has already been
              charged to the shipments it belongs to, so paying it moves money without changing any profit.
            </>
          )}
        </Callout>
      </div>
    </Sheet>
  );
}
