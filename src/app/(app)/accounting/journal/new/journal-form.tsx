'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Decimal from 'decimal.js';
import { Plus, Trash2, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input, MoneyInput, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Callout } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { postJournalVoucherAction } from '@/server/actions/finance-actions';

export type AccountOption = ComboOption & { accountType: string };

type Line = {
  key: string;
  accountId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  description: string;
};

const emptyLine = (index: number): Line => ({
  key: `line-${index}`,
  accountId: '',
  direction: index === 0 ? 'DEBIT' : 'CREDIT',
  amount: '',
  description: '',
});

/**
 * Manual journal voucher.
 *
 * The one screen in the application that writes to the ledger without a
 * business document behind it, so it earns its restrictions: at least two
 * lines, and debits equal to credits before the button will do anything. The
 * running total is shown as you type rather than only on submit — finding out
 * you are three cents out after filling in eight lines is miserable.
 */
export function JournalForm({
  accounts,
  localCurrency,
  defaultLocalRate,
  today,
}: {
  accounts: AccountOption[];
  localCurrency: string;
  defaultLocalRate: string;
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [entryDate, setEntryDate] = React.useState(today);
  const [description, setDescription] = React.useState('');
  const [currency, setCurrency] = React.useState('USD');
  const [rateToUsd, setRateToUsd] = React.useState('1');
  const [localRate, setLocalRate] = React.useState(defaultLocalRate);
  const [lines, setLines] = React.useState<Line[]>(() => [emptyLine(0), emptyLine(1)]);
  const [error, setError] = React.useState<string | null>(null);
  const nextKey = React.useRef(2);

  const totals = React.useMemo(() => {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const line of lines) {
      const value = line.amount.trim() === '' ? new Decimal(0) : new Decimal(line.amount || 0);
      if (line.direction === 'DEBIT') debit = debit.plus(value);
      else credit = credit.plus(value);
    }
    return { debit, credit, difference: debit.minus(credit) };
  }, [lines]);

  const balanced = totals.difference.isZero() && totals.debit.greaterThan(0);
  const complete = lines.every((line) => line.accountId && Number(line.amount) > 0);
  const canPost = balanced && complete && description.trim().length > 0 && !pending;

  function updateLine(key: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines((current) => [...current, emptyLine(nextKey.current++)]);
  }

  function removeLine(key: string) {
    setLines((current) => (current.length <= 2 ? current : current.filter((line) => line.key !== key)));
  }

  /** Fills the shorter side so the entry balances, which is the usual last step. */
  function balanceRemainder(key: string) {
    const difference = totals.difference;
    if (difference.isZero()) return;
    const line = lines.find((l) => l.key === key);
    if (!line) return;
    const current = new Decimal(line.amount || 0);
    const adjustment = line.direction === 'DEBIT' ? current.minus(difference) : current.plus(difference);
    if (adjustment.greaterThan(0)) updateLine(key, { amount: adjustment.toFixed(2) });
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await postJournalVoucherAction(
        JSON.stringify({
          entryDate,
          description: description.trim(),
          rateLocalPerUsd: localRate,
          lines: lines.map((line) => ({
            accountId: line.accountId,
            direction: line.direction,
            currency,
            amount: line.amount,
            rateToUsd,
            description: line.description.trim() || undefined,
          })),
        }),
      );

      if (result?.ok) {
        toast.success(result.message || 'Journal voucher posted.');
        router.push('/reports/journal');
        router.refresh();
      } else {
        setError(result?.error || 'The voucher could not be posted.');
      }
    });
  }

  return (
    <div className="space-y-4">
      <Callout tone="info" title="This posts straight to the ledger">
        Use a journal voucher for corrections, opening balances and accruals — anything without a purchase, sale,
        receipt or payment behind it. Everything else should be entered on its own screen so stock and the
        sub-ledgers stay in step.
      </Callout>

      <Card>
        <CardHeader>
          <CardTitle>Voucher details</CardTitle>
          <CardDescription>The date decides which period the entry lands in.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Entry date" htmlFor="jv-date" required>
            <Input id="jv-date" autoFocus type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </Field>
          <Field label="Currency" htmlFor="jv-currency" required>
            <Select
              id="jv-currency"
              value={currency}
              onChange={(e) => {
                const next = e.target.value;
                setCurrency(next);
                if (next === 'USD') setRateToUsd('1');
                else if (next === localCurrency) setRateToUsd(defaultLocalRate);
              }}
            >
              <option value="USD">USD</option>
              <option value={localCurrency}>{localCurrency}</option>
            </Select>
          </Field>
          <Field
            label="Rate to USD"
            htmlFor="jv-rate"
            hint={currency === 'USD' ? 'Fixed at 1 for USD.' : `${currency} per 1 USD`}
            required
          >
            <Input
              id="jv-rate"
              value={rateToUsd}
              disabled={currency === 'USD'}
              onChange={(e) => setRateToUsd(e.target.value)}
              className="tnum"
            />
          </Field>
          <Field label={`${localCurrency} per USD`} htmlFor="jv-local" hint="Used for the local-currency books." required>
            <Input id="jv-local" value={localRate} onChange={(e) => setLocalRate(e.target.value)} className="tnum" />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <Field label="Description" htmlFor="jv-description" required hint="Why this entry exists — it appears on the journal report.">
              <Input
                id="jv-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Accrue December warehouse rent"
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Lines</CardTitle>
            <CardDescription>At least two. Debits must equal credits.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={addLine} type="button">
            <Plus />
            Add line
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {lines.map((line, index) => (
            <div
              key={line.key}
              className="grid gap-3 rounded-lg border border-line bg-paper p-3 sm:grid-cols-12 sm:items-end"
            >
              <div className="sm:col-span-5">
                <Field label={index === 0 ? 'Account' : ''} htmlFor={`acct-${line.key}`} required={index === 0}>
                  <Combobox
                    id={`acct-${line.key}`}
                    aria-label={`Line ${index + 1} account`}
                    options={accounts}
                    value={line.accountId}
                    onChange={(value) => updateLine(line.key, { accountId: value ?? "" })}
                    placeholder="Choose an account…"
                  />
                </Field>
              </div>

              <div className="sm:col-span-2">
                <Field label={index === 0 ? 'Side' : ''} htmlFor={`dir-${line.key}`}>
                  <Select
                    id={`dir-${line.key}`}
                    aria-label={`Line ${index + 1} debit or credit`}
                    value={line.direction}
                    onChange={(e) => updateLine(line.key, { direction: e.target.value as Line['direction'] })}
                  >
                    <option value="DEBIT">Debit</option>
                    <option value="CREDIT">Credit</option>
                  </Select>
                </Field>
              </div>

              <div className="sm:col-span-3">
                <Field label={index === 0 ? 'Amount' : ''} htmlFor={`amt-${line.key}`}>
                  <MoneyInput
                    id={`amt-${line.key}`}
                    aria-label={`Line ${index + 1} amount`}
                    currency={currency}
                    value={line.amount}
                    onChange={(e) => updateLine(line.key, { amount: e.target.value })}
                    onBlur={() => balanceRemainder(line.key)}
                    placeholder="0.00"
                  />
                </Field>
              </div>

              <div className="flex items-center gap-2 sm:col-span-2">
                <Input
                  aria-label={`Line ${index + 1} memo`}
                  value={line.description}
                  onChange={(e) => updateLine(line.key, { description: e.target.value })}
                  placeholder="Memo"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove line ${index + 1}`}
                  disabled={lines.length <= 2}
                  onClick={() => removeLine(line.key)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <dl className="grid grid-cols-3 gap-3 text-sm sm:gap-4">
            <div>
              <dt className="text-xs text-ink-muted">Total debits</dt>
              <dd className="tnum font-semibold text-ink">{totals.debit.toFixed(2)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Total credits</dt>
              <dd className="tnum font-semibold text-ink">{totals.credit.toFixed(2)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Difference</dt>
              <dd
                className={cn(
                  'tnum font-semibold',
                  totals.difference.isZero() ? 'text-emerald-700' : 'text-red-600',
                )}
              >
                {totals.difference.toFixed(2)}
              </dd>
            </div>
          </dl>

          <div className="flex items-center gap-3">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                balanced
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                  : 'bg-amber-50 text-amber-700 ring-amber-200',
              )}
            >
              <Scale className="size-3.5" />
              {balanced ? 'Balanced' : 'Not balanced'}
            </span>
            <Button onClick={submit} disabled={!canPost} loading={pending}>
              Post voucher
            </Button>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <Callout tone="danger" title="The voucher was not posted">
          {error}
        </Callout>
      ) : null}
    </div>
  );
}
