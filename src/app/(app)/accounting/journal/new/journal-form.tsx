'use client';

import * as React from 'react';
import { GuidedChooser } from '@/app/(app)/accounting/journal/new/guided-chooser';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Trash2, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input, MoneyInput, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Combobox } from '@/components/ui/combobox';
import { Callout } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { tryDec, Decimal, USD_TRANSLATION_TOLERANCE } from '@/lib/money';
import { formatMoney } from '@/lib/format';
import {
  postJournalVoucherAction,
  replaceJournalVoucherAction,
  postSupplierEntryAction,
  previewSupplierEntryAction,
  supplierOpenItemsAction,
} from '@/server/actions/finance-actions';
import { useSaveAndOpen } from '@/lib/use-save-and-open';
import { AddJournalAccountDialog, type CreatedJournalAccount } from '@/app/(app)/accounting/journal/new/add-account';
import { transactionCurrencies } from '@/lib/company-currencies';
import type { EntryOption } from '@/app/(app)/accounting/journal/new/simple-entry';

type Line = {
  key: string;
  /** The chosen account, customer, supplier or agent — an EntryOption value. */
  option: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  description: string;
  /** Each line stands in its own currency; the account usually decides it. */
  currency: string;
};

const emptyLine = (index: number, currency: string): Line => ({
  key: `line-${index}`,
  option: '',
  direction: index === 0 ? 'DEBIT' : 'CREDIT',
  amount: '',
  description: '',
  currency,
});

/** Units per 1 USD, to eight places (the ledger's rate precision). */
const toRate = (value: Decimal) => value.toDecimalPlaces(8, Decimal.ROUND_DOWN);

export type JournalInitial = {
  entryId: string;
  entryDate: string;
  description: string;
  reference: string;
  rateLocalPerUsd: string;
  lines: Array<{
    option: string;
    direction: 'DEBIT' | 'CREDIT';
    amount: string;
    currency: string;
    rateToUsd: string;
    description: string;
  }>;
};

type OpenItem = { kind: string; id: string; label: string; number: string; currency: string; outstanding: string };
type PostedLine = { account: string; direction: 'DEBIT' | 'CREDIT'; currency: string; amount: string; amountLocal: string };

/**
 * Advanced journal entry: any number of lines, each against an account,
 * customer, supplier or agent chosen by name.
 *
 * The exchange rate is asked once per currency, never once per line: a voucher
 * moving MAD out of a bank against a USD supplier asks "1 USD = ? MAD" and
 * nothing else, and when both amounts are typed the rate is worked out from
 * them (MAD 2,100 ÷ USD 200 = 10.50). A voucher entirely in the company's own
 * currency asks no rate at all.
 *
 * Bank to supplier is posted as the supplier payment it is — against the order
 * or bill it settles, or as an advance — so the supplier's ageing and ledger
 * move with it; the preview is that payment's own entry, worked out by the
 * posting service and rolled back.
 */
