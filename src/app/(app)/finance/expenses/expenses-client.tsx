'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { TRANSACTION_STATUS_META } from '@/lib/constants';
import { VoucherRowActions } from '@/components/shared/voucher-actions';

export type ExpenseRow = {
  id: string;
  number: string;
  date: string;
  dateSort: number;
  category: string;
  description: string | null;
  job: string | null;
  jobId: string | null;
  currency: string;
  amount: string;
  amountSort: number;
  amountUsd: string;
  account: string;
  capitalise: boolean;
  kind: 'SHIPMENT' | 'GENERAL';
  payee: string | null;
  enteredBy: string;
  reference: string | null;
  status: string;
  /** Still owed: show a way to pay it. Already paid: do not. */
  needsPayment: boolean;
  warehouseNames: string;
  /** Null on a draft: nothing is owed until the cost is posted. */
  payment: 'PAID' | 'PARTIAL' | 'UNPAID' | null;
  /** What is left to pay, in the cost's own currency. */
  outstandingLabel: string;
  /** In the company's currency at the cost's own rate, so totals add up across currencies. */
  grossLocal: number;
  paidLocal: number;
  owedLocal: number;
  grossUsd: number;
  paidUsd: number;
  owedUsd: number;
};

const PAYMENT_LABEL = { PAID: 'Paid', PARTIAL: 'Partially paid', UNPAID: 'Unpaid' } as const;
const PAYMENT_TONE = { PAID: 'success', PARTIAL: 'warning', UNPAID: 'danger' } as const;

