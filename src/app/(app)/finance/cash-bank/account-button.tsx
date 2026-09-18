'use client';

import * as React from 'react';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MasterFormSheet, STATUS_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { saveCashBankAccountAction } from '@/server/actions/master-actions';

const TYPE_OPTIONS = [
  { value: 'BANK', label: 'Bank' },
  { value: 'CASH', label: 'Cash' },
  { value: 'PETTY_CASH', label: 'Petty cash' },
];

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'AED', label: 'AED — UAE Dirham' },
  { value: 'MAD', label: 'MAD — Moroccan Dirham' },
];

const CREATE_FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'name', label: 'Account name', required: true, placeholder: 'AED Bank Account' },
  {
    kind: 'select',
    name: 'accountType',
    label: 'Type',
    required: true,
    options: TYPE_OPTIONS,
  },
  {
    kind: 'select',
    name: 'currency',
    label: 'Currency',
    required: true,
    hint: 'Fixed once the account has postings — changing it would restate history.',
    options: CURRENCY_OPTIONS,
  },
  { kind: 'money', name: 'openingBalance', label: 'Opening balance' },
  { kind: 'text', name: 'bankName', label: 'Bank name' },
  { kind: 'text', name: 'accountNumber', label: 'Account number / IBAN' },
];

const EDIT_FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'name', label: 'Account name', required: true },
  {
    kind: 'select',
    name: 'accountType',
    label: 'Type',
    required: true,
    options: TYPE_OPTIONS,
  },
  {
    kind: 'select',
    name: 'currency',
    label: 'Currency',
    required: true,
    hint: 'Fixed once the account has postings — changing it would restate history.',
    options: CURRENCY_OPTIONS,
  },
  { kind: 'money', name: 'openingBalance', label: 'Opening balance' },
  { kind: 'text', name: 'bankName', label: 'Bank name' },
  { kind: 'text', name: 'accountNumber', label: 'Account number / IBAN' },
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
];

export type CashBankAccountValues = {
  id: string;
  code: string;
  name: string;
  accountType: string;
  currency: string;
  openingBalance: string;
  bankName: string | null;
  accountNumber: string | null;
  status: string;
};

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
        fields={CREATE_FIELDS}
        defaults={{ accountType: 'BANK', currency: 'USD', openingBalance: '0', status: 'ACTIVE' }}
        action={saveCashBankAccountAction.bind(null, null)}
        submitLabel="Create account"
      />
    </>
  );
}

export function EditCashBankAccountButton({ account }: { account: CashBankAccountValues }) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil />
        Edit account
      </Button>
      <MasterFormSheet
        open={open}
        onOpenChange={setOpen}
        title={`Edit ${account.name}`}
        description="Renaming does not change historical receipts or payments posted to this account."
        fields={EDIT_FIELDS}
        defaults={{
          name: account.name,
          accountType: account.accountType,
          currency: account.currency,
          openingBalance: account.openingBalance,
          bankName: account.bankName,
          accountNumber: account.accountNumber,
          status: account.status,
        }}
        action={saveCashBankAccountAction.bind(null, account.id)}
        submitLabel="Save account"
      />
    </>
  );
}
