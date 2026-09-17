'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Trash2, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input, MoneyInput, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Callout } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { tryDec, Decimal } from '@/lib/money';
import { postJournalVoucherAction } from '@/server/actions/finance-actions';
import { useSaveAndOpen } from '@/lib/use-save-and-open';
import { AddJournalAccountDialog, type CreatedJournalAccount } from '@/app/(app)/accounting/journal/new/add-account';

export type AccountOption = ComboOption & {
  accountType: string;
  /** Currencies of the cash/bank drawers sitting on this account, if any. */
  drawerCurrencies?: string[];
};

type Line = {
  key: string;
  accountId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  description: string;
  /**
   * A line stands in its own currency.
   *
   * A voucher that moves money out of a USD account and into a MAD one is an
   * ordinary thing to write, and forcing one currency on the whole entry made
   * it impossible: every MAD account was unavailable the moment the voucher
   * was USD. Each line now carries what it is really in, and the two sides
   * meet in USD, which is what the totals have always been measured in.
   */
  currency: string;
  rateToUsd: string;
};

/** The currencies these books are kept in. */
const CURRENCIES = ['USD', 'MAD', 'AED'] as const;

const emptyLine = (index: number, currency = 'USD', rateToUsd = '1'): Line => ({
  key: `line-${index}`,
  accountId: '',
  direction: index === 0 ? 'DEBIT' : 'CREDIT',
  amount: '',
  description: '',
  currency,
  rateToUsd,
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
  customers = [],
  localCurrency,
  defaultLocalRate,
  ratesByCurrency,
  today,
}: {
  accounts: AccountOption[];
  customers?: ComboOption[];
  localCurrency: string;
  defaultLocalRate: string;
  ratesByCurrency: Record<string, string>;
  today: string;
}) {
  const router = useRouter();
  const { busy, start, opening } = useSaveAndOpen();
  const [entryDate, setEntryDate] = React.useState(today);
  const [description, setDescription] = React.useState('');
  const [currency, setCurrency] = React.useState('USD');
  const [rateToUsd, setRateToUsd] = React.useState('1');
  const [localRate, setLocalRate] = React.useState(defaultLocalRate);
  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const [accountOptions, setAccountOptions] = React.useState(accounts);
  const [addAccountFor, setAddAccountFor] = React.useState<string | null>(null);
  const [addAccountName, setAddAccountName] = React.useState('');
  const [lines, setLines] = React.useState<Line[]>(() => [emptyLine(0), emptyLine(1)]);
  const [error, setError] = React.useState<string | null>(null);
  const nextKey = React.useRef(2);

  /*
   * A cash or bank drawer holds exactly one currency, so a MAD till cannot
   * take a USD amount and the other way round. That is judged against the
   * currency of the line being written, not of the voucher: a voucher may
   * move USD out of one account and MAD into another, and both accounts have
   * to be reachable from their own line.
   */
  const accountsFor = React.useCallback(
    (lineCurrency: string) =>
      accountOptions.map((account) => {
        const drawers = account.drawerCurrencies ?? [];
        if (drawers.length === 0 || drawers.includes(lineCurrency)) return account;
        return {
          ...account,
          disabled: true,
          hint: `held in ${drawers.join(' / ')} — choose ${drawers[0]} on this line to use it`,
        };
      }),
    [accountOptions],
  );
  // One key per opened form: see journalVoucherSchema.clientKey. Issued in an
  // effect rather than during render, which must stay pure.
  const clientKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!clientKey.current) {
      clientKey.current =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }, []);

  /*
   * Measured in USD, because that is the one currency every line can be
   * compared in. A line already in USD counts as it stands; anything else is
   * divided by its own rate, which is stated as units per one dollar.
   */
  const totals = React.useMemo(() => {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const line of lines) {
      const value = tryDec(line.amount);
      const rate = tryDec(line.rateToUsd);
      const usd = line.currency === 'USD' || rate.lessThanOrEqualTo(0) ? value : value.dividedBy(rate);
      if (line.direction === 'DEBIT') debit = debit.plus(usd);
      else credit = credit.plus(usd);
    }
    return { debit, credit, difference: debit.minus(credit) };
  }, [lines]);

  /** One line's worth in USD, or null while it is still incomplete. */
  function lineUsd(line: Line) {
    const value = tryDec(line.amount);
    const rate = tryDec(line.rateToUsd);
    if (value.lessThanOrEqualTo(0)) return null;
    if (line.currency !== 'USD' && rate.lessThanOrEqualTo(0)) return null;
    const usd = line.currency === 'USD' ? value : value.dividedBy(rate);
    return usd.toFixed(2);
  }

  const balanced = totals.difference.isZero() && totals.debit.greaterThan(0);

  /**
   * Why it does not balance, in words.
   *
   * "Difference −50,001" is arithmetic; it does not tell somebody that every
   * line is on the same side, which is the mistake that produced it. Double
   * entry needs one of each, and saying so is more use than the number.
   */
  const imbalanceReason = React.useMemo(() => {
    if (balanced) return null;
    const filled = lines.filter((l) => tryDec(l.amount).greaterThan(0));
    if (filled.length === 0) return null;
    if (filled.every((l) => l.direction === 'CREDIT')) {
      return 'Every line is a credit. One side has to be a debit — the account receiving the value.';
    }
    if (filled.every((l) => l.direction === 'DEBIT')) {
      return 'Every line is a debit. One side has to be a credit — the account giving the value.';
    }
    return null;
  }, [balanced, lines]);
  const complete = lines.every(
    (line) =>
      line.accountId &&
      tryDec(line.amount).greaterThan(0) &&
      (line.currency === 'USD' || tryDec(line.rateToUsd).greaterThan(0)),
  );

  function updateLine(key: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function addLine() {
    // A new line starts in the voucher's currency, which is the common case.
    setLines((current) => [...current, emptyLine(nextKey.current++, currency, rateToUsd)]);
  }

  function removeLine(key: string) {
    setLines((current) => (current.length <= 2 ? current : current.filter((line) => line.key !== key)));
  }

  function openAddAccount(lineKey: string, typed?: string) {
    setAddAccountFor(lineKey);
    setAddAccountName(typed ?? '');
  }

  function onAccountCreated(created: CreatedJournalAccount) {
    const option: AccountOption = {
      value: created.id,
      label: `${created.code} — ${created.name}`,
      hint: created.type.replaceAll('_', ' ').toLowerCase(),
      keywords: `${created.code} ${created.name} ${created.type}`,
      accountType: created.type,
    };
    setAccountOptions((current) => (current.some((row) => row.value === created.id) ? current : [...current, option]));
    if (addAccountFor) updateLine(addAccountFor, { accountId: created.id });
    setAddAccountFor(null);
    setAddAccountName('');
  }

  /**
   * Fills a blank amount with whatever balances the entry, which is the usual
   * last step. Only a blank one: a figure the user typed is the figure they
   * meant. This used to rewrite any amount on blur, so a deliberate 100 on
   * the second line of a three-line voucher became 250 the moment they tabbed
   * away, and a split entry could not be typed in at all.
   */
  /**
   * Offer the amount that would square the voucher.
   *
   * The difference is measured in USD, so on a line written in another
   * currency it is converted back at that line's own rate before being
   * suggested — otherwise the figure offered would be dollars wearing a
   * dirham label.
   */
  function balanceRemainder(key: string) {
    const difference = totals.difference;
    if (difference.isZero()) return;
    const line = lines.find((l) => l.key === key);
    if (!line || line.amount.trim() !== '') return;
    const inUsd = line.direction === 'DEBIT' ? difference.negated() : difference;
    if (!inUsd.greaterThan(0)) return;
    const rate = tryDec(line.rateToUsd);
    const adjustment = line.currency === 'USD' || rate.lessThanOrEqualTo(0) ? inUsd : inUsd.times(rate);
    updateLine(key, { amount: adjustment.toFixed(2) });
  }

  function submit() {
    setError(null);

    /*
     * Say what is missing rather than going dead.
     *
     * The button was disabled until the voucher balanced, was complete and had
     * a description — three conditions, none of them stated, and a button that
     * does nothing when pressed is indistinguishable from a broken one.
     */
    if (!description.trim()) {
      setError('Give the voucher a description, so the entry can be understood later.');
      return;
    }
    if (!complete) {
      setError('Every line needs an account and an amount greater than zero.');
      return;
    }
    if (!balanced) {
      setError(
        `Debits and credits differ by ${totals.difference.abs().toFixed(2)}. A journal entry has to balance before it can be posted.`,
      );
      return;
    }

    start(async () => {
      const result = await postJournalVoucherAction(
        JSON.stringify({
          clientKey: clientKey.current ?? undefined,
          entryDate,
          description: description.trim(),
          rateLocalPerUsd: localRate,
          lines: lines.map((line) => ({
            accountId: line.accountId,
            direction: line.direction,
            // Each line in the currency it was actually written in.
            currency: line.currency,
            amount: line.amount,
            rateToUsd: line.currency === 'USD' ? '1' : line.rateToUsd,
            description: line.description.trim() || undefined,
            customerId: customerId || undefined,
          })),
        }),
      );

      if (result?.ok) {
        toast.success(result.message || 'Journal voucher posted.');
        opening();
        router.push('/reports/journal');
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
        {' '}
        Money lent between the two companies has its own screen:{' '}
        <Link href="/finance/intercompany-loan" className="font-medium underline underline-offset-2">
          Intercompany loan
        </Link>{' '}
        writes both sides at once, so neither set of books can be left holding half of it.
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
          <Field
            label="Currency"
            htmlFor="jv-currency"
            required
            hint="The currency lines start in. Any line can be changed to another."
          >
            <Select
              id="jv-currency"
              value={currency}
              onChange={(e) => {
                const next = e.target.value;
                const nextRate = next === 'USD' ? '1' : (ratesByCurrency[next] ?? defaultLocalRate);
                setCurrency(next);
                setRateToUsd(nextRate);
                // Lines nobody has filled in yet follow the voucher; a line
                // already written keeps whatever it was deliberately set to.
                setLines((current) =>
                  current.map((line) =>
                    line.accountId || line.amount ? line : { ...line, currency: next, rateToUsd: nextRate },
                  ),
                );
              }}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
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
            <Field
              label="Customer (optional)"
              htmlFor="jv-customer"
              hint="If this entry belongs on a customer’s ledger, pick them and debit or credit Accounts Receivable."
            >
              <Combobox
                id="jv-customer"
                options={customers}
                value={customerId}
                onChange={setCustomerId}
                placeholder="None — general ledger only"
                emptyText="No customers"
              />
            </Field>
          </div>
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
                  {/*
                    The full account name, wrapped rather than cut off. A code
                    and a name like "1600 — F I D TRADING LLC DUBAI" does not
                    fit on one line, and an account you cannot read the end of
                    is one you cannot be sure you picked. "+ Add New Account"
                    is the first row of the list, so no separate button is
                    needed beside it taking the width the name wants.
                  */}
                  <Combobox
                    id={`acct-${line.key}`}
                    aria-label={`Line ${index + 1} account`}
                    options={accountsFor(line.currency)}
                    value={line.accountId || null}
                    onChange={(value) => updateLine(line.key, { accountId: value ?? '' })}
                    placeholder="Choose an account…"
                    wrap
                    createLabel="+ Add New Account"
                    onCreate={(query) => openAddAccount(line.key, query)}
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
                  <div className="flex gap-2">
                    <Select
                      aria-label={`Line ${index + 1} currency`}
                      className="w-24 shrink-0"
                      value={line.currency}
                      onChange={(e) => {
                        const next = e.target.value;
                        updateLine(line.key, {
                          currency: next,
                          rateToUsd: next === 'USD' ? '1' : (ratesByCurrency[next] ?? localRate),
                          // An account that cannot hold the new currency is no
                          // longer a valid choice on this line.
                          accountId: accountsFor(next).some((a) => a.value === line.accountId && !a.disabled)
                            ? line.accountId
                            : '',
                        });
                      }}
                    >
                      {CURRENCIES.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </Select>
                    <MoneyInput
                      id={`amt-${line.key}`}
                      aria-label={`Line ${index + 1} amount`}
                      currency={line.currency}
                      value={line.amount}
                      onChange={(e) => updateLine(line.key, { amount: e.target.value })}
                      onBlur={() => balanceRemainder(line.key)}
                      placeholder="0.00"
                    />
                  </div>
                  {line.currency !== 'USD' ? (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="shrink-0 text-[11px] text-ink-subtle">Rate</span>
                      <Input
                        aria-label={`Line ${index + 1} rate`}
                        inputMode="decimal"
                        value={line.rateToUsd}
                        onChange={(e) => updateLine(line.key, { rateToUsd: e.target.value })}
                        placeholder="0.00"
                      />
                      <span className="shrink-0 text-[11px] text-ink-subtle">per 1 USD</span>
                    </div>
                  ) : null}
                  {/*
                    What this line is worth in the currency the voucher is
                    balanced in. A dirham amount typed where the rate belongs
                    shows here as a dollar or two instead of thousands, which
                    is the difference being visible at the moment it is made
                    rather than in the totals at the bottom of the page.
                  */}
                  {lineUsd(line) ? (
                    <p className="mt-1 text-[11px] text-ink-subtle">
                      = USD {lineUsd(line)} {line.direction === 'DEBIT' ? 'debit' : 'credit'}
                    </p>
                  ) : null}
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
              <dt className="text-xs text-ink-muted">Total debits (USD)</dt>
              <dd className="tnum font-semibold text-ink">{totals.debit.toFixed(2)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Total credits (USD)</dt>
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

          {imbalanceReason ? (
            <p className="text-xs font-medium text-amber-700">{imbalanceReason}</p>
          ) : null}


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
            <Button onClick={submit} loading={busy}>
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

      <AddJournalAccountDialog
        open={addAccountFor !== null}
        onOpenChange={(next) => {
          if (!next) {
            setAddAccountFor(null);
            setAddAccountName('');
          }
        }}
        initialName={addAccountName}
        defaultCurrency={currency}
        onCreated={onAccountCreated}
      />
    </div>
  );
}
