'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, MoneyInput, Select } from '@/components/ui/input';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormError } from '@/components/shared/form-error';
import { tryDec } from '@/lib/money';
import { formatMoney } from '@/lib/format';
import { transactionCurrencies } from '@/lib/company-currencies';
import { postJournalVoucherAction } from '@/server/actions/finance-actions';
import { AddJournalAccountDialog, type CreatedJournalAccount } from '@/app/(app)/accounting/journal/new/add-account';

/**
 * General Entry — one debit, one credit, and the books do the rest.
 *
 * Most direct entries are two accounts and an amount: a cost paid from the
 * drawer, a loan landing in the bank, one balance set against another. Choose
 * what kind of entry it is and the form asks for the two sides in those words
 * ("Paid from", "Loan from"), offers only the accounts that fit, and shows the
 * debit and credit it will post before anything is written. Customers,
 * suppliers and agents are chosen by name and post to their own balances.
 * Anything with more than two lines is the Advanced journal.
 */

export type EntryOption = ComboOption & {
  group: string;
  /** The ledger account the line posts to. */
  accountId: string;
  customerId?: string;
  vendorId?: string;
  agentId?: string;
  /** The currencies it may carry; null takes any. */
  currencies: string[] | null;
  /** A cash or bank drawer: the entry moves money. */
  cash: boolean;
};

type Side = { label: string; groups: string[] | 'ANY' | 'NON_CASH' };
type EntryType = { id: string; label: string; hint: string; debit: Side; credit: Side };

const ALL_BUT_CASH = ['Customers', 'Suppliers', 'Agents', 'Loans & related parties', 'Expenses', 'Revenue', 'Owner & equity', 'Other assets', 'Other liabilities'];

const TYPES: EntryType[] = [
  { id: 'GENERAL', label: 'General entry', hint: 'Any two accounts.', debit: { label: 'Debit account', groups: 'ANY' }, credit: { label: 'Credit account', groups: 'ANY' } },
  { id: 'EXPENSE', label: 'Expense', hint: 'A cost paid from cash or a bank.', debit: { label: 'Expense account', groups: ['Expenses'] }, credit: { label: 'Paid from', groups: ['Cash & Bank'] } },
  { id: 'RECEIVED', label: 'Money received', hint: 'Money into cash or a bank.', debit: { label: 'Received into', groups: ['Cash & Bank'] }, credit: { label: 'Received from', groups: ALL_BUT_CASH } },
  { id: 'PAID', label: 'Money paid', hint: 'Money out of cash or a bank.', debit: { label: 'Paid to', groups: ALL_BUT_CASH }, credit: { label: 'Paid from', groups: ['Cash & Bank'] } },
  { id: 'TRANSFER', label: 'Transfer', hint: 'Between your own cash and bank accounts. No income, no cost.', debit: { label: 'Transfer to', groups: ['Cash & Bank'] }, credit: { label: 'Transfer from', groups: ['Cash & Bank'] } },
  { id: 'LOAN_RECEIVED', label: 'Loan received', hint: 'Somebody lent FID money.', debit: { label: 'Received into', groups: ['Cash & Bank'] }, credit: { label: 'Loan from', groups: ['Loans & related parties', 'Agents', 'Other liabilities'] } },
  { id: 'LOAN_GIVEN', label: 'Loan given', hint: 'FID lent somebody money.', debit: { label: 'Loan given to', groups: ['Loans & related parties', 'Agents', 'Other assets'] }, credit: { label: 'Paid from', groups: ['Cash & Bank'] } },
  { id: 'LOAN_REPAYMENT', label: 'Loan repayment', hint: 'FID repaying a loan it took.', debit: { label: 'Loan repaid to', groups: ['Loans & related parties', 'Agents', 'Other liabilities'] }, credit: { label: 'Paid from', groups: ['Cash & Bank'] } },
  { id: 'AGENT', label: 'Agent adjustment', hint: 'Between an agent’s balances. No cash moves.', debit: { label: 'Debit', groups: ['Agents', 'Loans & related parties', 'Expenses'] }, credit: { label: 'Credit', groups: ['Agents', 'Loans & related parties', 'Revenue'] } },
  { id: 'ADJUSTMENT', label: 'Ledger adjustment', hint: 'One balance set against another. No cash or bank moves.', debit: { label: 'Debit (increase / reduce a liability)', groups: 'NON_CASH' }, credit: { label: 'Credit (reduce / increase a liability)', groups: 'NON_CASH' } },
  { id: 'OWNER', label: 'Owner funding', hint: 'The owner putting money into the business.', debit: { label: 'Received into', groups: ['Cash & Bank'] }, credit: { label: 'Owner / capital account', groups: ['Owner & equity', 'Loans & related parties'] } },
];

