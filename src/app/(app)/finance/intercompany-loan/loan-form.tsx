'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowRight } from 'lucide-react';
import { FormError } from '@/components/shared/form-error';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { dec, tryDec } from '@/lib/money';
import { formatMoney, todayInputValue } from '@/lib/format';
import { postIntercompanyLoanAction } from '@/server/actions/finance-actions';
import { useSaveAndOpen } from '@/lib/use-save-and-open';

export type LoanAccountOption = {
  id: string;
  label: string;
  type: 'ASSET' | 'LIABILITY';
  isDefaultReceivable: boolean;
  isDefaultPayable: boolean;
};

export type LoanCompany = {
  id: string;
  name: string;
  accounts: Array<{ id: string; name: string; currency: string }>;
  loanAccounts: LoanAccountOption[];
};

/** The built-in account for this side first, then everything the client made. */
function orderFor(company: LoanCompany | undefined, side: 'LENDER' | 'BORROWER'): LoanAccountOption[] {
  const options = company?.loanAccounts ?? [];
  const isBuiltIn = (o: LoanAccountOption) =>
    side === 'LENDER' ? o.isDefaultReceivable : o.isDefaultPayable;
  return [...options.filter(isBuiltIn), ...options.filter((o) => !isBuiltIn(o))];
}

/**
 * One FID company lending to the other.
 *
 * The two are separate legal entities, so this is not a transfer between
 * accounts: money leaves one company's bank and arrives in the other's, and
 * what remains is a debt the lender is owed and the borrower owes. The form
 * says so plainly, because recording it as a transfer is the mistake that
 * leaves an inter-company balance missing from both sets of books.
 *
 * The rate is typed in rather than looked up — it is the rate the bank used
 * on the day, which is a fact about that transaction and not about today.
 *
 * Each side also says which account carries the debt, because a company that
 * keeps a named account for the other one needs the balance to land there
 * rather than in an account nobody opens.
 */
