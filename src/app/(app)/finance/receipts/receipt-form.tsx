'use client';

import { transactionCurrencies, CURRENCY_NAMES } from '@/lib/company-currencies';
import * as React from 'react';
import { MasterSelect } from '@/components/shared/master-select';
import { customerCreateSpec, cashBankCreateSpec } from '@/components/shared/master-specs';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Wallet } from 'lucide-react';
import { focusFirstError } from '@/lib/focus-first-error';
import { FormError } from '@/components/shared/form-error';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { dec, tryDec, toMoney, sum, convertToUsd } from '@/lib/money';
import { formatMoney, formatDate, todayInputValue } from '@/lib/format';
import { saveReceiptAction, postReceiptAction } from '@/server/actions/finance-actions';
import { useSaveAndOpen } from '@/lib/use-save-and-open';
import { accountsFor } from '@/lib/cash-account-choice';
import { ROUND_OFF_LIMIT, TIP_LIMIT } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { LedgerAccountField } from '@/components/shared/ledger-account-field';
import { ledgerTargetPayload, ledgerTargetValue } from '@/lib/ledger-target';
import type { LedgerSettlementOption } from '@/lib/services/ledger-settlement';
import { AddAgentDialog } from '@/app/(app)/finance/receipts/add-agent';
import { shortDocumentNumber } from '@/lib/short-number';
import { useClientKey } from '@/lib/use-client-key';

/**
 * Customer receipt.
 *
 * The Dubai case this exists for: a customer owes USD but pays in AED at a rate
 * agreed for that specific payment. The user can type either the rate or the
 * USD value they agreed — whichever they actually negotiated — and the other is
 * derived and stored on the voucher for good.
 */

/** What to do with the few dirhams an invoice is short by. */
export type Shortfall = 'KEEP_OUTSTANDING' | 'ROUND_OFF' | 'OTHER_ADJUSTMENT';

export type OpenInvoice = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  outstanding: string;
  customerId: string;
};

export type BankOption = ComboOption & { currency: string; accountType: 'CASH' | 'PETTY_CASH' | 'BANK' };

export type ReceiptInitial = {
  id: string;
  status: string;
  receiptNumber: string;
  receiptDate: string;
  customerId: string;
  currency: string;
  amount: string;
  rateToUsd: string;
  rateLocalPerUsd: string;
  paymentMethod: string;
  cashBankAccountId: string | null;
  ledgerAccountId?: string | null;
  ledgerAgentId?: string | null;
  agentId: string | null;
  reference: string;
  description: string;
  allocations: Array<{ salesInvoiceId: string; amount: string; shortfall?: Shortfall; writeOffReason?: string | null }>;
  cheque: { chequeNumber: string; chequeDate: string; bankName: string; beneficiary: string } | null;
};

