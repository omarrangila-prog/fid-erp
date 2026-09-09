'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Landmark, Check, XCircle, Ban } from 'lucide-react';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Sheet } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { CHEQUE_STATUS_META } from '@/lib/constants';
import { changeChequeStatusAction } from '@/server/actions/finance-actions';

export type ChequeRow = {
  id: string;
  chequeNumber: string;
  direction: string;
  party: string;
  bankName: string;
  chequeDate: string;
  chequeDateSort: number;
  currency: string;
  amount: string;
  amountSort: number;
  status: string;
  depositDate: string;
  clearingDate: string;
  bounceReason: string | null;
  voucherNumber: string | null;
  voucherHref: string | null;
};

/** Which statuses a cheque can move to next, mirroring the service's rules. */
const NEXT: Record<string, Array<{ to: string; label: string; icon: typeof Check; variant: 'accent' | 'outline' | 'danger' }>> = {
  RECEIVED: [
    { to: 'DEPOSITED', label: 'Deposit', icon: Landmark, variant: 'outline' },
    { to: 'CLEARED', label: 'Clear', icon: Check, variant: 'accent' },
    { to: 'BOUNCED', label: 'Bounce', icon: XCircle, variant: 'danger' },
    { to: 'CANCELLED', label: 'Cancel', icon: Ban, variant: 'outline' },
  ],
  DEPOSITED: [
    { to: 'CLEARED', label: 'Clear', icon: Check, variant: 'accent' },
    { to: 'BOUNCED', label: 'Bounce', icon: XCircle, variant: 'danger' },
    { to: 'CANCELLED', label: 'Cancel', icon: Ban, variant: 'outline' },
  ],
  BOUNCED: [{ to: 'DEPOSITED', label: 'Re-deposit', icon: Landmark, variant: 'outline' }],
  CLEARED: [],
  CANCELLED: [],
};

export function ChequesClient({
  rows,
  accounts,
  canManage,
  emptyAction,
}: {
  rows: ChequeRow[];
  accounts: Array<{ id: string; name: string; currency: string }>;
  canManage: boolean;
  /** Rendered inside the empty state; built on the server so permissions are checked there. */
  emptyAction?: React.ReactNode;
}) {
  const router = useRouter();
  const [active, setActive] = React.useState<{ row: ChequeRow; to: string } | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [accountId, setAccountId] = React.useState('');
  const [effectiveDate, setEffectiveDate] = React.useState('');
  const [reason, setReason] = React.useState('');

  function open(row: ChequeRow, to: string) {
    setError(null);
    setReason('');
    setEffectiveDate(new Date().toISOString().slice(0, 10));
    setAccountId(accounts.find((a) => a.currency === row.currency)?.id ?? '');
    setActive({ row, to });
  }

  function submit() {
    if (!active) return;
    setError(null);
    startTransition(async () => {
      const result = await changeChequeStatusAction(
        active.row.id,
        JSON.stringify({ toStatus: active.to, cashBankAccountId: accountId, effectiveDate, reason, notes: '' }),
      );
      if (result?.ok) {
        toast.success(result.message);
        setActive(null);
        router.refresh();
      } else {
        setError(result?.error ?? 'The cheque could not be updated.');
      }
    });
  }

  const columns: DataColumn<ChequeRow>[] = [
    {
      id: 'number',
      header: 'Cheque',
      mobile: 'title',
      sortValue: (r) => r.chequeNumber,
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.chequeNumber}</span>
          <span className="block text-xs text-ink-subtle">{r.bankName}</span>
        </span>
      ),
    },
    {
      id: 'direction',
      header: 'Type',
      hideable: true,
      cell: (r) => (
        <Badge tone={r.direction === 'INBOUND' ? 'success' : 'info'}>
          {r.direction === 'INBOUND' ? 'Received' : 'Issued'}
        </Badge>
      ),
    },
    { id: 'party', header: 'Party', mobile: 'meta', sortValue: (r) => r.party, cell: (r) => r.party },
    { id: 'date', header: 'Cheque date', mobile: 'meta', sortValue: (r) => r.chequeDateSort, cell: (r) => r.chequeDate },
    {
      id: 'amount',
      header: 'Amount',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.amountSort,
      cell: (r) => <span className="font-medium">{r.amount}</span>,
    },
    { id: 'deposited', header: 'Deposited', hideable: true, cell: (r) => r.depositDate },
    { id: 'cleared', header: 'Cleared', hideable: true, cell: (r) => r.clearingDate },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      cell: (r) => (
        <span>
          <StatusBadge status={r.status} meta={CHEQUE_STATUS_META} />
          {r.bounceReason ? <span className="mt-1 block text-xs text-red-600">{r.bounceReason}</span> : null}
        </span>
      ),
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: '',
            cell: (r: ChequeRow) => (
              <span className="flex justify-end gap-1">
                {(NEXT[r.status] ?? []).slice(0, 2).map((step) => {
                  const Icon = step.icon;
                  return (
                    <Button
                      key={step.to}
                      size="sm"
                      variant={step.variant === 'danger' ? 'ghost' : step.variant}
                      onClick={() => open(r, step.to)}
                      className={step.variant === 'danger' ? 'text-red-600 hover:bg-red-50' : undefined}
                    >
                      <Icon />
                      {step.label}
                    </Button>
                  );
                })}
              </span>
            ),
          } satisfies DataColumn<ChequeRow>,
        ]
      : []),
  ];

  const needsAccount = active?.to === 'CLEARED';
  const needsReason = active?.to === 'BOUNCED';

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        searchValue={(r) => `${r.chequeNumber} ${r.party} ${r.bankName}`}
        searchPlaceholder="Search cheque number, party or bank…"
        emptyAction={emptyAction}
        emptyTitle="No cheques recorded"
        emptyDescription="Cheques are created automatically when a receipt or payment uses the cheque method."
      />

      <Sheet
        open={Boolean(active)}
        onOpenChange={(open) => !open && setActive(null)}
        title={active ? `Mark cheque ${active.row.chequeNumber} as ${active.to.toLowerCase()}` : ''}
        description={
          active?.to === 'CLEARED'
            ? 'Clearing is what moves the money into the bank.'
            : active?.to === 'BOUNCED'
              ? 'The amount goes back onto the customer’s account — a bounced cheque is not cash.'
              : active?.to === 'DEPOSITED'
                ? 'Depositing records that the cheque is with the bank. No money moves until it clears.'
                : 'Cancelling reverses the cheque and restores the original balance.'
        }
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setActive(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant={active?.to === 'BOUNCED' ? 'danger' : 'accent'}
              onClick={submit}
              loading={pending}
            >
              Confirm
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}

          <Field label="Effective date" required>
            <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </Field>

          {needsAccount ? (
            <Field
              label="Bank account"
              required
              hint={`Must be a ${active?.row.currency} account.`}
            >
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Choose an account…</option>
                {accounts
                  .filter((a) => a.currency === active?.row.currency)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            </Field>
          ) : null}

          {needsReason ? (
            <Field label="Reason" required hint="Recorded on the cheque and in the audit trail.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Insufficient funds" />
            </Field>
          ) : null}
        </div>
      </Sheet>
    </>
  );
}