export function SimpleEntryForm({
  options: initialOptions,
  localCurrency,
  defaultLocalRate,
  ratesByCurrency,
  today,
}: {
  options: EntryOption[];
  localCurrency: string;
  defaultLocalRate: string;
  ratesByCurrency: Record<string, string>;
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [options, setOptions] = React.useState(initialOptions);
  const [typeId, setTypeId] = React.useState('GENERAL');
  const [date, setDate] = React.useState(today);
  const [debit, setDebit] = React.useState<string | null>(null);
  const [credit, setCredit] = React.useState<string | null>(null);
  const [amount, setAmount] = React.useState('');
  const [currency, setCurrency] = React.useState(localCurrency);
  const [rate, setRate] = React.useState(localCurrency === 'USD' ? defaultLocalRate : (ratesByCurrency[localCurrency] ?? defaultLocalRate));
  const [reference, setReference] = React.useState('');
  const [memo, setMemo] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState<{ side: 'debit' | 'credit'; name: string } | null>(null);
  const clientKey = React.useRef<string>(crypto.randomUUID());

  const type = TYPES.find((t) => t.id === typeId)!;
  const fits = (side: Side) => (o: EntryOption) =>
    (side.groups === 'ANY' || (side.groups === 'NON_CASH' ? !o.cash : side.groups.includes(o.group))) &&
    (!o.currencies || o.currencies.includes(currency));
  const debitOptions = options.filter(fits(type.debit));
  const creditOptions = options.filter(fits(type.credit));
  const debitChoice = options.find((o) => o.value === debit) ?? null;
  const creditChoice = options.find((o) => o.value === credit) ?? null;
  const value = tryDec(amount);
  const moneyMoves = Boolean(debitChoice?.cash || creditChoice?.cash);

  function onCreated(account: CreatedJournalAccount) {
    const option: EntryOption = {
      value: account.id,
      label: account.name,
      hint: account.currency ?? account.type.toLowerCase(),
      keywords: `${account.code} ${account.name}`,
      group: account.type === 'EXPENSE' ? 'Expenses' : account.type === 'INCOME' ? 'Revenue' : account.type === 'EQUITY' ? 'Owner & equity' : account.type === 'ASSET' ? 'Other assets' : 'Other liabilities',
      accountId: account.id,
      currencies: account.currency ? [account.currency] : null,
      cash: false,
    };
    setOptions((prev) => [...prev, option]);
    if (adding?.side === 'debit') setDebit(option.value);
    else setCredit(option.value);
    setAdding(null);
  }

  function chooseCurrency(next: string) {
    setCurrency(next);
    setRate(next === 'USD' ? defaultLocalRate : (ratesByCurrency[next] ?? defaultLocalRate));
    // A drawer holds one currency: a choice that no longer fits is let go.
    if (debitChoice?.currencies && !debitChoice.currencies.includes(next)) setDebit(null);
    if (creditChoice?.currencies && !creditChoice.currencies.includes(next)) setCredit(null);
  }

  function submit() {
    setError(null);
    if (!debitChoice || !creditChoice) return setError(`Choose both sides: ${type.debit.label} and ${type.credit.label}.`);
    if (debitChoice.value === creditChoice.value) return setError('The two sides must be different accounts.');
    if (value.lessThanOrEqualTo(0)) return setError('Enter an amount greater than zero.');
    if (!date) return setError('Enter the date of the entry.');
    const usd = currency === 'USD';
    const line = (o: EntryOption, direction: 'DEBIT' | 'CREDIT') => ({
      accountId: o.accountId,
      direction,
      currency,
      amount,
      rateToUsd: usd ? '1' : rate,
      customerId: o.customerId,
      vendorId: o.vendorId,
      agentId: o.agentId,
    });
    const body = JSON.stringify({
      clientKey: clientKey.current,
      entryDate: date,
      description: memo.trim() || `${type.label}: ${debitChoice.label} / ${creditChoice.label}`,
      reference: reference.trim() || undefined,
      rateLocalPerUsd: usd ? rate : currency === localCurrency ? rate : defaultLocalRate,
      lines: [line(debitChoice, 'DEBIT'), line(creditChoice, 'CREDIT')],
    });
    startTransition(async () => {
      const result = await postJournalVoucherAction(body);
      if (result?.ok) {
        toast.success('General entry posted.');
        router.push('/reports/journal');
      } else {
        setError(result?.error || 'The entry could not be posted.');
      }
    });
  }

  return (
    <div className="space-y-4" data-testid="simple-entry">
      <Card>
        <CardHeader>
          <CardTitle>General Entry</CardTitle>
          <CardDescription>{type.hint} The form posts the debit and credit for you.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Date" htmlFor="ge-date" required>
            <Input id="ge-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Transaction type" htmlFor="ge-type" required>
            <Select
              id="ge-type"
              value={typeId}
              onChange={(e) => {
                setTypeId(e.target.value);
                setDebit(null);
                setCredit(null);
              }}
            >
              {TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Entry currency" htmlFor="ge-currency" required>
            <Select id="ge-currency" value={currency} onChange={(e) => chooseCurrency(e.target.value)}>
              {[...new Set(['USD', ...transactionCurrencies(localCurrency)])].map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={type.debit.label} htmlFor="ge-debit" required hint="Debit side.">
            <Combobox
              id="ge-debit"
              options={debitOptions}
              value={debit}
              onChange={setDebit}
              placeholder="Search accounts, customers, suppliers, agents…"
              emptyText="No matching account"
              createLabel="+ Add Account"
              onCreate={(query) => setAdding({ side: 'debit', name: query ?? '' })}
            />
          </Field>
          <Field label={type.credit.label} htmlFor="ge-credit" required hint="Credit side.">
            <Combobox
              id="ge-credit"
              options={creditOptions}
              value={credit}
              onChange={setCredit}
              placeholder="Search accounts, customers, suppliers, agents…"
              emptyText="No matching account"
              createLabel="+ Add Account"
              onCreate={(query) => setAdding({ side: 'credit', name: query ?? '' })}
            />
          </Field>
          <Field label="Amount" htmlFor="ge-amount" required>
            <MoneyInput id="ge-amount" currency={currency} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          {currency !== 'USD' ? (
            <Field label={`Rate (${currency} per 1 USD)`} htmlFor="ge-rate" required hint="The rate on the day of the entry.">
              <Input id="ge-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
            </Field>
          ) : null}
          <Field label="Reference" htmlFor="ge-reference">
            <Input id="ge-reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Memo" htmlFor="ge-memo" className="sm:col-span-2">
            <Input id="ge-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="What this entry is for" />
          </Field>
        </CardContent>
      </Card>

      <Card data-testid="entry-preview">
        <CardHeader>
          <CardTitle>Accounting effect</CardTitle>
          <CardDescription>What will be posted. Nothing is written until you press Post entry.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr_auto]">
            <dt className="font-medium text-ink-muted">Debit</dt>
            <dd>{debitChoice?.label ?? '—'}</dd>
            <dd className="tnum text-right font-medium">{value.greaterThan(0) ? formatMoney(value, currency) : '—'}</dd>
            <dt className="font-medium text-ink-muted">Credit</dt>
            <dd>{creditChoice?.label ?? '—'}</dd>
            <dd className="tnum text-right font-medium">{value.greaterThan(0) ? formatMoney(value, currency) : '—'}</dd>
            <dt className="text-ink-muted">Difference</dt>
            <dd />
            <dd className="tnum text-right">{formatMoney(0, currency)}</dd>
            <dt className="text-ink-muted">Cash / bank</dt>
            <dd className="text-ink-muted sm:col-span-2">
              {moneyMoves
                ? `${debitChoice?.cash ? `${debitChoice.label} rises` : ''}${debitChoice?.cash && creditChoice?.cash ? ', ' : ''}${creditChoice?.cash ? `${creditChoice.label} falls` : ''}`
                : 'None — no cash or bank moves'}
            </dd>
          </dl>
          <FormError message={error} />
          <div className="mt-4 flex justify-end">
            <Button onClick={submit} loading={pending} data-testid="post-entry">
              Post entry
            </Button>
          </div>
        </CardContent>
      </Card>

      <AddJournalAccountDialog
        open={adding !== null}
        onOpenChange={(open) => {
          if (!open) setAdding(null);
        }}
        initialName={adding?.name}
        defaultCurrency={currency}
        localCurrency={localCurrency}
        onCreated={onCreated}
      />
    </div>
  );
}
