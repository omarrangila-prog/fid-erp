'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { HandCoins, ArrowDownToLine, ArrowUpFromLine, Undo2 } from 'lucide-react';
import { FormError } from '@/components/shared/form-error';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Select } from '@/components/ui/input';
import { AccountSelect } from '@/components/shared/account-select';
import { Field } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { dec, tryDec } from '@/lib/money';
import { formatMoney, todayInputValue } from '@/lib/format';
import { postLoanAction } from '@/server/actions/finance-actions';
import { useSaveAndOpen } from '@/lib/use-save-and-open';

type Account = { id: string; name: string; currency: string };
type LoanAccount = { id: string; label: string; currency: string | null };

const DIRECTIONS = [
  {
    value: 'RECEIVED' as const,
    icon: ArrowDownToLine,
    title: 'We received a loan',
    blurb: 'Somebody lent the business money.',
    posts: 'The account goes up and what we owe them goes up with it.',
  },
  {
    value: 'GIVEN' as const,
    icon: ArrowUpFromLine,
    title: 'We lent money out',
    blurb: 'The business lent somebody money.',
    posts: 'The account goes down and what they owe us goes up.',
  },
  {
    value: 'REPAID' as const,
    icon: Undo2,
    title: 'We repaid a loan',
    blurb: 'Paying back money the business borrowed.',
    posts: 'The account goes down and what we owe them falls.',
  },
];

/**
 * A loan with anybody at all.
 *
 * The inter-company screen answers one case; the business also borrows from
 * directors, shareholders and friends, and the questions are the same every
 * time: who, how much, into which account, and at what rate. The lender is
 * typed as a name and gets a running account of their own — lend again next
 * month and it finds the same ledger rather than opening a second.
 *
 * Nothing here reaches the profit and loss. Borrowing money is not income and
 * repaying it is not a cost, and the form says so rather than leaving somebody
 * to wonder why the month looks profitable.
 */
