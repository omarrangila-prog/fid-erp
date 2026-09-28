'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, MoneyInput, Textarea } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { FormError } from '@/components/shared/form-error';
import { DualText } from '@/components/shared/dual-text';
import { dec, tryDec } from '@/lib/money';
import { formatMoney, todayInputValue } from '@/lib/format';
import { settleUnpaidExpenseAction } from '@/server/actions/finance-actions';

type Equivalent = { text: string; title: string } | null;

export type UnpaidRow = {
  id: string;
  number: string;
  date: string;
  dateIso: string;
  kind: 'Shipment' | 'General';
  shipmentId: string | null;
  shipmentReference: string | null;
  category: string;
  memo: string | null;
  partyKind: 'GENERAL' | 'SUPPLIER' | 'AGENT';
  partyId: string | null;
  partyName: string;
  control: string;
  currency: string;
  rateLocalPerUsd: string;
  gross: string;
  grossEquivalent: Equivalent;
  settled: string;
  outstanding: string;
  outstandingRaw: string;
  outstandingLocalSort: number;
  outstandingEquivalent: Equivalent;
  status: 'UNPAID' | 'PARTIAL' | 'SETTLED';
  statusLabel: string;
  ageDays: number;
  bucket: string;
  history: Array<{
    id: string;
    href: string;
    number: string;
    date: string;
    method: string;
    through: string;
    amount: string;
    memo: string | null;
    by: string | null;
  }>;
};

type AccountOption = { value: string; label: string; currency: string; accountType: string };
type SetOffOption = { value: string; label: string; hint: string; available: string; currency: string };

const STATUS_TONE = { UNPAID: 'danger', PARTIAL: 'warning', SETTLED: 'success' } as const;

