'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { MasterFormSheet, type FieldSpec } from '@/components/shared/master-form';
import {
  deactivateLedgerAccountAction,
  postLedgerOpeningAction,
  reactivateLedgerAccountAction,
  saveLedgerAccountAction,
} from '@/server/actions/master-actions';
import { STATEMENT_GROUP_OPTIONS } from '@/app/(app)/accounting/chart/add-account-button';
import { todayInputValue } from '@/lib/format';
import { ledgerHref } from '@/lib/ledger-currency';
import Link from 'next/link';

export type ChartRowAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
  reportGroup: string | null;
  isSystem: boolean;
  status: string;
  subledgerType: string;
  cashBank: { id: string; currency?: string } | null;
  currency?: string | null;
};

const EDIT_FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'code', label: 'Account code', required: true },
  { kind: 'text', name: 'name', label: 'Account name', required: true },
  {
    kind: 'select',
    name: 'reportGroup',
    label: 'Statement group',
    required: true,
    options: STATEMENT_GROUP_OPTIONS,
  },
];

const SYSTEM_EDIT_FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'name', label: 'Account name', required: true },
  {
    kind: 'select',
    name: 'reportGroup',
    label: 'Statement group',
    required: true,
    options: STATEMENT_GROUP_OPTIONS,
  },
];

export function AccountRowActions({
  account,
  localCurrency,
  defaultLocalRate,
}: {
  account: ChartRowAccount;
  localCurrency: string;
  defaultLocalRate: string;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [openingOpen, setOpeningOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const openingFields: FieldSpec[] = [
    { kind: 'money', name: 'amount', label: 'Opening amount', required: true, currency: localCurrency },
    { kind: 'date', name: 'asOf', label: 'As of', required: true },
    {
      kind: 'select',
      name: 'currency',
      label: 'Currency',
      required: true,
      options: [
        { value: 'USD', label: 'USD' },
        { value: 'AED', label: 'AED' },
        { value: 'MAD', label: 'MAD' },
      ],
    },
    { kind: 'text', name: 'rateToUsd', label: 'Rate to USD', required: true, hint: 'Units of this currency per 1 USD.' },
    { kind: 'text', name: 'rateLocalPerUsd', label: `Rate to ${localCurrency}`, required: true },
  ];

  async function deactivate() {
    if (account.isSystem) return;
    if (!window.confirm(`Deactivate ${account.code} ${account.name}? Existing journals keep it.`)) return;
    setBusy(true);
    const result = await deactivateLedgerAccountAction(account.id);
    setBusy(false);
    if (!result?.ok) {
      toast.error(result && 'error' in result ? result.error : 'Could not deactivate this account.');
      return;
    }
    toast.success(result.message);
    router.refresh();
  }

  async function reactivate() {
    setBusy(true);
    const result = await reactivateLedgerAccountAction(account.id);
    setBusy(false);
    if (!result?.ok) {
      toast.error(result && 'error' in result ? result.error : 'Could not reactivate this account.');
      return;
    }
    toast.success(result.message);
    router.refresh();
  }

  const canOpen =
    account.status === 'ACTIVE' &&
    account.subledgerType !== 'CUSTOMER' &&
    account.subledgerType !== 'VENDOR' &&
    account.subledgerType !== 'AGENT';

  return (
    <div className="flex flex-wrap justify-end gap-1" data-print="hide">
      <Button asChild variant="ghost" size="sm">
        <Link href={ledgerHref(account.id, account.cashBank?.currency ?? account.currency)}>View ledger</Link>
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>
        Edit
      </Button>
      {canOpen ? (
        <Button variant="ghost" size="sm" onClick={() => setOpeningOpen(true)}>
          Opening
        </Button>
      ) : null}
      {account.status === 'INACTIVE' ? (
        <Button variant="ghost" size="sm" onClick={reactivate} disabled={busy}>
          Reactivate
        </Button>
      ) : !account.isSystem && !account.cashBank ? (
        <Button variant="ghost" size="sm" onClick={deactivate} disabled={busy}>
          Deactivate
        </Button>
      ) : null}

      <MasterFormSheet
        open={editOpen}
        onOpenChange={setEditOpen}
        title={account.isSystem ? 'Rename account' : 'Edit account'}
        description={
          account.isSystem
            ? 'System accounts keep their code. The name and statement group can still be corrected.'
            : undefined
        }
        fields={account.isSystem ? SYSTEM_EDIT_FIELDS : EDIT_FIELDS}
        defaults={{
          code: account.code,
          name: account.name,
          reportGroup: account.reportGroup ?? STATEMENT_GROUP_OPTIONS[0].value,
        }}
        action={saveLedgerAccountAction.bind(null, account.id)}
        submitLabel="Save"
      />

      <MasterFormSheet
        open={openingOpen}
        onOpenChange={setOpeningOpen}
        title={`Opening — ${account.code}`}
        description={
          account.cashBank
            ? 'This updates the cash or bank opening. It is not a journal.'
            : 'Posted against Opening Balance Equity so the trial balance still balances.'
        }
        fields={openingFields}
        defaults={{
          asOf: todayInputValue(),
          currency: localCurrency,
          rateToUsd: localCurrency === 'USD' ? '1' : defaultLocalRate,
          rateLocalPerUsd: defaultLocalRate,
        }}
        action={postLedgerOpeningAction.bind(null, account.id)}
        submitLabel="Post opening"
      />
    </div>
  );
}