export function LoanForm({
  accounts,
  loanAccounts,
  localCurrency,
  initialDirection,
}: {
  accounts: Account[];
  loanAccounts: LoanAccount[];
  localCurrency: string;
  initialDirection: 'RECEIVED' | 'GIVEN' | 'REPAID';
}) {
  const router = useRouter();
  const { busy, start } = useSaveAndOpen();
  const [error, setError] = React.useState<string | null>(null);

  const [direction, setDirection] = React.useState(initialDirection);
  const [loanAccountId, setLoanAccountId] = React.useState('');
  const [cashBankAccountId, setAccount] = React.useState(accounts[0]?.id ?? '');
  const [loanDate, setDate] = React.useState(todayInputValue());
  const [currency, setCurrency] = React.useState(accounts[0]?.currency ?? localCurrency);
  const [amount, setAmount] = React.useState('');
  const [exchangeRate, setRate] = React.useState('');
  const [bankAmount, setBankAmount] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [memo, setMemo] = React.useState('');

  const account = accounts.find((a) => a.id === cashBankAccountId);
  const bankCurrency = account?.currency ?? localCurrency;
  const sameCurrency = currency.toUpperCase() === bankCurrency.toUpperCase();
  const existing = loanAccounts.find((a) => a.id === loanAccountId);

  // What reaches the account, worked out rather than typed.
  const converted = React.useMemo(() => {
    const value = tryDec(amount);
    if (value.lessThanOrEqualTo(0)) return null;
    if (sameCurrency) return dec(value);
    const rate = tryDec(exchangeRate);
    if (rate.lessThanOrEqualTo(0)) return null;
    return dec(value).times(rate);
  }, [amount, exchangeRate, sameCurrency]);

  const chosen = DIRECTIONS.find((d) => d.value === direction)!;
  const moneyIn = direction === 'RECEIVED';
  const who = existing?.label ?? 'them';

  function submit() {
    setError(null);
    if (!cashBankAccountId) return setError('Choose the account the money moved through.');
    if (!loanAccountId) return setError('Choose the account the loan is with.');
    if (tryDec(amount).lessThanOrEqualTo(0)) return setError('Enter the amount.');
    if (!sameCurrency && tryDec(exchangeRate).lessThanOrEqualTo(0)) {
      return setError(`Enter the rate used to turn ${currency} into ${bankCurrency}.`);
    }

    start(async () => {
      const result = await postLoanAction(
        JSON.stringify({
          loanDate,
          direction,
          loanAccountId,
          cashBankAccountId,
          currency,
          amount,
          exchangeRate: sameCurrency ? '1' : exchangeRate,
          bankAmount,
          reference,
          description: memo,
        }),
      );
      if (!result?.ok) {
        setError(result?.error ?? 'The loan could not be posted.');
        return;
      }
      toast.success(result.message ?? 'Loan posted.');
      router.push('/finance/cash-bank');
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <Callout tone="info" title="This is not income and not a cost">
        A loan sits on the balance sheet until it is repaid. {moneyIn ? 'Receiving' : 'Lending'} money changes what
        is owed, not what the business earned.
      </Callout>

      <Card>
        <CardHeader>
          <CardTitle>What happened?</CardTitle>
          <CardDescription>The accounting is written for you once you choose.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          {DIRECTIONS.map((option) => {
            const Icon = option.icon;
            const active = option.value === direction;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setDirection(option.value)}
                aria-pressed={active}
                className={cn(
                  'flex gap-3 rounded-xl border-2 p-4 text-left transition-colors',
                  active ? 'border-forest-500 bg-forest-50/60' : 'border-line bg-surface hover:border-forest-300',
                )}
              >
                <Icon className="mt-0.5 size-5 shrink-0 text-forest-700" />
                <span>
                  <span className="block text-sm font-semibold text-ink">{option.title}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">{option.blurb}</span>
                </span>
              </button>
            );
          })}
        </CardContent>
        <CardContent className="border-t border-line pt-4">
          <p className="text-xs text-ink-subtle">{chosen.posts}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Who, and through which account</CardTitle>
          <CardDescription>
            A name that has lent before keeps the same ledger. A new one gets a ledger of their own.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {/*
            * Who the money is with is an account, not a name typed into a box.
            * Pick them and every entry lands in their ledger; type somebody
            * new and the ledger is opened without losing the form.
            */}
          <Field
            label={moneyIn ? 'Received from account' : direction === 'GIVEN' ? 'Lent to account' : 'Repaid to account'}
            htmlFor="loanParty"
            required
            className="sm:col-span-2"
            hint="Their ledger records it automatically. Type a name nobody has yet to open one."
          >
            <AccountSelect
              id="loanParty"
              accounts={loanAccounts.map((a) => ({ id: a.id, name: a.label, currency: a.currency }))}
              value={loanAccountId}
              onChange={setLoanAccountId}
              defaultCurrency={localCurrency}
              placeholder="Search or type a name…"
            />
          </Field>

          <Field label={moneyIn ? 'Received into' : 'Paid from'} required>
            <Select
              value={cashBankAccountId}
              onChange={(e) => {
                setAccount(e.target.value);
                const next = accounts.find((a) => a.id === e.target.value);
                if (next) setCurrency(next.currency);
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.currency}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Date" required>
            <Input type="date" value={loanDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How much</CardTitle>
          <CardDescription>
            {sameCurrency
              ? 'The loan and the account are in the same currency, so nothing is converted.'
              : `The loan is in ${currency} and the account is in ${bankCurrency}. The rate is the one used on the day.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Loan currency" required hint="What the loan itself is in.">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {[...new Set([bankCurrency, localCurrency, 'USD', 'MAD', 'AED'])].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={`Amount (${currency})`} required>
            <MoneyInput currency={currency} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>

          {!sameCurrency ? (
            <Field label="Exchange rate" required hint={`${bankCurrency} per 1 ${currency}`}>
              <Input inputMode="decimal" value={exchangeRate} onChange={(e) => setRate(e.target.value)} />
            </Field>
          ) : null}

          <Field label="Reference" hint="Optional — the bank's reference.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </CardContent>

        {!sameCurrency ? (
          <CardContent className="border-t border-line pt-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs text-ink-muted">
                  {moneyIn ? 'Reaching' : 'Leaving'} {account?.name ?? 'the account'}
                </p>
                <p className="text-lg font-semibold tabular-nums text-ink">
                  {converted ? formatMoney(converted, bankCurrency) : '—'}
                </p>
                <p className="mt-1 text-xs text-ink-subtle">
                  Worked out from the rate above. {who} is owed the {currency} either way — the rate records
                  what that was worth on the day.
                </p>
              </div>
              <Field label={`Actually ${moneyIn ? 'received' : 'paid'}`} hint="Optional.">
                <MoneyInput
                  currency={bankCurrency}
                  value={bankAmount}
                  onChange={(e) => setBankAmount(e.target.value)}
                  placeholder={converted ? converted.toFixed(2) : '0.00'}
                />
              </Field>
            </div>
          </CardContent>
        ) : null}

        <CardContent className="border-t border-line pt-4">
          <Field label="Memo" hint="Optional — what this loan was for. It appears on the journal entry.">
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
        <Button variant="accent" onClick={submit} loading={busy}>
          <span className="flex items-center gap-1.5">
            <HandCoins className="size-4" />
            Post loan
          </span>
        </Button>
      </div>
    </div>
  );
}
