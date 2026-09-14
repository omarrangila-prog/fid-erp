'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MasterFormSheet, type FieldSpec } from '@/components/shared/master-form';
import { saveLedgerAccountAction } from '@/server/actions/master-actions';

const FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'code', label: 'Account code', required: true, placeholder: '6200' },
  { kind: 'text', name: 'name', label: 'Account name', required: true, placeholder: 'Warehouse rent' },
  {
    kind: 'select',
    name: 'type',
    label: 'Type',
    required: true,
    options: [
      { value: 'ASSET', label: 'Asset' },
      { value: 'LIABILITY', label: 'Liability' },
      { value: 'EQUITY', label: 'Equity' },
      { value: 'INCOME', label: 'Revenue' },
      { value: 'EXPENSE', label: 'Expense' },
    ],
  },
  {
    kind: 'select',
    name: 'reportGroup',
    label: 'Statement group',
    required: true,
    hint: 'Where this head appears on the Profit & Loss or Balance Sheet.',
    options: [
      { value: 'CURRENT_ASSET', label: 'Current asset' },
      { value: 'NON_CURRENT_ASSET', label: 'Non-current asset' },
      { value: 'CURRENT_LIABILITY', label: 'Current liability' },
      { value: 'NON_CURRENT_LIABILITY', label: 'Non-current liability' },
      { value: 'EQUITY', label: 'Equity' },
      { value: 'REVENUE', label: 'Revenue' },
      { value: 'COGS', label: 'Cost of goods sold' },
      { value: 'OPERATING', label: 'Operating expense' },
      { value: 'OTHER_INCOME', label: 'Other income' },
      { value: 'OTHER_EXPENSE', label: 'Other expense' },
    ],
  },
];

export function AddLedgerAccountButton() {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        Add account
      </Button>
      <MasterFormSheet
        open={open}
        onOpenChange={setOpen}
        title="Add ledger account"
        description="A custom head on this company's chart. System accounts such as Accounts Receivable are not replaced."
        fields={FIELDS}
        defaults={{ type: 'EXPENSE', reportGroup: 'OPERATING' }}
        action={saveLedgerAccountAction.bind(null, null)}
        submitLabel="Add to chart"
      />
    </>
  );
}