export function ExpensesClient({
  rows,
  localCurrency,
  canExport,
  emptyAction,
  canPost = false,
  canDelete = false,
}: {
  rows: ExpenseRow[];
  localCurrency: string;
  canExport: boolean;
  /** Rendered inside the empty state; built on the server so permissions are checked there. */
  emptyAction?: React.ReactNode;
  canPost?: boolean;
  canDelete?: boolean;
}) {
  const columns: DataColumn<ExpenseRow>[] = [
    /* The voucher number was the system's own; a cost is known by what it
       was for. The whole row opens the expense. */
    { id: 'category', header: 'Category', mobile: 'title', sortValue: (r) => r.category, exportValue: (r) => r.category, cell: (r) => <span className="font-medium">{r.category}</span> },
    { id: 'date', header: 'Date', mobile: 'meta', sortValue: (r) => r.dateSort, exportValue: (r) => r.date, cell: (r) => r.date },
    {
      id: 'description',
      header: 'Memo',
      mobile: 'meta',
      sortValue: (r) => r.description ?? '',
      exportValue: (r) => r.description ?? '',
      cell: (r) => <span className="text-ink-muted">{r.description ?? '—'}</span>,
    },
    {
      id: 'type',
      header: 'Type',
      mobile: 'badge',
      sortValue: (r) => r.kind,
      exportValue: (r) => (r.kind === 'SHIPMENT' ? 'Shipment' : 'Company'),
      cell: (r) => (
        <Badge tone={r.kind === 'SHIPMENT' ? 'info' : 'neutral'}>
          {r.kind === 'SHIPMENT' ? 'Shipment' : 'Company'}
        </Badge>
      ),
    },
    { id: 'job', header: 'Shipment', mobile: 'meta', exportValue: (r) => r.job ?? '', cell: (r) => r.job ?? '—' },
    {
      id: 'warehouse',
      header: 'Warehouse',
      mobile: 'meta',
      sortValue: (r) => r.warehouseNames,
      exportValue: (r) => r.warehouseNames,
      cell: (r) => r.warehouseNames || '—',
    },
    { id: 'payee', header: 'Payee', hideable: true, exportValue: (r) => r.payee ?? '', cell: (r) => r.payee ?? '—' },
    { id: 'enteredBy', header: 'Entered by', hideable: true, defaultHidden: true, exportValue: (r) => r.enteredBy, cell: (r) => r.enteredBy },
    {
      id: 'amount',
      header: 'Amount',
      numeric: true,
      mobile: 'meta',
      sortValue: (r) => r.amountSort,
      exportValue: (r) => r.amountSort,
      exportType: 'money',
      cell: (r) => (
        <span>
          <span className="block font-medium">{r.amount}</span>
          {r.currency !== 'USD' ? <span className="block text-xs text-ink-subtle">{r.amountUsd}</span> : null}
        </span>
      ),
    },
    {
      id: 'faceValue',
      header: 'Voucher amount',
      hideable: true,
      defaultHidden: true,
      exportValue: (r) => `${r.currency} ${r.amount}`,
      cell: (r) => `${r.currency} ${r.amount}`,
    },
    {
      id: 'treatment',
      header: 'Treatment',
      hideable: true,
      exportValue: (r) => (r.capitalise ? 'Landed cost' : 'Period cost'),
      cell: (r) => (
        <Badge tone={r.capitalise ? 'info' : 'neutral'}>{r.capitalise ? 'Landed cost' : 'Period cost'}</Badge>
      ),
    },
    {
      id: 'payment',
      header: 'Payment',
      mobile: 'badge',
      sortValue: (r) => (r.payment === 'UNPAID' ? 0 : r.payment === 'PARTIAL' ? 1 : r.payment === 'PAID' ? 2 : 3),
      exportValue: (r) => (r.payment ? PAYMENT_LABEL[r.payment] : ''),
      cell: (r) =>
        r.payment ? (
          <Badge tone={PAYMENT_TONE[r.payment]} data-testid="expense-payment">
            {PAYMENT_LABEL[r.payment]}
          </Badge>
        ) : (
          '—'
        ),
    },
    { id: 'account', header: 'Paid from', mobile: 'meta', exportValue: (r) => r.account, cell: (r) => <span className="text-xs">{r.account}</span> },
    {
      id: 'owed',
      header: 'Still to pay',
      numeric: true,
      hideable: true,
      exportValue: (r) => r.outstandingLabel,
      cell: (r) => r.outstandingLabel,
    },
    {
      id: 'costImpact',
      header: 'Shipment cost',
      hideable: true,
      exportValue: (r) => (r.kind === 'SHIPMENT' ? (r.capitalise ? 'In landed cost' : 'On shipment P&L') : 'Not on shipment'),
      cell: (r) =>
        r.kind === 'SHIPMENT' ? (r.capitalise ? 'In landed cost' : 'On shipment P&L') : '—',
    },
    { id: 'reference', header: 'Reference', hideable: true, defaultHidden: true, exportValue: (r) => r.reference ?? '', cell: (r) => r.reference ?? '—' },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      exportValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} meta={TRANSACTION_STATUS_META} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      printHidden: true,
      mobile: 'action',
      pin: 'right',
      cell: (r) => (
        <VoucherRowActions
          kind="expense"
          needsPayment={r.needsPayment}
          id={r.id}
          status={r.status}
          canPost={canPost}
          canDelete={canDelete}
        />
      ),
    },
  ];

  /*
   * Paid and unpaid at a glance, and each figure opens the costs behind it.
   *
   * Every amount is in the company's currency at each cost's own rate, so a
   * MAD bill and a USD bill add up without converting anything at today's
   * rate — total, paid and still owed are exactly additive.
   */
  const [standing, setStanding] = React.useState<'PAID' | 'PARTIAL' | 'UNPAID' | null>(null);
  const posted = rows.filter((r) => r.payment !== null);
  const add = (list: ExpenseRow[], pick: (r: ExpenseRow) => number) => list.reduce((t, r) => t + pick(r), 0);
  const money = (value: number, currency: string) =>
    `${currency} ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const totals = {
    gross: add(posted, (r) => r.grossLocal),
    paid: add(posted, (r) => r.paidLocal),
    owed: add(posted, (r) => r.owedLocal),
    grossUsd: add(posted, (r) => r.grossUsd),
    paidUsd: add(posted, (r) => r.paidUsd),
    owedUsd: add(posted, (r) => r.owedUsd),
  };
  const cards = (['PAID', 'PARTIAL', 'UNPAID'] as const).map((status) => {
    const matching = posted.filter((r) => r.payment === status);
    return {
      status,
      count: matching.length,
      // A paid cost shows what was paid; the others what is still to pay.
      local: status === 'PAID' ? add(matching, (r) => r.paidLocal) : add(matching, (r) => r.owedLocal),
      usd: status === 'PAID' ? add(matching, (r) => r.paidUsd) : add(matching, (r) => r.owedUsd),
      hint: status === 'PAID' ? 'Settled in full' : status === 'PARTIAL' ? 'Some paid, the rest still owed' : 'Nothing paid yet',
    };
  });
  const visible = standing ? rows.filter((r) => r.payment === standing) : rows;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-surface px-4 py-3 text-sm" data-testid="expense-totals">
        <span className="text-ink-muted">All costs </span>
        <span className="tnum font-semibold">{money(totals.gross, localCurrency)}</span>
        <span className="text-ink-muted"> · paid </span>
        <span className="tnum font-semibold text-forest-700">{money(totals.paid, localCurrency)}</span>
        <span className="text-ink-muted"> · still to pay </span>
        <span className="tnum font-semibold text-red-700">{money(totals.owed, localCurrency)}</span>
        {localCurrency !== 'USD' ? (
          <span className="block text-xs text-ink-subtle">
            {money(totals.grossUsd, 'USD')} · paid {money(totals.paidUsd, 'USD')} · still to pay {money(totals.owedUsd, 'USD')} — each at its own rate
          </span>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-3" data-testid="expense-standing">
        {cards.map((card) => {
          const active = standing === card.status;
          return (
            <button
              key={card.status}
              type="button"
              onClick={() => setStanding(active ? null : card.status)}
              aria-pressed={active}
              data-testid={`expense-standing-${card.status.toLowerCase()}`}
              className={cn(
                'rounded-xl border p-4 text-left transition-colors',
                active ? 'border-forest-500 bg-forest-50/60' : 'border-line bg-surface hover:border-forest-300',
              )}
            >
              <p className="text-xs font-medium text-ink-muted">{PAYMENT_LABEL[card.status]}</p>
              <p className="tnum mt-1 text-xl font-semibold text-ink">{money(card.local, localCurrency)}</p>
              <p className="mt-0.5 text-xs text-ink-subtle">
                {card.count === 1 ? '1 cost' : `${card.count} costs`} · {card.status === 'PAID' ? 'paid' : 'still to pay'}
                {localCurrency !== 'USD' ? ` · ${money(card.usd, 'USD')}` : ''}
              </p>
              <p className="mt-1 text-[11px] text-ink-subtle">{active ? 'Showing these — click to clear' : card.hint}</p>
            </button>
          );
        })}
      </div>
      {standing ? (
        <p className="text-xs text-ink-muted" data-testid="expense-standing-active">
          Showing {visible.length === 1 ? 'the 1 cost' : `the ${visible.length} costs`} that {visible.length === 1 ? 'is' : 'are'}{' '}
          {PAYMENT_LABEL[standing].toLowerCase()}.{' '}
          <button type="button" onClick={() => setStanding(null)} className="underline underline-offset-2 hover:text-ink">
            Show every cost
          </button>
        </p>
      ) : null}
    <DataTable
      prefsKey="expenses"
      data={visible}
      filters={[
      { id: 'payment', label: 'Payment', value: (r) => (r.payment ? PAYMENT_LABEL[r.payment] : 'Draft') },
      { id: 'job', label: 'Shipment', value: (r) => r.job ?? 'No shipment' },
      { id: 'status', label: 'Status', value: (r) => r.status },
      { id: 'category', label: 'Category', value: (r) => r.category },
      { id: 'currency', label: 'Currency', value: (r) => r.currency },
      ]}
      columns={columns}
      getRowId={(r) => r.id}
      rowHref={(r) => `/finance/expenses/${r.id}`}
      searchValue={(r) => `${r.number} ${r.category} ${r.job ?? ''} ${r.reference ?? ''} ${r.warehouseNames}`}
      searchPlaceholder="Search voucher, category or job…"
      emptyAction={emptyAction}
      emptyTitle="No expenses yet"
      emptyDescription="Record shipment and operating costs. Direct shipment costs raise the landed cost of the coffee."
      exportFileName={canExport ? 'expenses' : undefined}
      exportTitle="Expense Vouchers"
    />
    </div>
  );
}
