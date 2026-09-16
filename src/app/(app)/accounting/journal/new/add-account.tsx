'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { JOURNAL_ACCOUNT_KINDS } from '@/lib/services/journal-account-kind';
import { quickCreateJournalAccountAction } from '@/server/actions/master-actions';

export type CreatedJournalAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
  currency: string | null;
};

/**
 * Create a ledger head without leaving the journal voucher.
 *
 * The accountant needs "Ahmed" as a current account in the middle of an entry.
 * Leaving the voucher, opening the chart, inventing a code and coming back is
 * the friction this exists to remove. The code is issued on the server.
 */
export function AddJournalAccountDialog({
  open,
  onOpenChange,
  initialName,
  defaultCurrency,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  defaultCurrency: string;
  onCreated: (account: CreatedJournalAccount) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <AddJournalAccountBody
          initialName={initialName}
          defaultCurrency={defaultCurrency}
          onClose={() => onOpenChange(false)}
          onCreated={(account) => {
            onCreated(account);
            onOpenChange(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function AddJournalAccountBody({
  initialName,
  defaultCurrency,
  onClose,
  onCreated,
}: {
  initialName?: string;
  defaultCurrency: string;
  onClose: () => void;
  onCreated: (account: CreatedJournalAccount) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState(initialName ?? '');
  const [kind, setKind] = React.useState('PERSONAL');
  const [currency, setCurrency] = React.useState(defaultCurrency || 'USD');
  const selected = JOURNAL_ACCOUNT_KINDS.find((option) => option.value === kind);

  function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (pending) return;
    setError(null);
    if (!name.trim()) {
      setError('Enter the account name.');
      return;
    }

    startTransition(async () => {
      const result = await quickCreateJournalAccountAction(
        JSON.stringify({ name: name.trim(), kind, currency }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`${result.data.name} added to the chart.`);
      onCreated(result.data);
    });
  }

  return (
    <DialogContent
      title="Add New Account"
      description="Saved to the chart and selected on this voucher immediately. Debits and credits on this head share one ledger."
    >
      <form noValidate onSubmit={submit} className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Field label="Account name" htmlFor="newAccountName" required>
          <Input
            id="newAccountName"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ahmed"
          />
        </Field>

        <Field
          label="Account type"
          htmlFor="newAccountKind"
          required
          hint={selected?.hint}
        >
          <Select id="newAccountKind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {JOURNAL_ACCOUNT_KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Currency"
          htmlFor="newAccountCurrency"
          required
          hint="The currency this ledger is usually kept in. Journals in another currency stay separate."
        >
          <Select id="newAccountCurrency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="USD">USD — US Dollar</option>
            <option value="MAD">MAD — Moroccan Dirham</option>
            <option value="AED">AED — UAE Dirham</option>
          </Select>
        </Field>

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