export function IntercompanyLoanForm({ companies }: { companies: LoanCompany[] }) {
  const router = useRouter();
  const { busy, start } = useSaveAndOpen();
  const [error, setError] = React.useState<string | null>(null);
  /** What was posted, shown in place so the client sees it happened. */
  const [done, setDone] = React.useState<null | {
    lent: string;
    received: string;
    rate: string;
    bank: string;
    message: string;
  }>(null);

  const [fromCompanyId, setFromCompany] = React.useState(companies[0]?.id ?? '');
  const [toCompanyId, setToCompany] = React.useState(companies[1]?.id ?? '');
  const from = companies.find((c) => c.id === fromCompanyId);
  const to = companies.find((c) => c.id === toCompanyId);

  const [fromAccountId, setFromAccount] = React.useState(from?.accounts[0]?.id ?? '');
  const [toAccountId, setToAccount] = React.useState(to?.accounts[0]?.id ?? '');
  const [transferDate, setDate] = React.useState(todayInputValue());
  const [amount, setAmount] = React.useState('');
  const [exchangeRate, setRate] = React.useState('');
  const [receivedOverride, setReceivedOverride] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [memo, setMemo] = React.useState('');
  const [fromLoanAccountId, setFromLoanAccount] = React.useState('');
  const [toLoanAccountId, setToLoanAccount] = React.useState('');

  /*
   * The account each side carries the debt in, chosen when the two companies
   * are. The lender's own account is what it is owed, the borrower's what it
   * owes, so each list leads with the built-in account for that side and the
   * client's own accounts follow.
   */
  const lenderLoanOptions = React.useMemo(() => orderFor(from, 'LENDER'), [from]);
  const borrowerLoanOptions = React.useMemo(() => orderFor(to, 'BORROWER'), [to]);

  // Worked out while rendering rather than corrected afterwards: changing
  // company changes the list, and a choice that is no longer on it falls back
  // to the built-in account at the top.
  const lenderLoanChoice = lenderLoanOptions.some((o) => o.id === fromLoanAccountId)
    ? fromLoanAccountId
    : lenderLoanOptions[0]?.id ?? '';
  const borrowerLoanChoice = borrowerLoanOptions.some((o) => o.id === toLoanAccountId)
    ? toLoanAccountId
    : borrowerLoanOptions[0]?.id ?? '';

  const fromAccount = from?.accounts.find((a) => a.id === fromAccountId);
  const toAccount = to?.accounts.find((a) => a.id === toAccountId);
  const sameCurrency = Boolean(fromAccount && toAccount && fromAccount.currency === toAccount.currency);

  // What lands, worked out from the rate entered — the figure the client
  // asked to see calculated rather than typed.
  const converted = React.useMemo(() => {
    const value = tryDec(amount);
    const rate = tryDec(exchangeRate);
    if (value.lessThanOrEqualTo(0) || rate.lessThanOrEqualTo(0)) return null;
    return dec(value).times(rate);
  }, [amount, exchangeRate]);

  function chooseFromCompany(id: string) {
    setFromCompany(id);
    const next = companies.find((c) => c.id === id);
    setFromAccount(next?.accounts[0]?.id ?? '');
    if (id === toCompanyId) {
      const other = companies.find((c) => c.id !== id);
      setToCompany(other?.id ?? '');
      setToAccount(other?.accounts[0]?.id ?? '');
    }
  }

  function chooseToCompany(id: string) {
    setToCompany(id);
    const next = companies.find((c) => c.id === id);
    setToAccount(next?.accounts[0]?.id ?? '');
  }

  function submit() {
    setError(null);
    if (!fromAccountId || !toAccountId) return setError('Choose the account on each side.');
    if (fromCompanyId === toCompanyId) return setError('A company cannot lend to itself.');
    if (tryDec(amount).lessThanOrEqualTo(0)) return setError('Enter the amount being lent.');
    if (!sameCurrency && tryDec(exchangeRate).lessThanOrEqualTo(0)) {
      return setError('Enter the exchange rate used for this loan.');
    }

    start(async () => {
      const result = await postIntercompanyLoanAction(
        JSON.stringify({
          transferDate,
          fromCompanyId,
          fromAccountId,
          toCompanyId,
          toAccountId,
          amount,
          exchangeRate: sameCurrency ? '1' : exchangeRate,
          receivedAmount: receivedOverride,
          fromLoanAccountId: lenderLoanChoice,
          toLoanAccountId: borrowerLoanChoice,
          reference,
          description: memo,
        }),
      );
      if (!result?.ok) {
        setError(result?.error ?? 'The loan could not be posted.');
        return;
      }
      toast.success(result.message ?? 'Loan posted.');
      setDone({
        lent: formatMoney(amount, fromAccount?.currency ?? 'USD'),
        received: formatMoney(receivedOverride || converted || 0, toAccount?.currency ?? 'MAD'),
        rate: sameCurrency ? '1' : exchangeRate,
        bank: toAccount?.name ?? '',
        message: result.message ?? '',
      });
      router.refresh();
    });
  }

  if (done) {
    return (
      <div className="space-y-5">
        <Callout tone="info" title="Transaction completed">
          The loan is on both companies&rsquo; books and the bank balance has moved.
        </Callout>

        <Card>
          <CardHeader>
            <CardTitle>What was recorded</CardTitle>
            <CardDescription>{done.message}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs text-ink-muted">Lent by {from?.name}</p>
              <p className="text-lg font-semibold tabular-nums text-ink">{done.lent}</p>
            </div>
            <div>
              <p className="text-xs text-ink-muted">Exchange rate</p>
              <p className="text-lg font-semibold tabular-nums text-ink">{done.rate}</p>
            </div>
            <div>
              <p className="text-xs text-ink-muted">Received into {done.bank}</p>
              <p className="text-lg font-semibold tabular-nums text-forest-800">{done.received}</p>
            </div>
            <div>
              <p className="text-xs text-ink-muted">Owed by {to?.name}</p>
              <p className="text-lg font-semibold tabular-nums text-ink">{done.received}</p>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => setDone(null)}>
            Record another
          </Button>
          <Button variant="accent" onClick={() => router.push('/finance/cash-bank')}>
            See the bank balance
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <FormError message={error} />

      <Callout tone="info" title="This is a loan, not a transfer">
        The two companies are separate legal entities. {from?.name ?? 'The lender'} will carry it as money owed to
        them, {to?.name ?? 'the borrower'} as money they owe, and neither side counts it as income or expense.
      </Callout>

      <Card>
        <CardHeader>
          <CardTitle>Who is lending, and to whom</CardTitle>
          <CardDescription>The money leaves one company’s bank and lands in the other’s.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-end">
            <div className="space-y-4 rounded-xl border border-line p-4">
              <Field label="From company" required>
                <Select value={fromCompanyId} onChange={(e) => chooseFromCompany(e.target.value)}>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="From account" required hint="The money leaves here.">
                <Select value={fromAccountId} onChange={(e) => setFromAccount(e.target.value)}>
                  {(from?.accounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.currency}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Record what they are owed in"
                required
                hint={`The account in ${from?.name ?? 'the lender'}’s books that will hold the debt.`}
              >
                <Select value={lenderLoanChoice} onChange={(e) => setFromLoanAccount(e.target.value)}>
                  {lenderLoanOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="hidden pb-6 text-ink-subtle lg:block">
              <ArrowRight className="size-6" />
            </div>

            <div className="space-y-4 rounded-xl border border-line p-4">
              <Field label="To company" required>
                <Select value={toCompanyId} onChange={(e) => chooseToCompany(e.target.value)}>
                  {companies
                    .filter((c) => c.id !== fromCompanyId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="To account" required hint="The money lands here.">
                <Select value={toAccountId} onChange={(e) => setToAccount(e.target.value)}>
                  {(to?.accounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.currency}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Record what they owe in"
                required
                hint={`The account in ${to?.name ?? 'the borrower'}’s books that will hold the debt.`}
              >
                <Select value={borrowerLoanChoice} onChange={(e) => setToLoanAccount(e.target.value)}>
                  {borrowerLoanOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How much</CardTitle>
          <CardDescription>
            {sameCurrency
              ? 'Both accounts are in the same currency, so nothing is converted.'
              : 'The rate is the one the bank used on the day, not today’s.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date" required>
            <Input type="date" value={transferDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={`Amount lent${fromAccount ? ` (${fromAccount.currency})` : ''}`} required>
            <MoneyInput
              currency={fromAccount?.currency ?? 'USD'}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          {!sameCurrency ? (
            <Field
              label="Exchange rate"
              required
              hint={
                fromAccount && toAccount
                  ? `${toAccount.currency} per 1 ${fromAccount.currency}`
                  : 'Units received per unit sent'
              }
            >
              <Input inputMode="decimal" value={exchangeRate} onChange={(e) => setRate(e.target.value)} />
            </Field>
          ) : null}
          <Field label="Reference" hint="Optional — the bank’s reference for the transfer.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </CardContent>

        {/* What this loan was for, in the client's own words. It becomes the
            description on both companies' journal entries, so it is what they
            will read months later when they ask what this was. */}
        <CardContent className="border-t border-line pt-4">
          <Field
            label="Memo"
            hint="Optional — what this loan was for. It appears on both companies’ journal entries."
          >
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
        </CardContent>

        {!sameCurrency ? (
          <CardContent className="border-t border-line pt-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs text-ink-muted">Converted amount</p>
                <p className="text-lg font-semibold tabular-nums text-ink">
                  {converted ? formatMoney(converted, toAccount?.currency ?? 'MAD') : '—'}
                </p>
                <p className="mt-1 text-xs text-ink-subtle">
                  Worked out from the rate above. If the bank credited something different, say what really
                  arrived and that figure is used instead.
                </p>
              </div>
              <Field label="Actually received" hint="Optional.">
                <MoneyInput
                  currency={toAccount?.currency ?? 'MAD'}
                  value={receivedOverride}
                  onChange={(e) => setReceivedOverride(e.target.value)}
                  placeholder={converted ? converted.toFixed(2) : '0.00'}
                />
              </Field>
            </div>
          </CardContent>
        ) : null}
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
        <Button variant="accent" onClick={submit} loading={busy}>
          Post loan
        </Button>
      </div>
    </div>
  );
}
