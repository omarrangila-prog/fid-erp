'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeftRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Input, MoneyInput, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { todayInputValue } from '@/lib/format';
import { postCashBankTransferAction } from '@/server/actions/finance-actions';

export function TransferFundsButton({
  accounts,
}: {
  accounts: Array<{ accountId: string; name: string; currency: string; accountType: string }>;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <ArrowLeftRight />
        Transfer
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? <TransferFundsBody accounts={accounts} onClose={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function TransferFundsBody({
  accounts,
  onClose,
}: {
  accounts: Array<{ accountId: string; name: string; currency: string; accountType: string }>;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const cash = accounts.find((account) => account.accountType !== 'BANK');
  const bank = accounts.find((account) => account.accountType === 'BANK' && account.currency === cash?.currency);
  const [fromAccountId, setFrom] = React.useState(cash?.accountId ?? accounts[0]?.accountId ?? '');
  const [toAccountId, setTo] = React.useState(
    bank?.accountId ?? accounts.find((account) => account.accountId !== cash?.accountId)?.accountId ?? '',
  );
  const [amount, setAmount] = React.useState('');
  const [receivedAmount, setReceived] = React.useState('');
  const [transferDate, setDate] = React.useState(todayInputValue());
  const [reference, setReference] = React.useState('');

  const from = accounts.find((account) => account.accountId === fromAccountId);
  const destinations = accounts.filter((account) => account.accountId !== fromAccountId);
  const to = accounts.find((account) => account.accountId === toAccountId);
  // Two currencies means a conversion, and the bank decides what arrives.
  const crossCurrency = Boolean(from && to && from.currency !== to.currency);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const result = await postCashBankTransferAction(
        JSON.stringify({
          transferDate,
          fromAccountId,
          toAccountId,
          amount,
          receivedAmount: crossCurrency ? receivedAmount : '',
          reference,
          description: '',
        }),
      );
      if (!result?.ok) {
        setError(result?.error ?? 'The transfer could not be posted.');
        return;
      }
      toast.success(result.message);
      onClose();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogContent
      title="Transfer between cash and bank"
      description="Debit the destination and credit the source. Between two currencies, say what actually arrived — the difference against the book rate is a realised exchange gain or loss."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" required>
          <Select
            value={fromAccountId}
            onChange={(event) => {
              setFrom(event.target.value);
              if (toAccountId === event.target.value) {
                const fallback = accounts.find((account) => account.accountId !== event.target.value);
                setTo(fallback?.accountId ?? '');
              }
            }}
          >
            {accounts.map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {account.name} · {account.currency}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To" required>
          <Select value={toAccountId} onChange={(event) => setTo(event.target.value)}>
            {destinations.map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {account.name} · {account.currency}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date" required>
          <Input type="date" value={transferDate} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <Field label={crossCurrency ? 'Amount sent' : 'Amount'} required>
          <MoneyInput currency={from?.currency ?? 'MAD'} value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>
        {crossCurrency ? (
          <Field
            label="Amount received"
            required
            hint={`What actually landed in ${to?.name ?? 'the destination'}, as the bank credited it.`}
          >
            <MoneyInput
              currency={to?.currency ?? 'MAD'}
              value={receivedAmount}
              onChange={(event) => setReceived(event.target.value)}
            />
          </Field>
        ) : null}
        <Field label="Reference" className="sm:col-span-2">
          <Input value={reference} onChange={(event) => setReference(event.target.value)} />
        </Field>
      </div>
      {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={submit}
          loading={busy}
          disabled={!fromAccountId || !toAccountId || !amount || (crossCurrency && !receivedAmount)}
        >
          Post transfer
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
