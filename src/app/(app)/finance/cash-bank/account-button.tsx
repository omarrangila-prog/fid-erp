'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MasterFormSheet, type FieldSpec } from '@/components/shared/master-form';
import { saveCashBankAccountAction } from '@/server/actions/master-actions';

const FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'code', label: 'Account code', required: true, placeholder: 'DXB-BANK-AED' },
  { kind: 'text', name: 'name', label: 'Account name', required: true, placeholder: 'AED Bank Account' },
  {
    kind: 'select',
    name: 'accountType',
    label: 'Type',
    required: true,
    options: [
      { value: 'BANK', label: 'Bank' },
      { value: 'CASH', label: 'Cash' },
      { value: 'PETTY_CASH', label: 'Petty cash' },
    ],
  },
  {
    kind: 'select',
    name: 'currency',
    label: 'Currency',
    required: true,
    hint: 'Fixed once the account has postings — changing it would restate history.',
    options: [
      { value: 'USD', label: 'USD — US Dollar' },
      { value: 'AED', label: 'AED — UAE Dirham' },
      { value: 'MAD', label: 'MAD — Moroccan Dirham' },
    ],
  },
  { kind: 'money', name: 'openingBalance', label: 'Opening balance' },
  { kind: 'text', name: 'bankName', label: 'Bank name' },
  { kind: 'text', name: 'accountNumber', label: 'Account number / IBAN' },
];

export function CashBankAccountButton() {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        <span className="hidden sm:inline">New account</span>
        <span className="sm:hidden">New</span>
      </Button>
      <MasterFormSheet
        open={open}
        onOpenChange={setOpen}
        title="New cash or bank account"
        description="A backing general ledger account is created automatically."
        fields={FIELDS}
        defaults={{ accountType: 'BANK', currency: 'USD', openingBalance: '0' }}
        action={saveCashBankAccountAction.bind(null, null)}
        submitLabel="Create account"
      />
    </>
  );
}
