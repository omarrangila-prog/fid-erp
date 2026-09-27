'use client';

import * as React from 'react';
import { Field } from '@/components/ui/field';
import { Combobox } from '@/components/ui/combobox';
import type { LedgerSettlementOption } from '@/lib/services/ledger-settlement';

/**
 * The other side of a ledger-to-ledger settlement: a person's account, a loan,
 * the other FID company. Only accounts kept in the voucher's currency (or in
 * any currency) are offered, so the choice can never be refused at Post.
 */
export function LedgerAccountField({
  id,
  options,
  currency,
  value,
  onChange,
  error,
  label = 'Other ledger account',
  hint,
}: {
  id: string;
  options: LedgerSettlementOption[];
  currency: string;
  value: string | null;
  onChange: (value: string | null) => void;
  error?: string;
  label?: string;
  hint?: string;
}) {
  const available = React.useMemo(
    () => options.filter((option) => !option.currency || option.currency.toUpperCase() === currency.toUpperCase()),
    [options, currency],
  );
  return (
    <Field
      label={label}
      htmlFor={id}
      required
      hint={
        hint ??
        (available.length === 0
          ? `No ${currency} ledger account yet — open one in the chart of accounts.`
          : 'No cash or bank moves: the amount is posted to this account instead.')
      }
      error={error}
    >
      <Combobox
        id={id}
        options={available}
        value={value}
        onChange={onChange}
        placeholder="Choose a ledger account…"
        emptyText={`No ${currency} ledger account`}
        invalid={Boolean(error)}
      />
    </Field>
  );
}