export function JournalForm({
  accounts,
  localCurrency,
  defaultLocalRate,
  ratesByCurrency,
  today,
  initial,
  embedded = false,
}: {
  accounts: EntryOption[];
  localCurrency: string;
  defaultLocalRate: string;
  ratesByCurrency: Record<string, string>;
  today: string;
  /**
   * A posted voucher, opened to be corrected. Saving takes the entry it
   * replaces back out of the books and posts these figures as a new entry.
   */
  initial?: JournalInitial;
  /** Shown as a tab of General Entry: straight to the voucher, no guided list of its own. */
  embedded?: boolean;
}) {
  const router = useRouter();
  const { busy, start, opening } = useSaveAndOpen();
  const [mode, setMode] = React.useState<'guided' | 'advanced'>(initial || embedded ? 'advanced' : 'guided');
  const [entryDate, setEntryDate] = React.useState(initial?.entryDate ?? today);
  const [description, setDescription] = React.useState(initial?.description ?? '');
  const [reference, setReference] = React.useState(initial?.reference ?? '');
  const [currency, setCurrency] = React.useState(initial?.lines[0]?.currency ?? localCurrency);
  const [options, setOptions] = React.useState(accounts);
  const [addAccountFor, setAddAccountFor] = React.useState<string | null>(null);
  const [addAccountName, setAddAccountName] = React.useState('');
  const [lines, setLines] = React.useState<Line[]>(() =>
    initial
      ? initial.lines.map((line, index) => ({
          key: `line-${index}`,
          option: line.option,
          direction: line.direction,
          amount: line.amount,
          description: line.description,
          currency: line.currency,
        }))
      : [emptyLine(0, localCurrency), emptyLine(1, localCurrency)],
  );
  /*
   * One rate per currency (units per 1 USD), typed once. Seeded from the rates
   * on file, or from the voucher being corrected.
   */
  const [rates, setRates] = React.useState<Record<string, string>>(() => {
    const seed: Record<string, string> = { ...ratesByCurrency };
    if (localCurrency !== 'USD') seed[localCurrency] = initial?.rateLocalPerUsd ?? ratesByCurrency[localCurrency] ?? defaultLocalRate;
    for (const line of initial?.lines ?? []) if (line.currency !== 'USD') seed[line.currency] = line.rateToUsd;
    return seed;
  });
  const [error, setError] = React.useState<string | null>(null);
  const nextKey = React.useRef(initial ? initial.lines.length : 2);
  const clientKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!clientKey.current) {
      clientKey.current =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }, []);

  const optionOf = React.useCallback((value: string) => options.find((o) => o.value === value) ?? null, [options]);

  /** The currencies a line may be written in: the account's own, or any the company trades in. */
  const currenciesFor = (line: Line) => {
    const fixed = optionOf(line.option)?.currencies;
    return fixed && fixed.length ? fixed : transactionCurrencies(localCurrency, line.currency);
  };

  // --- Rates: once per currency, worked out from the amounts when it can be ---
  const filled = lines.filter((l) => tryDec(l.amount).greaterThan(0));
  const used = new Set(lines.filter((l) => l.option || tryDec(l.amount).greaterThan(0)).map((l) => l.currency));
  const crossesCurrency = [...used].some((c) => c !== localCurrency);
  /** The currencies that need a rate: none when everything is in the company's own currency. */
  const rateCurrencies = crossesCurrency
    ? [...new Set([...used, localCurrency])].filter((c) => c !== 'USD').sort((a, b) => (a === localCurrency ? -1 : b === localCurrency ? 1 : a.localeCompare(b)))
    : [];

  /*
   * Both sides typed, one in USD and the other in a single other currency:
   * the rate is what the two amounts say. MAD 2,100 left the bank and the
   * supplier was credited USD 200, so 1 USD = 10.50 MAD.
   */
  const implied = React.useMemo(() => {
    const result: Record<string, Decimal> = {};
    const currencies = [...new Set(filled.map((l) => l.currency))];
    if (currencies.length !== 2 || !currencies.includes('USD')) return result;
    const other = currencies.find((c) => c !== 'USD')!;
    const sides = (code: string) => new Set(filled.filter((l) => l.currency === code).map((l) => l.direction));
    const usdSides = sides('USD');
    const otherSides = sides(other);
    if (usdSides.size !== 1 || otherSides.size !== 1 || [...usdSides][0] === [...otherSides][0]) return result;
    const total = (code: string) => filled.filter((l) => l.currency === code).reduce((t, l) => t.plus(tryDec(l.amount)), new Decimal(0));
    const usd = total('USD');
    if (usd.greaterThan(0)) result[other] = toRate(total(other).dividedBy(usd));
    return result;
  }, [filled]);

  const rateOf = (code: string): Decimal => {
    if (code === 'USD') return new Decimal(1);
    if (implied[code]) return implied[code];
    return tryDec(rates[code] ?? ratesByCurrency[code] ?? defaultLocalRate);
  };
  const localRate = rateOf(localCurrency);

  /** One line in USD and in the company's currency, or null while incomplete. */
  const valueOf = (line: Line) => {
    const amount = tryDec(line.amount);
    const rate = rateOf(line.currency);
    if (!amount.greaterThan(0) || !rate.greaterThan(0)) return null;
    const usd = line.currency === 'USD' ? amount : amount.dividedBy(rate);
    const local = line.currency === localCurrency ? amount : usd.times(localRate);
    return { usd, local };
  };

  // Measured as the posting engine measures it (USD), shown in the company's currency.
  const totals = React.useMemo(() => {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    let debitLocal = new Decimal(0);
    let creditLocal = new Decimal(0);
    for (const line of lines) {
      const v = valueOf(line);
      if (!v) continue;
      if (line.direction === 'DEBIT') {
        debit = debit.plus(v.usd);
        debitLocal = debitLocal.plus(v.local);
      } else {
        credit = credit.plus(v.usd);
        creditLocal = creditLocal.plus(v.local);
      }
    }
    return { debit, credit, difference: debit.minus(credit), debitLocal, creditLocal, differenceLocal: debitLocal.minus(creditLocal) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, rates, implied]);

  const settled = totals.difference.abs().lessThanOrEqualTo(USD_TRANSLATION_TOLERANCE);
  const balanced = settled && totals.debit.greaterThan(0);
  const complete = lines.every((line) => line.option && tryDec(line.amount).greaterThan(0));
  const ratesOk = rateCurrencies.every((c) => rateOf(c).greaterThan(0));

  const imbalanceReason = React.useMemo(() => {
    if (balanced || filled.length === 0) return null;
    if (filled.every((l) => l.direction === 'CREDIT')) return 'Every line is a credit. One side has to be a debit — the account receiving the value.';
    if (filled.every((l) => l.direction === 'DEBIT')) return 'Every line is a debit. One side has to be a credit — the account giving the value.';
    return null;
  }, [balanced, filled]);

  // --- Bank to supplier: posted as the supplier payment it is ---------------
  const supplierLine = lines.length === 2 ? lines.find((l) => l.direction === 'DEBIT' && optionOf(l.option)?.vendorId) : undefined;
  const bankLine = lines.length === 2 ? lines.find((l) => l.direction === 'CREDIT' && optionOf(l.option)?.cash) : undefined;
  const supplierPayment = supplierLine && bankLine ? { supplier: supplierLine, bank: bankLine, vendorId: optionOf(supplierLine.option)!.vendorId! } : null;
  // Each held against the supplier (or the figures) it was fetched for, so a
  // change of supplier never shows another's orders or a stale preview.
  const vendorId = supplierPayment?.vendorId;
  const [loadedItems, setLoadedItems] = React.useState<{ vendorId: string; items: OpenItem[] } | null>(null);
  const [chosen, setChosen] = React.useState<{ vendorId: string; value: string } | null>(null);
  const openItems = loadedItems && loadedItems.vendorId === vendorId ? loadedItems.items : null;
  const settles = chosen && chosen.vendorId === vendorId ? chosen.value : '';
  const setSettles = (value: string) => vendorId && setChosen({ vendorId, value });

  React.useEffect(() => {
    if (!vendorId) return;
    let live = true;
    supplierOpenItemsAction(vendorId).then((r) => {
      if (live) setLoadedItems({ vendorId, items: r.ok ? r.items : [] });
    });
    return () => {
      live = false;
    };
  }, [vendorId]);

  const supplierBody = () => {
    if (!supplierPayment || !settles) return null;
    const bank = supplierPayment.bank;
    const supplier = supplierPayment.supplier;
    const [kind, id] = settles.split(':');
    return {
      entryDate,
      description: description.trim(),
      reference: reference.trim() || undefined,
      vendorId: supplierPayment.vendorId,
      bankAccountId: optionOf(bank.option)!.accountId,
      bankCurrency: bank.currency,
      bankAmount: bank.amount,
      supplierCurrency: supplier.currency,
      supplierAmount: supplier.amount,
      rateToUsd: rateOf(bank.currency).toString(),
      rateLocalPerUsd: localRate.toString(),
      settles:
        kind === 'ADVANCE'
          ? { kind: 'ADVANCE' as const }
          : { kind: 'DOCUMENT' as const, purchaseContractId: kind === 'CONTRACT' ? id : undefined, expenseId: kind === 'EXPENSE' ? id : undefined },
    };
  };

  // The payment's own entry, worked out by the posting service and rolled back.
  const previewKey = supplierPayment && settles && balanced && description.trim() ? JSON.stringify(supplierBody()) : null;
  const [previewed, setPreviewed] = React.useState<{ key: string; lines?: PostedLine[]; difference?: string; error?: string } | null>(null);
  const current = previewed && previewed.key === previewKey ? previewed : null;
  const posted = current?.lines ? { lines: current.lines, difference: current.difference ?? '0' } : null;
  const previewError = current?.error ?? null;
  React.useEffect(() => {
    if (!previewKey) return;
    let live = true;
    const timer = setTimeout(() => {
      previewSupplierEntryAction(JSON.stringify({ ...JSON.parse(previewKey), clientKey: 'preview-0000' })).then((r) => {
        if (!live) return;
        setPreviewed(r.ok ? { key: previewKey, lines: r.lines, difference: r.difference } : { key: previewKey, error: r.error });
      });
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [previewKey]);

  function updateLine(key: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  /** Choosing an account brings its currency: a MAD bank is MAD, a USD supplier USD. */
  function chooseOption(key: string, value: string | null) {
    const chosen = value ? optionOf(value) : null;
    const line = lines.find((l) => l.key === key);
    const own = chosen?.currencies?.length === 1 ? chosen.currencies[0] : chosen?.defaultCurrency;
    const allowed = chosen?.currencies?.length ? chosen.currencies : null;
    const next = own ?? (allowed && line && !allowed.includes(line.currency) ? allowed[0] : line?.currency);
    updateLine(key, { option: value ?? '', ...(next ? { currency: next } : {}) });
  }

  function addLine() {
    setLines((current) => [...current, emptyLine(nextKey.current++, currency)]);
  }

  function removeLine(key: string) {
    setLines((current) => (current.length <= 2 ? current : current.filter((line) => line.key !== key)));
  }

  function onAccountCreated(created: CreatedJournalAccount) {
    const option: EntryOption = {
      value: created.id,
      label: created.name,
      hint: created.currency ?? created.type.replaceAll('_', ' ').toLowerCase(),
      keywords: `${created.code} ${created.name} ${created.type}`,
      group:
        created.type === 'EXPENSE' ? 'Expenses' : created.type === 'INCOME' ? 'Revenue' : created.type === 'EQUITY' ? 'Owner & equity' : created.type === 'ASSET' ? 'Other assets' : 'Other liabilities',
      accountId: created.id,
      currencies: created.currency ? [created.currency] : null,
      cash: false,
    };
    setOptions((current) => (current.some((row) => row.value === created.id) ? current : [...current, option]));
    if (addAccountFor) chooseOption(addAccountFor, created.id);
    setAddAccountFor(null);
    setAddAccountName('');
  }

  /** What this blank line would have to be, in its own currency, to square the voucher. */
  function balancingAmount(line: Line) {
    if (implied[line.currency]) return null;
    const difference = totals.difference;
    if (difference.abs().lessThanOrEqualTo(USD_TRANSLATION_TOLERANCE)) return null;
    const inUsd = line.direction === 'DEBIT' ? difference.negated() : difference;
    if (!inUsd.greaterThan(0)) return null;
    const rate = rateOf(line.currency);
    if (!rate.greaterThan(0)) return null;
    return { own: (line.currency === 'USD' ? inUsd : inUsd.times(rate)).toFixed(2), usd: inUsd.toFixed(2) };
  }

  function submit() {
    setError(null);
    if (!description.trim()) return setError('Give the entry a memo, so it can be understood later.');
    if (!complete) return setError('Every line needs an account and an amount greater than zero.');
    if (!ratesOk) return setError(`Enter the exchange rate: 1 USD = how many ${rateCurrencies.find((c) => !rateOf(c).greaterThan(0))}.`);
    if (!balanced) {
      return setError(`Debits and credits differ by ${totals.difference.abs().toFixed(4)} (USD). A journal entry has to balance before it can be posted.`);
    }

    if (supplierPayment) {
      if (initial) return setError('A supplier payment is corrected on the payment itself, not here.');
      if (!settles) return setError('Say what this payment is for: the order or bill it settles, or an advance to the supplier.');
      const body = { ...supplierBody(), clientKey: clientKey.current ?? undefined };
      start(async () => {
        const result = await postSupplierEntryAction(JSON.stringify(body));
        if (result?.ok) {
          toast.success(result.message || 'Supplier payment posted.');
          opening();
          router.push('/finance/payments');
        } else {
          setError(result?.error || 'The payment could not be posted.');
        }
      });
      return;
    }

    start(async () => {
      const body = JSON.stringify({
        clientKey: clientKey.current ?? undefined,
        entryDate,
        description: description.trim(),
        reference: reference.trim() || undefined,
        rateLocalPerUsd: localRate.toString(),
        lines: lines.map((line) => {
          const chosen = optionOf(line.option)!;
          return {
            accountId: chosen.accountId,
            customerId: chosen.customerId,
            vendorId: chosen.vendorId,
            agentId: chosen.agentId,
            direction: line.direction,
            currency: line.currency,
            amount: line.amount,
            rateToUsd: rateOf(line.currency).toString(),
            description: line.description.trim() || undefined,
          };
        }),
      });
      const result = initial ? await replaceJournalVoucherAction(initial.entryId, body) : await postJournalVoucherAction(body);
      if (result?.ok) {
        toast.success(result.message || 'Journal entry posted.');
        opening();
        router.push('/reports/journal');
      } else {
        setError(result?.error || 'The entry could not be posted.');
      }
    });
  }

  if (mode === 'guided') {
    return <GuidedChooser onAdvanced={() => setMode('advanced')} />;
  }

  const fromTo =
    lines.length === 2 && lines.every((l) => l.option)
      ? { from: lines.find((l) => l.direction === 'CREDIT')!, to: lines.find((l) => l.direction === 'DEBIT')! }
      : null;

  return (
    <div className="space-y-4">
      {embedded ? null : (
        <button
          type="button"
          onClick={() => setMode('guided')}
          className="text-xs font-medium text-forest-700 underline underline-offset-2 hover:text-forest-800"
        >
          ← Back to the guided list
        </button>
      )}

      <Callout tone="info" title="This posts straight to the ledger">
        Choose any account, customer, supplier or agent by name. Money from a bank to a supplier is posted as a supplier
        payment, so the order it pays is settled. Money lent between the companies has its own screen:{' '}
        <Link href="/finance/intercompany-loan" className="font-medium underline underline-offset-2">
          Intercompany loan
        </Link>
        .
      </Callout>

      <Card>
        <CardHeader>
          <CardTitle>Entry details</CardTitle>
          <CardDescription>The date decides which period the entry lands in.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Entry date" htmlFor="jv-date" required>
            <Input id="jv-date" autoFocus type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </Field>
          <Field label="Currency" htmlFor="jv-currency" hint="New lines start in this currency. Choosing an account sets its own.">
            <Select
              id="jv-currency"
              value={currency}
              onChange={(e) => {
                const next = e.target.value;
                setCurrency(next);
                // Lines nobody has filled in yet follow; a written line keeps its own.
                setLines((current) => current.map((line) => (line.option || line.amount ? line : { ...line, currency: next })));
              }}
            >
              {transactionCurrencies(localCurrency, currency).map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Reference" htmlFor="jv-reference" hint="Optional — a bank advice, a file number.">
              <Input id="jv-reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. BANK ADVICE 4471" maxLength={80} />
            </Field>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <Field label="Memo" htmlFor="jv-description" required hint="Why this entry exists — it appears on the journal and on every ledger the entry touches.">
              <Input id="jv-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Accrue December warehouse rent" />
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
          {lines.map((line, index) => {
            const fill = line.amount.trim() === '' ? balancingAmount(line) : null;
            const currencies = currenciesFor(line);
            return (
              <div key={line.key} className="grid gap-3 rounded-lg border border-grid bg-paper p-3 sm:grid-cols-12 sm:items-end">
                <div className="sm:col-span-5">
                  <Field label={index === 0 ? 'Account, customer, supplier or agent' : ''} htmlFor={`acct-${line.key}`} required={index === 0}>
                    <Combobox
                      id={`acct-${line.key}`}
                      aria-label={`Line ${index + 1} account`}
                      options={options}
                      value={line.option || null}
                      onChange={(value) => chooseOption(line.key, value)}
                      placeholder="Search accounts, banks, customers, suppliers, agents…"
                      wrap
                      createLabel="+ Add New Account"
                      onCreate={(query) => {
                        setAddAccountFor(line.key);
                        setAddAccountName(query ?? '');
                      }}
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
                      <option value="DEBIT">Debit (to)</option>
                      <option value="CREDIT">Credit (from)</option>
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
                        disabled={currencies.length <= 1}
                        onChange={(e) => updateLine(line.key, { currency: e.target.value })}
                      >
                        {[...new Set([...currencies, line.currency])].map((code) => (
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
                        placeholder="0.00"
                      />
                    </div>
                    {fill ? (
                      <button
                        type="button"
                        onClick={() => updateLine(line.key, { amount: fill.own })}
                        className="mt-1 text-left text-[11px] font-medium text-forest-700 underline underline-offset-2 hover:text-forest-800"
                      >
                        Use {line.currency} {Number(fill.own).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        {line.currency !== 'USD' ? ` — USD ${fill.usd} at ${rateOf(line.currency).toString()}` : ''}
                      </button>
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
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${index + 1}`} disabled={lines.length <= 2} onClick={() => removeLine(line.key)}>
                    <Trash2 />
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {rateCurrencies.length > 0 ? (
        <Card data-testid="jv-rates">
          <CardHeader>
            <CardTitle>Exchange rate</CardTitle>
            <CardDescription>Asked once for the whole entry. Type both amounts above and it is worked out for you.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rateCurrencies.map((code) => {
              const auto = implied[code];
              const usdTotal = filled.filter((l) => l.currency === 'USD').reduce((t, l) => t.plus(tryDec(l.amount)), new Decimal(0));
              const codeTotal = filled.filter((l) => l.currency === code).reduce((t, l) => t.plus(tryDec(l.amount)), new Decimal(0));
              return (
                <Field
                  key={code}
                  label={`1 USD = ? ${code}`}
                  htmlFor={`jv-rate-${code}`}
                  hint={
                    auto
                      ? `Worked out from your amounts: ${code} ${codeTotal.toFixed(2)} ÷ USD ${usdTotal.toFixed(2)}`
                      : code === localCurrency
                        ? `Also gives the ${localCurrency} value of the USD lines in the books.`
                        : undefined
                  }
                >
                  <Input
                    id={`jv-rate-${code}`}
                    aria-label={`Exchange rate ${code} per USD`}
                    inputMode="decimal"
                    className="tnum"
                    value={auto ? auto.toString() : (rates[code] ?? '')}
                    readOnly={Boolean(auto)}
                    onChange={(e) => setRates((current) => ({ ...current, [code]: e.target.value }))}
                    aria-invalid={!auto && (rates[code] ?? '').trim() !== '' && !tryDec(rates[code]).greaterThan(0)}
                  />
                </Field>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {supplierPayment ? (
        <Card data-testid="jv-supplier-payment">
          <CardHeader>
            <CardTitle>Payment to {optionOf(supplierPayment.supplier.option)?.label}</CardTitle>
            <CardDescription>
              Posted as a supplier payment from {optionOf(supplierPayment.bank.option)?.label}, so the supplier&rsquo;s balance and the order it pays move together.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Field label="What does this pay?" htmlFor="jv-settles" required>
              <Select id="jv-settles" value={settles} onChange={(e) => setSettles(e.target.value)}>
                <option value="">Choose…</option>
                {(openItems ?? []).map((item) => (
                  <option key={item.id} value={`${item.kind}:${item.id}`} disabled={item.currency !== supplierPayment.supplier.currency}>
                    {item.label} — {item.currency} {Number(item.outstanding).toLocaleString(undefined, { minimumFractionDigits: 2 })} still owed
                    {item.currency !== supplierPayment.supplier.currency ? ` (owed in ${item.currency})` : ''}
                  </option>
                ))}
                <option value="ADVANCE:">Advance to the supplier — no invoice yet</option>
              </Select>
            </Field>
            {openItems === null ? <p className="mt-1 text-xs text-ink-subtle">Loading the supplier&rsquo;s open orders…</p> : null}
          </CardContent>
        </Card>
      ) : null}

      <Card data-testid="jv-preview">
        <CardHeader>
          <CardTitle>Accounting preview</CardTitle>
          <CardDescription>What will be posted, in {localCurrency}. Nothing is written until you press Post entry.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {fromTo ? (
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]" data-testid="jv-from-to">
              <dt className="text-ink-muted">From</dt>
              <dd>
                {optionOf(fromTo.from.option)?.label}
                {tryDec(fromTo.from.amount).greaterThan(0) ? ` — ${formatMoney(fromTo.from.amount, fromTo.from.currency)}` : ''}
              </dd>
              <dt className="text-ink-muted">To</dt>
              <dd>
                {optionOf(fromTo.to.option)?.label}
                {tryDec(fromTo.to.amount).greaterThan(0) ? ` — ${formatMoney(fromTo.to.amount, fromTo.to.currency)}` : ''}
              </dd>
              {fromTo.from.currency !== fromTo.to.currency ? (
                <>
                  <dt className="text-ink-muted">Exchange rate</dt>
                  <dd data-testid="jv-effective-rate">
                    1 USD = {rateOf(fromTo.from.currency === 'USD' ? fromTo.to.currency : fromTo.from.currency).toString()}{' '}
                    {fromTo.from.currency === 'USD' ? fromTo.to.currency : fromTo.from.currency}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm" data-testid="jv-preview-lines">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-muted">
                  <th className="py-1.5 pr-3 font-semibold">Account</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Original amount</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Debit ({localCurrency})</th>
                  <th className="py-1.5 text-right font-semibold">Credit ({localCurrency})</th>
                </tr>
              </thead>
              <tbody>
                {(posted
                  ? posted.lines.map((l, i) => ({ key: `p${i}`, account: l.account, original: formatMoney(l.amount, l.currency), direction: l.direction, local: new Decimal(l.amountLocal) }))
                  : lines.map((l) => {
                      const v = valueOf(l);
                      return {
                        key: l.key,
                        account: optionOf(l.option)?.label ?? '—',
                        original: tryDec(l.amount).greaterThan(0) ? formatMoney(l.amount, l.currency) : '—',
                        direction: l.direction,
                        local: v?.local ?? null,
                      };
                    })
                ).map((row) => (
                  <tr key={row.key} className="border-b border-line/60">
                    <td className="py-1.5 pr-3">{row.account}</td>
                    <td className="tnum py-1.5 pr-3 text-right text-ink-muted">{row.original}</td>
                    <td className="tnum py-1.5 pr-3 text-right">{row.direction === 'DEBIT' && row.local ? formatMoney(row.local, localCurrency) : ''}</td>
                    <td className="tnum py-1.5 text-right">{row.direction === 'CREDIT' && row.local ? formatMoney(row.local, localCurrency) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {(() => {
                  const dr = posted ? posted.lines.filter((l) => l.direction === 'DEBIT').reduce((t, l) => t.plus(l.amountLocal), new Decimal(0)) : totals.debitLocal;
                  const cr = posted ? posted.lines.filter((l) => l.direction === 'CREDIT').reduce((t, l) => t.plus(l.amountLocal), new Decimal(0)) : totals.creditLocal;
                  const diff = posted ? new Decimal(posted.difference) : settled ? new Decimal(0) : totals.differenceLocal;
                  return (
                    <>
                      <tr className="font-semibold">
                        <td className="py-1.5 pr-3">Total</td>
                        <td />
                        <td className="tnum py-1.5 pr-3 text-right">{formatMoney(dr, localCurrency)}</td>
                        <td className="tnum py-1.5 text-right">{formatMoney(cr, localCurrency)}</td>
                      </tr>
                      <tr>
                        <td className="py-1.5 pr-3 text-ink-muted">Difference</td>
                        <td />
                        <td />
                        <td className={cn('tnum py-1.5 text-right font-semibold', diff.abs().lessThan('0.01') ? 'text-emerald-700' : 'text-red-600')} data-testid="jv-difference">
                          {formatMoney(diff.abs().lessThan('0.01') ? 0 : diff, localCurrency)}
                        </td>
                      </tr>
                    </>
                  );
                })()}
              </tfoot>
            </table>
          </div>
          {supplierPayment && posted ? (
            <p className="text-xs text-ink-subtle">
              This is the payment&rsquo;s own entry, worked out by the posting service. An order is cleared at the value it was booked at; any difference from
              the rate paid is the exchange gain or loss.
            </p>
          ) : null}
          {previewError ? <p className="text-xs font-medium text-red-600">{previewError}</p> : null}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {imbalanceReason ? <p className="text-xs font-medium text-amber-700">{imbalanceReason}</p> : <span />}
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                  balanced ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-amber-50 text-amber-700 ring-amber-200',
                )}
              >
                <Scale className="size-3.5" />
                {balanced ? 'Balanced' : 'Not balanced'}
              </span>
              <Button onClick={submit} loading={busy}>
                Post entry
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <Callout tone="danger" title="The entry was not posted">
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
        localCurrency={localCurrency}
        onCreated={onAccountCreated}
      />
    </div>
  );
}