export function UnpaidExpensesClient({
  rows,
  localCurrency,
  canSettle,
  initialView,
  openSettleFor,
  accounts,
  setOffSources,
  defaultRates,
}: {
  rows: UnpaidRow[];
  localCurrency: string;
  canSettle: boolean;
  initialView: 'outstanding' | 'settled' | 'all';
  openSettleFor: string | null;
  accounts: AccountOption[];
  setOffSources: Record<string, SetOffOption[]>;
  defaultRates: { local: string; byCurrency: Record<string, string> };
}) {
  const [view, setView] = React.useState(initialView);
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [settling, setSettling] = React.useState<UnpaidRow | null>(
    () => (openSettleFor ? (rows.find((r) => r.id === openSettleFor && r.status !== 'SETTLED') ?? null) : null),
  );

  const shown = rows.filter(
    (r) =>
      (view === 'all' || (view === 'settled' ? r.status === 'SETTLED' : r.status !== 'SETTLED')) &&
      (!from || r.dateIso >= from) &&
      (!to || r.dateIso <= to),
  );

  const columns: DataColumn<UnpaidRow>[] = [
    {
      id: 'date',
      header: 'Date',
      mobile: 'meta',
      sortValue: (r) => r.dateIso,
      exportValue: (r) => r.date,
      cell: (r) => <span className="whitespace-nowrap">{r.date}</span>,
    },
    {
      id: 'shipment',
      header: 'Shipment',
      hideable: true,
      sortValue: (r) => r.shipmentReference ?? '',
      exportValue: (r) => r.shipmentReference ?? r.kind,
      cell: (r) =>
        r.shipmentId ? (
          <Link href={`/shipments/${r.shipmentId}`} className="whitespace-nowrap text-xs font-medium text-forest-800 hover:text-gold-700">
            {r.shipmentReference}
          </Link>
        ) : (
          <span className="text-xs text-ink-subtle">General</span>
        ),
    },
    {
      id: 'category',
      header: 'Category',
      mobile: 'title',
      sortValue: (r) => r.category,
      exportValue: (r) => r.category,
      cell: (r) => (
        <Link href={`/finance/expenses/${r.id}`} className="font-medium text-forest-800 hover:text-gold-700">
          {r.category}
        </Link>
      ),
    },
    {
      id: 'memo',
      header: 'Memo',
      hideable: true,
      exportValue: (r) => r.memo ?? '',
      cell: (r) => <span className="block max-w-64 truncate text-xs text-ink-muted" title={r.memo ?? ''}>{r.memo ?? '—'}</span>,
    },
    {
      id: 'party',
      header: 'Payable to',
      mobile: 'meta',
      sortValue: (r) => r.partyName,
      exportValue: (r) => r.partyName,
      cell: (r) => (
        <span className="block">
          {r.partyKind === 'AGENT' && r.partyId ? (
            <Link href={`/agents/${r.partyId}`} className="font-medium text-forest-800 hover:text-gold-700">
              {r.partyName}
            </Link>
          ) : r.partyKind === 'SUPPLIER' && r.partyId ? (
            <Link href={`/vendors/${r.partyId}`} className="font-medium text-forest-800 hover:text-gold-700">
              {r.partyName}
            </Link>
          ) : (
            <span className="text-ink-muted">{r.partyName}</span>
          )}
          <span className="block text-[11px] text-ink-subtle">{r.control}</span>
        </span>
      ),
    },
    {
      id: 'original',
      header: 'Original amount',
      numeric: true,
      hideable: true,
      exportValue: (r) => r.gross,
      cell: (r) => <DualText primary={r.gross} equivalent={r.grossEquivalent} className="[&>span:first-child]:font-normal" />,
    },
    {
      id: 'settled',
      header: 'Settled',
      numeric: true,
      hideable: true,
      exportValue: (r) => r.settled,
      cell: (r) => <span className="tnum text-ink-muted">{r.settled}</span>,
    },
    {
      id: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      sortValue: (r) => r.outstandingLocalSort,
      exportValue: (r) => r.outstanding,
      cell: (r) => <DualText primary={r.outstanding} equivalent={r.outstandingEquivalent} />,
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'badge',
      sortValue: (r) => r.status,
      exportValue: (r) => r.statusLabel,
      cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.statusLabel}</Badge>,
    },
    {
      id: 'age',
      header: 'Age',
      numeric: true,
      hideable: true,
      sortValue: (r) => r.ageDays,
      exportValue: (r) => r.ageDays,
      cell: (r) => <span className="whitespace-nowrap text-xs text-ink-muted">{r.ageDays} days</span>,
    },
    {
      id: 'actions',
      header: '',
      mobile: 'action',
      printHidden: true,
      cell: (r) =>
        canSettle && r.status !== 'SETTLED' ? (
          <Button size="sm" variant="outline" onClick={() => setSettling(r)} data-testid="settle-expense">
            Settle Expense
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="Which costs">
          {(
            [
              ['outstanding', 'Outstanding'],
              ['settled', 'Settled'],
              ['all', 'All'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
              className={
                view === value
                  ? 'rounded-md bg-forest-800 px-3 py-1.5 text-xs font-medium text-white'
                  : 'rounded-md px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink'
              }
            >
              {label}
            </button>
          ))}
        </div>
        <Field label="From" className="w-40">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" className="w-40">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>

      <DataTable

        share={{ report: 'unpaid-expenses', title: 'Unpaid Expenses' }}
        data={shown}
        columns={columns}
        getRowId={(r) => r.id}
        searchValue={(r) => `${r.number} ${r.category} ${r.memo ?? ''} ${r.partyName} ${r.shipmentReference ?? ''}`}
        searchPlaceholder="Search by expense, party, shipment or memo…"
        filters={[
          { id: 'kind', label: 'Type', value: (r) => r.kind },
          { id: 'status', label: 'Status', value: (r) => r.statusLabel },
          { id: 'shipment', label: 'Shipment', value: (r) => r.shipmentReference },
          { id: 'party', label: 'Party', value: (r) => r.partyName },
          { id: 'category', label: 'Category', value: (r) => r.category },
          { id: 'currency', label: 'Currency', value: (r) => r.currency },
          { id: 'age', label: 'Age', value: (r) => r.bucket },
        ]}
        emptyTitle={view === 'settled' ? 'Nothing settled yet' : 'Nothing unpaid'}
        emptyDescription="A cost booked as Unpaid appears here until it is settled."
        exportFileName="Unpaid Expenses"
        prefsKey="unpaid-expenses"
        expandedContent={(r) => (
          <div className="space-y-2 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">How it was settled</p>
            {r.history.length === 0 ? (
              <p className="text-xs text-ink-muted">Nothing settled yet — the whole amount is still owed.</p>
            ) : (
              <TableWrap className="shadow-none">
                <Table>
                  <THead>
                    <TR className="hover:bg-transparent">
                      <TH>Date</TH>
                      <TH>Method</TH>
                      <TH>Through</TH>
                      <TH numeric>Amount</TH>
                      <TH>Memo</TH>
                      <TH>By</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {r.history.map((h) => (
                      <TR key={h.id}>
                        <TD className="whitespace-nowrap text-xs">{h.date}</TD>
                        <TD className="text-xs font-medium">{h.method}</TD>
                        <TD className="text-xs">
                          <Link href={h.href} className="text-forest-800 hover:text-gold-700">
                            {h.through}
                          </Link>
                        </TD>
                        <TD numeric>{h.amount}</TD>
                        <TD className="text-xs text-ink-muted">{h.memo ?? '—'}</TD>
                        <TD className="text-xs text-ink-muted">{h.by ?? '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrap>
            )}
          </div>
        )}
      />

      {settling ? (
        <SettleDialog
          key={settling.id}
          row={settling}
          localCurrency={localCurrency}
          accounts={accounts.filter((a) => a.currency === settling.currency)}
          sources={(setOffSources[settling.currency] ?? []).filter(
            (s) => settling.partyKind !== 'AGENT' || s.value === `agent:${settling.partyId}`,
          )}
          defaultRate={
            settling.currency === 'USD' ? defaultRates.local : (defaultRates.byCurrency[settling.currency] ?? defaultRates.local)
          }
          onClose={() => setSettling(null)}
        />
      ) : null}
    </div>
  );
}

function SettleDialog({
  row,
  localCurrency,
  accounts,
  sources,
  defaultRate,
  onClose,
}: {
  row: UnpaidRow;
  localCurrency: string;
  accounts: AccountOption[];
  sources: SetOffOption[];
  defaultRate: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [date, setDate] = React.useState('');
  const [method, setMethod] = React.useState<'CASH' | 'BANK' | 'CHEQUE' | 'SET_OFF'>('CASH');
  const [amount, setAmount] = React.useState(row.outstandingRaw);
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [against, setAgainst] = React.useState<string | null>(sources.length === 1 ? sources[0].value : null);
  const [chequeNumber, setChequeNumber] = React.useState('');
  const [chequeDate, setChequeDate] = React.useState('');
  const [bankName, setBankName] = React.useState('');
  const [beneficiary, setBeneficiary] = React.useState(row.partyKind === 'GENERAL' ? '' : row.partyName);
  const [rate, setRate] = React.useState(defaultRate);
  const [memo, setMemo] = React.useState('');

  const agentOwed = row.partyKind === 'AGENT';
  const usd = row.currency === 'USD';
  const drawers = accounts.filter((a) =>
    method === 'CASH' ? a.accountType === 'CASH' || a.accountType === 'PETTY_CASH' : a.accountType === 'BANK',
  );
  const source = sources.find((s) => s.value === against) ?? null;
  const amountDec = tryDec(amount);
  const outstanding = dec(row.outstandingRaw);

  function submit() {
    setError(null);
    if (!date) return setError('Enter the date the cost was actually settled.');
    if (amountDec.lessThanOrEqualTo(0)) return setError('Enter an amount greater than zero.');
    if (amountDec.greaterThan(outstanding)) return setError(`No more than ${row.outstanding} is still owed.`);
    if ((method === 'CASH' || method === 'BANK') && !accountId) return setError('Choose the account the money left from.');
    if (method === 'SET_OFF' && !against) return setError('Choose the balance to set this off against.');
    if (method === 'SET_OFF' && source && amountDec.greaterThan(dec(source.available))) {
      return setError(`${source.label} has only ${formatMoney(source.available, row.currency)} available.`);
    }
    const payload = {
      expenseId: row.id,
      settlementDate: date,
      method,
      amount,
      rateToUsd: usd ? '1' : rate,
      rateLocalPerUsd: usd ? rate : row.currency === localCurrency ? rate : row.rateLocalPerUsd,
      cashBankAccountId: method === 'SET_OFF' ? '' : (accountId ?? ''),
      cheque:
        method === 'CHEQUE'
          ? { chequeNumber, chequeDate: chequeDate || date, bankName, beneficiary }
          : null,
      setOffAgainst: method === 'SET_OFF' ? against : null,
      memo,
    };
    startTransition(async () => {
      const result = await settleUnpaidExpenseAction(JSON.stringify(payload));
      if (!result || !result.ok) {
        setError(result && !result.ok ? result.error : 'The settlement could not be posted.');
        return;
      }
      toast.success(method === 'SET_OFF' ? 'Adjustment posted.' : 'Settlement posted.');
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Settle unpaid expense" description={`${row.category} · ${row.partyName}`}>
        <div className="space-y-4" data-testid="settle-dialog">
          <dl className="grid grid-cols-3 gap-3 rounded-lg bg-surface-sunken/60 p-3 text-xs">
            <div>
              <dt className="text-ink-muted">Original</dt>
              <dd className="tnum font-medium">{row.gross}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Already settled</dt>
              <dd className="tnum font-medium">{row.settled}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Outstanding</dt>
              <dd className="tnum font-semibold text-red-700">{row.outstanding}</dd>
            </div>
            <div className="col-span-3 text-ink-muted">
              {row.shipmentReference ? `Shipment ${row.shipmentReference}` : 'General expense'} · recorded under {row.control}
            </div>
          </dl>

          <Field label="Settlement date" htmlFor="settleDate" required hint="The day the money actually left, or the set-off was agreed.">
            <div className="flex gap-2">
              <Input id="settleDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => setDate(todayInputValue())}>
                Today
              </Button>
            </div>
          </Field>

          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-ink">Settlement method</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(
                [
                  ['CASH', 'Cash'],
                  ['BANK', 'Bank'],
                  ['CHEQUE', 'Cheque'],
                  ['SET_OFF', 'Ledger adjustment / set-off'],
                ] as const
              ).map(([value, label]) => {
                const disabled = value === 'CHEQUE' && agentOwed;
                return (
                  <label
                    key={value}
                    className={
                      method === value
                        ? 'flex cursor-pointer items-center gap-2 rounded-lg border-2 border-forest-500 bg-forest-50/60 px-3 py-2 text-xs font-medium'
                        : `flex items-center gap-2 rounded-lg border-2 border-line px-3 py-2 text-xs ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-forest-300'}`
                    }
                    title={disabled ? 'An agent is paid by cash or bank, or set off against what he holds.' : undefined}
                  >
                    <input
                      type="radio"
                      name="settleMethod"
                      value={value}
                      checked={method === value}
                      disabled={disabled}
                      onChange={() => {
                        setMethod(value);
                        setAccountId(null);
                      }}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </fieldset>

          {method === 'CASH' || method === 'BANK' || method === 'CHEQUE' ? (
            <Field
              label={method === 'CASH' ? 'Cash account' : method === 'CHEQUE' ? 'Bank the cheque is drawn on' : 'Bank account'}
              htmlFor="settleAccount"
              required={method !== 'CHEQUE'}
              hint={drawers.length === 0 ? `No ${row.currency} ${method === 'CASH' ? 'cash' : 'bank'} account exists.` : `Only ${row.currency} accounts are shown.`}
            >
              <Combobox
                id="settleAccount"
                options={drawers.map((a) => ({ value: a.value, label: a.label, hint: a.currency }))}
                value={accountId}
                onChange={(value) => {
                  setAccountId(value);
                  if (method === 'CHEQUE' && value && !bankName) setBankName(drawers.find((d) => d.value === value)?.label ?? '');
                }}
                placeholder="Choose an account…"
              />
            </Field>
          ) : null}

          {method === 'CHEQUE' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Cheque number" htmlFor="chequeNumber" required>
                <Input id="chequeNumber" value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} />
              </Field>
              <Field label="Cheque date" htmlFor="chequeDate" hint="Blank means the settlement date.">
                <Input id="chequeDate" type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} />
              </Field>
              <Field label="Drawn on (bank name)" htmlFor="chequeBank" required>
                <Input id="chequeBank" value={bankName} onChange={(e) => setBankName(e.target.value)} />
              </Field>
              <Field label="Made out to" htmlFor="chequeBeneficiary" required={row.partyKind === 'GENERAL'}>
                <Input id="chequeBeneficiary" value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} />
              </Field>
            </div>
          ) : null}

          {method === 'SET_OFF' ? (
            <div className="space-y-3 rounded-lg border border-line p-3">
              <Field
                label="Adjust against"
                htmlFor="setOffAgainst"
                required
                hint={
                  sources.length === 0
                    ? agentOwed
                      ? `${row.partyName} holds nothing for FID in ${row.currency}.`
                      : `No balance owed to FID in ${row.currency} to set off against.`
                    : 'A balance this party owes FID. Nothing moves in cash or bank.'
                }
              >
                <Combobox
                  id="setOffAgainst"
                  options={sources.map((s) => ({
                    value: s.value,
                    label: s.label,
                    hint: `${formatMoney(s.available, s.currency)} available`,
                  }))}
                  value={against}
                  onChange={setAgainst}
                  placeholder="Choose the balance…"
                />
              </Field>
              {source ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs" data-testid="setoff-preview">
                  <dt className="text-ink-muted">Expense outstanding after</dt>
                  <dd className="tnum text-right font-medium">
                    {formatMoney(Decimal_max(outstanding.minus(amountDec), dec(0)), row.currency)}
                  </dd>
                  <dt className="text-ink-muted">{source.label} remaining</dt>
                  <dd className="tnum text-right font-medium">
                    {formatMoney(Decimal_max(dec(source.available).minus(amountDec), dec(0)), row.currency)}
                  </dd>
                  <dt className="text-ink-muted">Cash impact</dt>
                  <dd className="tnum text-right">{formatMoney(0, row.currency)}</dd>
                  <dt className="text-ink-muted">Bank impact</dt>
                  <dd className="tnum text-right">{formatMoney(0, row.currency)}</dd>
                </dl>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount" htmlFor="settleAmount" required hint={`Up to ${row.outstanding}. Less leaves the rest outstanding.`}>
              <MoneyInput id="settleAmount" currency={row.currency} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field
              label={usd ? `Rate (${localCurrency} per 1 USD)` : `Rate (${row.currency} per 1 USD)`}
              htmlFor="settleRate"
              required
              hint="The rate on the settlement date. The cost keeps its own."
            >
              <Input id="settleRate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
            </Field>
          </div>

          <Field label="Memo" htmlFor="settleMemo">
            <Textarea id="settleMemo" rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
          </Field>

          <FormError message={error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending} data-testid="post-settlement">
            {method === 'SET_OFF' ? 'Post adjustment' : 'Post settlement'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const Decimal_max = (a: ReturnType<typeof dec>, b: ReturnType<typeof dec>) => (a.greaterThan(b) ? a : b);