export function ReceiptForm({
  customers,
  accounts,
  ledgerAccounts = [],
  invoices,
  localCurrency,
  defaultLocalRate,
  ratesByCurrency,
  preselectedInvoiceId,
  agents,
  canCreateCashBank = false,
  canPost = true,
  canWriteOff = false,
  initial,
}: {
  customers: Array<ComboOption & { currency: string }>;
  accounts: BankOption[];
  /** Accounts a receipt may be settled against, ledger to ledger. */
  ledgerAccounts?: LedgerSettlementOption[];
  invoices: OpenInvoice[];
  localCurrency: string;
  defaultLocalRate: string;
  ratesByCurrency?: Record<string, string>;
  preselectedInvoiceId?: string;
  /** Collection agents from the master list. Names are never hardcoded. */
  agents: Array<{ id: string; name: string }>;
  canPost?: boolean;
  /** May write a shortfall off: the same permission as posting a credit note. */
  canWriteOff?: boolean;
  /** Opening a drawer creates a ledger account, so it is its own permission. */
  canCreateCashBank?: boolean;
  /**
   * An existing receipt, opened to be corrected.
   *
   * A posted one is rewritten under the same number: the old posting comes
   * out of the books and the new one goes on, which is what somebody holding
   * the paper expects.
   */
  initial?: ReceiptInitial;
}) {
  const router = useRouter();
  const clientKey = useClientKey();
  const { busy, start, opening } = useSaveAndOpen();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = React.useState<Record<string, string>>({});
  const [addAgentOpen, setAddAgentOpen] = React.useState(false);
  const [agentOptions, setAgentOptions] = React.useState<ComboOption[]>(() =>
    agents.map((agent) => ({ value: agent.id, label: agent.name })),
  );

  const preselected = invoices.find((i) => i.id === preselectedInvoiceId);
  // Before a customer is chosen, the company's own currency — never a silent USD.
  const initialCurrency = preselected?.currency ?? localCurrency;
  const rateFor = React.useCallback(
    (currency: string) =>
      currency === 'USD' ? '1' : (ratesByCurrency?.[currency] ?? defaultLocalRate),
    [ratesByCurrency, defaultLocalRate],
  );

  const [form, setForm] = React.useState({
    receiptDate: initial?.receiptDate ?? todayInputValue(),
    customerId: initial?.customerId ?? preselected?.customerId ?? null,
    currency: initial?.currency ?? initialCurrency,
    amount: initial?.amount ?? preselected?.outstanding ?? '',
    rateToUsd: initial?.rateToUsd ?? rateFor(initialCurrency),
    usdEquivalent: '',
    rateLocalPerUsd: initial?.rateLocalPerUsd ?? defaultLocalRate,
    paymentMethod: initial?.paymentMethod ?? 'BANK_TRANSFER',
    cashBankAccountId: (initial?.cashBankAccountId ?? null) as string | null,
    ledgerAccountId: ledgerTargetValue(initial?.ledgerAccountId, initial?.ledgerAgentId),
    reference: initial?.reference ?? '',
    description: initial?.description ?? '',
    chequeNumber: initial?.cheque?.chequeNumber ?? '',
    chequeDate: initial?.cheque?.chequeDate ?? '',
    bankName: initial?.cheque?.bankName ?? '',
    beneficiary: initial?.cheque?.beneficiary ?? '',
    agentId: (initial?.agentId ?? null) as string | null,
  });

  const [allocations, setAllocationsState] = React.useState<Record<string, string>>(
    initial
      ? Object.fromEntries(initial.allocations.map((a) => [a.salesInvoiceId, a.amount]))
      : preselected
        ? { [preselected.id]: preselected.outstanding }
        : {},
  );
  /*
   * "Amount received" follows what is applied to invoices until the user
   * types it themselves. Lowering Invoice 15's allocation to the MAD 80,000
   * actually paid used to leave the amount at the full MAD 126,000, and the
   * other MAD 46,000 was booked as an advance nobody had paid.
   */
  // An amount already on a saved receipt is one somebody typed.
  const [amountTyped, setAmountTyped] = React.useState(Boolean(initial));
  const [keepRemainderAsAdvance, setKeepRemainderAsAdvance] = React.useState(false);
  /*
   * The other direction: more money than the invoices come to. It is the
   * customer's advance unless they said to keep it, which makes it a tip.
   */
  const [overpayment, setOverpayment] = React.useState<'ADVANCE' | 'TIP'>('ADVANCE');
  const [tipReason, setTipReason] = React.useState('');
  /*
   * A customer who settles 112,928 with 112,920 leaves eight dirhams. Per
   * invoice: keep them owed (the default and the honest answer), or write
   * them off as a round-off or another adjustment, which clears the invoice
   * exactly and puts the giveaway on the profit and loss.
   */
  const [shortfalls, setShortfalls] = React.useState<Record<string, Shortfall>>(
    initial ? Object.fromEntries(initial.allocations.map((a) => [a.salesInvoiceId, a.shortfall ?? 'KEEP_OUTSTANDING'])) : {},
  );
  const [writeOffReasons, setWriteOffReasons] = React.useState<Record<string, string>>(
    initial ? Object.fromEntries(initial.allocations.map((a) => [a.salesInvoiceId, a.writeOffReason ?? ''])) : {},
  );
  function setAllocations(next: Record<string, string>) {
    setAllocationsState(next);
    if (!amountTyped) {
      const applied = sum(Object.values(next).filter(Boolean).map((v) => tryDec(v)));
      setForm((prev) => ({ ...prev, amount: applied.greaterThan(0) ? applied.toString() : prev.amount }));
    }
  }
  const [entryMode, setEntryMode] = React.useState<'rate' | 'usd'>('rate');

  const customerInvoices = React.useMemo(
    () => invoices.filter((i) => i.customerId === form.customerId),
    [invoices, form.customerId],
  );

  const isForeign = form.currency !== 'USD';
  /*
   * Money received in the company's own currency is not a conversion.
   *
   * A Morocco customer pays dirhams against a dirham invoice: there is no rate
   * to agree and no dollar amount to negotiate. The card still has to collect
   * the group reporting rate, but it asks for that one number and says what it
   * is for, instead of offering "I agreed a rate / I agreed a USD amount".
   */
  const isHomeMoney = form.currency === localCurrency && localCurrency !== 'USD';
  const isCheque = form.paymentMethod === 'CHEQUE';

  // Cash goes into the drawer without asking; a bank transfer still needs to
  // say which bank.
  const accountChoice = React.useMemo(
    () => accountsFor(accounts, form.paymentMethod, form.currency),
    [accounts, form.paymentMethod, form.currency],
  );
  const cashBankAccountId = accountChoice.automatic ?? form.cashBankAccountId;
  /*
   * The customer has paid; the company has not. The money is with the agent
   * until he hands it over, so there is no account to choose here — asking for
   * one would put money in the bank that is not there.
   */
  const isAgentCollection = form.paymentMethod === 'AGENT_COLLECTION';
  // Settled against another account in the books: no drawer to choose.
  const isLedger = form.paymentMethod === 'LEDGER_TRANSFER';

  // The USD value of this receipt, however the user chose to express it.
  const amountUsd = React.useMemo(() => {
    if (!form.amount) return dec(0);
    try {
      if (!isForeign) return toMoney(form.amount);
      if (entryMode === 'usd') return form.usdEquivalent ? toMoney(form.usdEquivalent) : dec(0);
      return form.rateToUsd ? convertToUsd(form.amount, form.rateToUsd, form.currency) : dec(0);
    } catch {
      return dec(0);
    }
  }, [form.amount, form.rateToUsd, form.usdEquivalent, form.currency, entryMode, isForeign]);

  const derivedRate = React.useMemo(() => {
    if (!isForeign || entryMode !== 'usd') return null;
    if (!form.amount || !form.usdEquivalent || Number(form.usdEquivalent) === 0) return null;
    try {
      return dec(form.amount).dividedBy(dec(form.usdEquivalent)).toDecimalPlaces(8);
    } catch {
      return null;
    }
  }, [form.amount, form.usdEquivalent, entryMode, isForeign]);

  /** What is still owed on an invoice after the amount applied to it here. */
  function shortfallOn(invoiceId: string, applied: string | undefined) {
    const invoice = invoices.find((i) => i.id === invoiceId);
    if (!invoice || !applied) return dec(0);
    const left = tryDec(invoice.outstanding).minus(tryDec(applied));
    return left.greaterThan(0) ? left : dec(0);
  }

  const allocatedTotal = sum(Object.values(allocations).filter(Boolean).map((v) => tryDec(v)));
  // Received but not applied: only ever an advance when the user says so.
  const remainder = (() => {
    const received = tryDec(form.amount);
    return received.greaterThan(allocatedTotal) ? received.minus(allocatedTotal) : dec(0);
  })();

  function submit(andPost: boolean) {
    setError(null);
    setFieldIssues({});

    if (isAgentCollection && !form.agentId) {
      setFieldIssues({ agentId: 'Choose the agent who collected this money.' });
      focusFirstError();
      return;
    }
    if (isLedger && !form.ledgerAccountId) {
      setFieldIssues({ ledgerAccountId: 'Choose the ledger account on the other side.' });
      focusFirstError();
      return;
    }

    /*
     * A cheque the agent took away is recorded as a cheque, not as a note.
     *
     * Its number used to be pushed into the reference text, which left
     * nothing that could be marked pending, cleared or bounced. Now the
     * instrument is sent properly whenever a number was given, and the
     * reference goes back to being the reference.
     */
    const agentCheque = isAgentCollection && form.chequeNumber.trim() ? {
      chequeNumber: form.chequeNumber,
      chequeDate: form.chequeDate || form.receiptDate,
      bankName: form.bankName,
      beneficiary: form.beneficiary,
      agentId: form.agentId ?? '',
      notes: '',
    } : null;

    const payload = {
      clientKey: clientKey(),
      receiptDate: form.receiptDate,
      customerId: form.customerId,
      currency: form.currency,
      amount: form.amount,
      rateToUsd: !isForeign ? '1' : entryMode === 'rate' ? form.rateToUsd : '',
      usdEquivalent: isForeign && entryMode === 'usd' && form.usdEquivalent ? form.usdEquivalent : undefined,
      rateLocalPerUsd: form.currency === localCurrency ? form.rateToUsd || '1' : form.rateLocalPerUsd,
      paymentMethod: form.paymentMethod,
      cashBankAccountId: isLedger ? '' : (cashBankAccountId ?? ''),
      ...ledgerTargetPayload(isLedger ? form.ledgerAccountId : null),
      agentId: isAgentCollection || isCheque ? (form.agentId ?? '') : '',
      cheque: isCheque
        ? {
            chequeNumber: form.chequeNumber,
            chequeDate: form.chequeDate || form.receiptDate,
            bankName: form.bankName,
            beneficiary: form.beneficiary,
            agentId: form.agentId ?? '',
            notes: '',
          }
        : agentCheque,
      shipmentId: '',
      reference: form.reference,
      description: form.description,
      allocations: Object.entries(allocations)
        .filter(([, amount]) => amount && Number(amount) > 0)
        .map(([salesInvoiceId, amount]) => {
          // Only a real shortfall carries a decision; nothing to write off
          // means the default, whatever radio was last touched.
          const short = shortfallOn(salesInvoiceId, amount);
          const choice = short.greaterThan('0.005') ? (shortfalls[salesInvoiceId] ?? 'KEEP_OUTSTANDING') : 'KEEP_OUTSTANDING';
          return {
            salesInvoiceId,
            amount,
            shortfall: choice,
            writeOffReason: choice === 'KEEP_OUTSTANDING' ? '' : (writeOffReasons[salesInvoiceId] ?? ''),
          };
        }),
      keepRemainderAsAdvance: remainder.greaterThan('0.005') ? keepRemainderAsAdvance : undefined,
      overpayment: remainder.greaterThan('0.005') ? overpayment : 'ADVANCE',
      tipReason: remainder.greaterThan('0.005') && overpayment === 'TIP' ? tipReason : '',
    };

    start(async () => {
      const result = await saveReceiptAction(initial?.id ?? null, JSON.stringify(payload));
      if (!result?.ok) {
        setError(result?.error ?? 'The receipt could not be saved.');
        setFieldIssues(result && !result.ok ? (result.errors ?? {}) : {});
        focusFirstError();
        return;
      }

      // A posted receipt is re-posted by the save itself; only a draft needs
      // posting afterwards.
      if (andPost && initial?.status !== 'POSTED') {
        const posted = await postReceiptAction(result.id);
        if (!posted.ok) {
          setError(posted.error);
          opening();
          router.push(`/finance/receipts/${result.id}`);
          return;
        }
        toast.success('Receipt posted.');
      } else if (initial?.status === 'POSTED') {
        toast.success('Receipt corrected. The old posting is out of the books and the new one is on.');
      } else {
        toast.success('Receipt saved as a draft.');
      }

      opening();

      router.push(`/finance/receipts/${result.id}`);
    });
  }

  if (customers.length === 0) {
    return <EmptyState icon={Wallet} title="No customers yet" description="Add a customer before recording a receipt." />;
  }

  return (
    <div className="space-y-5">
      <FormError message={error} fieldErrors={fieldIssues} />

      <Card>
        <CardHeader>
          <CardTitle>Receipt</CardTitle>
          <CardDescription>Who paid, how much, and how the money arrived.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Customer" required error={fieldIssues.customerId}>
            <MasterSelect
              autoFocus
              options={customers}
              value={form.customerId}
              onChange={(value) => {
                const customer = customers.find((c) => c.value === value);
                const nextCurrency = customer?.currency ?? form.currency;
                setForm({
                  ...form,
                  customerId: value,
                  currency: nextCurrency,
                  rateToUsd: rateFor(nextCurrency),
                });
                setAllocations({});
              }}
              placeholder="Choose a customer…"
              invalid={Boolean(fieldIssues.customerId)}
              create={customerCreateSpec(form.currency, localCurrency)}
              onCreated={(created) => {
                // A receipt is stated in the customer's own currency, so the
                // new account's currency has to reach the voucher too.
                setForm((prev) => ({
                  ...prev,
                  customerId: created.id,
                  currency: created.currency,
                  rateToUsd: rateFor(created.currency),
                }));
                setAllocations({});
              }}
            />
          </Field>

          <Field label="Receipt date" error={fieldIssues.receiptDate}>
            <Input type="date" value={form.receiptDate} onChange={(e) => setForm({ ...form, receiptDate: e.target.value })} />
          </Field>

          <Field label="Payment method" required>
            <Select
              value={form.paymentMethod}
              onChange={(e) => setForm({ ...form, paymentMethod: e.target.value, cashBankAccountId: null })}
            >
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="CASH">Cash</option>
              <option value="CHEQUE">Cheque (held by FID)</option>
              <option value="AGENT_COLLECTION">Agent cheque / Agent collection</option>
              <option value="LEDGER_TRANSFER">Ledger to ledger</option>
            </Select>
          </Field>

          <Field
            label="Currency received"
            required
            hint="The currency the money actually arrived in."
          >
            <Select
              value={form.currency}
              onChange={(e) =>
                setForm({
                  ...form,
                  currency: e.target.value,
                  rateToUsd: rateFor(e.target.value),
                  cashBankAccountId: null,
                  ledgerAccountId: null,
                })
              }
            >
              {transactionCurrencies(localCurrency).map((code) => (
                <option key={code} value={code}>
                  {code} — {CURRENCY_NAMES[code] ?? code}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Amount received" required error={fieldIssues.amount}>
            <MoneyInput
              currency={form.currency}
              value={form.amount}
              onChange={(e) => {
                setAmountTyped(true);
                setForm({ ...form, amount: e.target.value });
              }}
            />
          </Field>

          {isLedger ? (
            <LedgerAccountField
              id="receiptLedgerAccount"
              label="Settled through"
              options={ledgerAccounts}
              currency={form.currency}
              value={form.ledgerAccountId}
              onChange={(value) => setForm({ ...form, ledgerAccountId: value })}
              error={fieldIssues.ledgerAccountId}
            />
          ) : null}

          {!isCheque && !isAgentCollection && !isLedger ? (
            <Field
              label="Deposit to"
              required
              hint={
                accountChoice.automatic
                  ? 'Cash goes straight into Cash in Hand.'
                  : `Only ${form.currency} accounts are shown.`
              }
              error={fieldIssues.cashBankAccountId}
            >
              <MasterSelect
                options={accountChoice.options}
                value={cashBankAccountId}
                onChange={(value) => setForm({ ...form, cashBankAccountId: value })}
                placeholder="Choose an account…"
                emptyText={`No ${form.currency} account exists`}
                create={
                  canCreateCashBank
                    ? cashBankCreateSpec(form.currency, form.paymentMethod === 'CASH' ? 'CASH' : 'BANK', localCurrency)
                    : undefined
                }
              />
            </Field>
          ) : null}

          {isAgentCollection ? (
            <>
              <Field
                label="Agent"
                htmlFor="receiptAgent"
                required
                hint={
                  agentOptions.length === 0
                    ? 'Open the list and choose + Add New Agent.'
                    : 'The money stays with the agent until they hand it over. Cash and bank do not increase yet.'
                }
                error={fieldIssues.agentId}
              >
                <Combobox
                  id="receiptAgent"
                  options={agentOptions}
                  value={form.agentId}
                  onChange={(value) => setForm({ ...form, agentId: value })}
                  placeholder="Choose an agent…"
                  emptyText="No matching agent"
                  createLabel="+ Add New Agent"
                  onCreate={() => setAddAgentOpen(true)}
                  invalid={Boolean(fieldIssues.agentId)}
                />
              </Field>
              <Field
                label="Cheque number"
                hint="Leave blank if the agent took cash. Give the number and the cheque can be tracked, cleared or bounced."
              >
                <Input
                  value={form.chequeNumber}
                  onChange={(e) => setForm({ ...form, chequeNumber: e.target.value })}
                  placeholder="Optional"
                />
              </Field>
              {form.chequeNumber.trim() ? (
                <>
                  <Field
                    label="Cheque date"
                    hint="A cheque dated a few days ahead is still recorded now; it simply stays pending."
                  >
                    <Input
                      type="date"
                      value={form.chequeDate}
                      onChange={(e) => setForm({ ...form, chequeDate: e.target.value })}
                    />
                  </Field>
                  <Field label="Bank" hint="The customer's bank, if it is known.">
                    <Input
                      value={form.bankName}
                      onChange={(e) => setForm({ ...form, bankName: e.target.value })}
                      placeholder="Optional"
                    />
                  </Field>
                </>
              ) : null}
            </>
          ) : null}

          <Field
            label={isAgentCollection ? 'Reference / remarks' : 'Reference'}
            hint={isAgentCollection ? 'Optional.' : undefined}
          >
            <Input
              value={form.reference}
              onChange={(e) => setForm({ ...form, reference: e.target.value })}
              placeholder={isAgentCollection ? 'Optional' : 'Transfer reference'}
            />
          </Field>
        </CardContent>
      </Card>

      {isAgentCollection ? (
        <Callout tone="info" title="This does not put money in the bank">
          The customer&rsquo;s outstanding falls by this amount. FID cash and bank do not increase. The money is
          receivable from the agent until you record <strong>Received from agent</strong> on their ledger page.
        </Callout>
      ) : null}

      {isCheque ? (
        <Card>
          <CardHeader>
            <CardTitle>Cheque details</CardTitle>
            <CardDescription>
              Use this when FID is holding the cheque. If the customer gave the cheque to an agent, choose{' '}
              <strong>Agent cheque / Agent collection</strong> instead — otherwise cash would appear to land here
              when it is still with the agent.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <Field label="Cheque number" required>
              <Input value={form.chequeNumber} onChange={(e) => setForm({ ...form, chequeNumber: e.target.value })} />
            </Field>
            <Field label="Cheque date" required>
              <Input type="date" value={form.chequeDate} onChange={(e) => setForm({ ...form, chequeDate: e.target.value })} />
            </Field>
            <Field label="Drawee bank" required>
              <Input value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} />
            </Field>

            {/*
              A customer's cheque is not always written out to this company. It
              is often made out to the agent who introduced the trade. The name
              on the cheque is recorded here so the two can be matched when it
              clears. Who that agent is comes from the agent master — nobody's
              name is written into the system itself.
            */}
            <Field
              label="Made out to"
              hint="Leave blank if the cheque is in this company's name."
            >
              <Input
                value={form.beneficiary}
                onChange={(e) => setForm({ ...form, beneficiary: e.target.value })}
                placeholder="Name written on the cheque"
              />
            </Field>

            <Field
              label="Agent"
              htmlFor="chequeAgent"
              hint="If the cheque is in an agent's name. Prefer Agent collection when the agent is holding it."
            >
              <Combobox
                id="chequeAgent"
                options={agentOptions}
                value={form.agentId}
                onChange={(value) => setForm({ ...form, agentId: value })}
                placeholder="Not through an agent"
                emptyText="No matching agent"
                createLabel="+ Add New Agent"
                onCreate={() => setAddAgentOpen(true)}
              />
            </Field>
          </CardContent>
        </Card>
      ) : null}

      {/* Money received in the company's own currency asks for no exchange rate: the
          reporting rate is filled in quietly from the rate table, as on the invoice. */}
      {isForeign && !(isHomeMoney && form.rateToUsd) ? (
        <Card>
          <CardHeader>
            <CardTitle>{isHomeMoney ? 'Group reporting rate' : 'Conversion'}</CardTitle>
            <CardDescription>
              {isHomeMoney
                ? `This receipt is ${form.currency}, the same as the books. The rate only states it in dollars for group reporting — it does not change what was received or what the invoice settles.`
                : 'Enter whichever you actually agreed. The rate is stored on this receipt permanently and is never restated by a later change to the rate table.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* No rate-or-amount choice on home money: there is nothing to
                have agreed, so the toggle only invited a wrong answer. */}
            <div className={cn('inline-flex rounded-lg border border-line-strong p-0.5', isHomeMoney && 'hidden')}>
              {(['rate', 'usd'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setEntryMode(mode)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    entryMode === mode ? 'bg-forest-800 text-white' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {mode === 'rate' ? 'I agreed a rate' : 'I agreed a USD amount'}
                </button>
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              {entryMode === 'rate' || isHomeMoney ? (
                <Field
                  label={`Rate (${form.currency} per 1 USD)`}
                  required
                  error={fieldIssues.rateToUsd}
                  hint={isHomeMoney ? 'For group reporting only.' : 'e.g. 3.6725'}
                >
                  <Input
                    value={form.rateToUsd}
                    onChange={(e) => setForm({ ...form, rateToUsd: e.target.value })}
                    className="tnum text-right"
                  />
                </Field>
              ) : (
                <Field label="USD equivalent agreed" required error={fieldIssues.rateToUsd}>
                  <MoneyInput
                    currency="USD"
                    value={form.usdEquivalent}
                    onChange={(e) => setForm({ ...form, usdEquivalent: e.target.value })}
                  />
                </Field>
              )}

              {form.currency !== localCurrency ? (
                <Field
                  label={`Rate (${localCurrency} per 1 USD)`}
                  required
                  hint="For this company's own reporting."
                >
                  <Input
                    value={form.rateLocalPerUsd}
                    onChange={(e) => setForm({ ...form, rateLocalPerUsd: e.target.value })}
                    className="tnum text-right"
                  />
                </Field>
              ) : null}

              <Field label={entryMode === 'rate' ? 'USD equivalent' : 'Implied rate'}>
                <div className="tnum flex h-10 items-center justify-end rounded-lg border border-line bg-forest-50 px-3 text-sm font-semibold">
                  {entryMode === 'rate'
                    ? formatMoney(amountUsd, 'USD')
                    : derivedRate
                      ? derivedRate.toString()
                      : '—'}
                </div>
              </Field>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {form.customerId ? (
        <Card>
          <CardHeader>
            <CardTitle>Apply to invoices</CardTitle>
            <CardDescription>
              Leave blank to hold the money on account. Partial settlement is normal — an invoice can be paid in as
              many instalments as needed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {customerInvoices.length === 0 ? (
              <p className="py-4 text-center text-xs text-ink-subtle">This customer has no outstanding invoices.</p>
            ) : (
              customerInvoices.map((invoice) => {
                const applied = allocations[invoice.id] ?? '';
                const short = shortfallOn(invoice.id, applied);
                const hasShortfall = short.greaterThan('0.005');
                const choice = shortfalls[invoice.id] ?? 'KEEP_OUTSTANDING';
                const needsReason =
                  (choice === 'ROUND_OFF' && short.greaterThan(ROUND_OFF_LIMIT)) || choice === 'OTHER_ADJUSTMENT';
                return (
                <div key={invoice.id} className="space-y-3 rounded-lg border border-line p-3" data-invoice={invoice.invoiceNumber}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{shortDocumentNumber(invoice.invoiceNumber)}</p>
                      <p className="text-xs text-ink-subtle">
                        {formatDate(invoice.invoiceDate)} · {formatMoney(invoice.outstanding, invoice.currency)} outstanding
                      </p>
                    </div>
                    <div className="w-36 shrink-0">
                      <MoneyInput
                        aria-label={`Amount applied to the invoice of ${invoice.invoiceDate}`}
                        currency={invoice.currency}
                        value={applied}
                        onChange={(e) => setAllocations({ ...allocations, [invoice.id]: e.target.value })}
                        placeholder="0.00"
                      />
                    </div>
                  </div>

                  {hasShortfall ? (
                    <div className="space-y-2 rounded-lg bg-surface-sunken p-3 text-xs" data-testid="shortfall">
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                        <dt className="text-ink-muted">Outstanding</dt>
                        <dd className="tnum text-right">{formatMoney(invoice.outstanding, invoice.currency)}</dd>
                        <dt className="text-ink-muted">Applied here</dt>
                        <dd className="tnum text-right">{formatMoney(tryDec(applied), invoice.currency)}</dd>
                        <dt className="font-medium text-ink">Difference</dt>
                        <dd className="tnum text-right font-semibold text-amber-800" data-testid="shortfall-amount">
                          −{formatMoney(short, invoice.currency)}
                        </dd>
                      </dl>
                      <fieldset className="space-y-1">
                        <legend className="text-ink-muted">How should the difference be handled?</legend>
                        {(
                          [
                            ['KEEP_OUTSTANDING', 'Keep outstanding', 'Still owed on this invoice.'],
                            ...(canWriteOff
                              ? ([
                                  ['ROUND_OFF', 'Discount or tip given', 'The customer keeps it with our agreement — a discount, a tip, a rounding. The invoice is settled and it goes to Discounts, Tips & Round-Off Allowed.'],
                                  ['OTHER_ADJUSTMENT', 'Other adjustment', 'Settled short for another reason — a bank charge the customer deducted, say. Goes to Settlement Adjustments.'],
                                ] as const)
                              : []),
                          ] as const
                        ).map(([value, label, hint]) => (
                          <label key={value} className="flex items-start gap-2">
                            <input
                              type="radio"
                              name={`shortfall-${invoice.id}`}
                              className="mt-0.5 size-4 shrink-0 accent-gold-600"
                              value={value}
                              checked={choice === value}
                              onChange={() => setShortfalls({ ...shortfalls, [invoice.id]: value })}
                            />
                            <span>
                              <span className="font-medium text-ink">{label}</span>
                              <span className="block text-ink-subtle">{hint}</span>
                            </span>
                          </label>
                        ))}
                      </fieldset>
                      {choice !== 'KEEP_OUTSTANDING' ? (
                        <Input
                          aria-label={`Why ${formatMoney(short, invoice.currency)} is not being collected on invoice ${shortDocumentNumber(invoice.invoiceNumber)}`}
                          value={writeOffReasons[invoice.id] ?? ''}
                          onChange={(e) => setWriteOffReasons({ ...writeOffReasons, [invoice.id]: e.target.value })}
                          placeholder={
                            choice === 'ROUND_OFF'
                              ? `Why it is not collected${needsReason ? ' (required)' : ' (optional)'}`
                              : `What the adjustment is for${needsReason ? ' (required)' : ' (optional)'}`
                          }
                        />
                      ) : null}
                      {needsReason && !(writeOffReasons[invoice.id] ?? '').trim() ? (
                        <p className="text-amber-800" role="alert">
                          {choice === 'OTHER_ADJUSTMENT'
                            ? 'Say what this adjustment is for.'
                            : `More than ${invoice.currency} ${ROUND_OFF_LIMIT} is more than a rounding — say why it is given away, or keep it outstanding.`}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                );
              })
            )}

            {allocatedTotal.greaterThan(0) ? (
              <p className="text-right text-xs text-ink-muted">
                Applied: <span className="tnum font-semibold text-ink">{allocatedTotal.toString()}</span> ·
                Receipt worth <span className="tnum font-semibold text-ink">{formatMoney(amountUsd, 'USD')}</span>
              </p>
            ) : null}

            {remainder.greaterThan('0.005') ? (
              <div
                className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"
                role="alert"
                data-testid="overpayment"
              >
                <p className="text-amber-900">
                  <strong>{formatMoney(remainder, form.currency)}</strong> of this receipt is not applied to any invoice. If
                  that money was not actually received, lower <em>Amount received</em> to what was.
                </p>
                <label className="flex items-center gap-2 text-amber-900">
                  <input
                    type="checkbox"
                    className="size-4 accent-gold-600"
                    checked={keepRemainderAsAdvance}
                    onChange={(e) => setKeepRemainderAsAdvance(e.target.checked)}
                  />
                  It was received — keep {formatMoney(remainder, form.currency)} on the customer&rsquo;s account as an advance
                </label>
                {keepRemainderAsAdvance ? (
                  <fieldset className="space-y-1 border-t border-amber-300 pt-2 text-xs text-amber-900">
                    <legend className="sr-only">What the extra money is</legend>
                    {(
                      [
                        ['ADVANCE', 'Hold it for the customer', 'Owed back, or applied to their next invoice.'],
                        ['TIP', 'The customer is giving it to us', 'A tip or a round-up. Income, not money owed back.'],
                      ] as const
                    ).map(([value, label, hint]) => (
                      <label key={value} className="flex items-start gap-2">
                        <input
                          type="radio"
                          name="overpayment"
                          className="mt-0.5 size-4 shrink-0 accent-gold-600"
                          value={value}
                          checked={overpayment === value}
                          onChange={() => setOverpayment(value)}
                        />
                        <span>
                          <span className="font-medium">{label}</span>
                          <span className="block text-amber-800">{hint}</span>
                        </span>
                      </label>
                    ))}
                    {overpayment === 'TIP' ? (
                      <>
                        <Input
                          aria-label={`Why the customer is giving ${formatMoney(remainder, form.currency)}`}
                          value={tipReason}
                          onChange={(e) => setTipReason(e.target.value)}
                          placeholder={
                            remainder.greaterThan(TIP_LIMIT)
                              ? 'Why they are giving it (required)'
                              : 'Why they are giving it (optional)'
                          }
                        />
                        {remainder.greaterThan(TIP_LIMIT) && !tipReason.trim() ? (
                          <p role="alert">
                            More than {form.currency} {TIP_LIMIT} is more than a round-up — say why it is a gift, or hold
                            it as an advance.
                          </p>
                        ) : null}
                      </>
                    ) : null}
                  </fieldset>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <Field label="Memo" hint="What happened, in your words — it follows the payment onto every ledger. e.g. “Cash collected by Ahmed against INV 15”.">
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="e.g. Cash collected by Ahmed against INV 15"
              aria-label="Memo"
            />
          </Field>
        </CardContent>
      </Card>

      <Callout tone="info">
        {isAgentCollection
          ? 'Posting credits the customer’s ledger and records the amount as pending with the agent. FID cash and bank do not move until you record Received from agent.'
          : 'Posting credits the customer’s ledger in their own currency, increases the account the money landed in by the exact amount received, and records the rate used — all in one transaction.'}
      </Callout>

      <AddAgentDialog
        open={addAgentOpen}
        onOpenChange={setAddAgentOpen}
        onCreated={(created) => {
          setAgentOptions((current) =>
            current.some((option) => option.value === created.value)
              ? current
              : [...current, created].sort((a, b) => a.label.localeCompare(b.label)),
          );
          setForm((current) => ({ ...current, agentId: created.value }));
        }}
      />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
        {/* A posted receipt is corrected in one press: saving rewrites the
            posting under the same number, so "save as a draft" would be a
            lie and posting again would be a second entry. */}
        {initial?.status === 'POSTED' ? (
          <Button variant="accent" onClick={() => submit(true)} loading={busy}>
            Save the correction
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => submit(false)} loading={busy}>
              Save draft
            </Button>
            {canPost ? (
              <Button variant="accent" onClick={() => submit(true)} loading={busy}>
                Save and post
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
