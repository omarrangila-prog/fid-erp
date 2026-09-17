'use client';

import * as React from 'react';
import { MasterFormSheet, type FieldSpec } from '@/components/shared/master-form';
import { postPartyOpeningAction } from '@/server/actions/master-actions';
import type { MasterFormState } from '@/server/actions/master-actions';

/**
 * What a customer or supplier already owed on the day the books started here.
 *
 * This posts a journal entry — receivables or payables on one side, Opening
 * Balance Equity on the other — rather than writing a number onto the party
 * record. The distinction is the whole point: a figure kept on the master
 * would move the customer's statement without moving the general ledger, and
 * the two would disagree from day one.
 *
 * Allowed once per party. Changing an opening balance afterwards is a
 * correction, and a correction belongs in a journal voucher where the reason
 * for it can be read.
 */
export function PartyOpeningSheet({
  party,
  id,
  name,
  currency,
  localCurrency,
  defaultLocalRate,
  open,
  onOpenChange,
}: {
  party: 'CUSTOMER' | 'VENDOR';
  id: string;
  name: string;
  /** The currency this party's account is kept in. */
  currency: string;
  localCurrency: string;
  defaultLocalRate: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fields: FieldSpec[] = [
    {
      kind: 'money',
      name: 'amount',
      label: party === 'CUSTOMER' ? 'Owed to us' : 'Owed by us',
      required: true,
      currency,
      hint: 'The balance outstanding on the date below.',
    },
    {
      kind: 'date',
      name: 'asOf',
      label: 'As of',
      required: true,
      hint: 'The day the books start. The entry is dated here, so earlier periods stay untouched.',
    },
    {
      kind: 'select',
      name: 'currency',
      label: 'Currency',
      required: true,
      options: [...new Set([currency, 'USD', 'MAD', 'AED'])].map((code) => ({ value: code, label: code })),
    },
    {
      kind: 'text',
      name: 'rateToUsd',
      label: 'Rate to USD',
      required: true,
      hint: 'Units of this currency per 1 USD.',
    },
    { kind: 'text', name: 'rateLocalPerUsd', label: `Rate to ${localCurrency}`, required: true },
  ];

  return (
    <MasterFormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Opening balance — ${name}`}
      description="Posted against Opening Balance Equity, so the trial balance still balances."
      fields={fields}
      defaults={{
        asOf: new Date().toISOString().slice(0, 10),
        currency,
        rateToUsd: currency === 'USD' ? '1' : defaultLocalRate,
        rateLocalPerUsd: defaultLocalRate,
      }}
      action={
        postPartyOpeningAction.bind(null, party, id) as (
          p: MasterFormState,
          f: FormData,
        ) => Promise<MasterFormState>
      }
      submitLabel="Post opening balance"
    />
  );
}
