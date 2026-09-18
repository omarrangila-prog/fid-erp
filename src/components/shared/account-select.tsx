'use client';

import * as React from 'react';
import { Combobox } from '@/components/ui/combobox';
import {
  AddJournalAccountDialog,
  type CreatedJournalAccount,
} from '@/app/(app)/accounting/journal/new/add-account';

export type LedgerOption = {
  id: string;
  name: string;
  /** Null for a running account that holds whatever currency is used. */
  currency: string | null;
};

/**
 * Who the money is with — chosen from the ledgers, never typed.
 *
 * A name typed into a box is a name, and next month it is typed slightly
 * differently and the same person has two histories. An account is a thing:
 * pick Ahmed and every entry involving Ahmed lands in Ahmed's ledger, this
 * month and next.
 *
 * Somebody who is not on the list yet is not a dead end. Type the name, take
 * "Add New Account" at the bottom, and the ledger is opened and selected
 * without the form being lost — which is the whole reason people type names
 * into boxes instead.
 */
export function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  defaultCurrency,
  placeholder = 'Search or type a name…',
  recentIds = [],
}: {
  id?: string;
  accounts: LedgerOption[];
  value: string;
  onChange: (accountId: string) => void;
  /** The currency a newly created account should default to. */
  defaultCurrency: string;
  placeholder?: string;
  /** Shown first, because the same few names come up all day. */
  recentIds?: string[];
}) {
  const [addOpen, setAddOpen] = React.useState(false);
  const [typedName, setTypedName] = React.useState('');
  const [created, setCreated] = React.useState<LedgerOption[]>([]);

  const all = React.useMemo(() => {
    const seen = new Set(accounts.map((a) => a.id));
    return [...accounts, ...created.filter((a) => !seen.has(a.id))];
  }, [accounts, created]);

  // The handful somebody uses every day, then everybody else.
  const options = React.useMemo(() => {
    const recent = recentIds
      .map((rid) => all.find((a) => a.id === rid))
      .filter((a): a is LedgerOption => Boolean(a));
    const rest = all.filter((a) => !recentIds.includes(a.id));
    return [...recent, ...rest].map((account) => ({
      value: account.id,
      label: account.name,
      hint: account.currency ?? 'any currency',
      keywords: account.name,
    }));
  }, [all, recentIds]);

  return (
    <>
      <Combobox
        id={id}
        options={options}
        value={value}
        onChange={(next) => onChange(next ?? '')}
        placeholder={placeholder}
        emptyText="No account by that name yet"
        createLabel="+ Add New Account"
        onCreate={(query) => {
          setTypedName(query ?? '');
          setAddOpen(true);
        }}
      />

      <AddJournalAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        initialName={typedName}
        defaultCurrency={defaultCurrency}
        onCreated={(account: CreatedJournalAccount) => {
          // Added to the list and selected, with the rest of the form intact.
          setCreated((existing) => [...existing, { id: account.id, name: account.name, currency: account.currency }]);
          onChange(account.id);
          setAddOpen(false);
        }}
      />
    </>
  );
}
