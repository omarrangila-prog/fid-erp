'use client';

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
import { AddAgentDialog } from '@/app/(app)/finance/receipts/add-agent';

/**
 * Customer receipt.
 *
 * The Dubai case this exists for: a customer owes USD but pays in AED at a rate
 * agreed for that specific payment. The user can type either the rate or the
 * USD value they agreed — whichever they actually negotiated — and the other is
 * derived and stored on the voucher for good.
 */

export type OpenInvoice = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  outstanding: string;
  customerId: string;
};

export type BankOption = ComboOption & { currency: string; accountType: 'CASH' | 'PETTY_CASH' | 'BANK' };

export function ReceiptForm({
  customers,
  accounts,
  invoices,
  localCurrency,
  defaultLocalRate,
  ratesByCurrency,
  preselectedInvoiceId,
  agents,
  canCreateCashBank = false,
  canPost = true,
}: {
  customers: Array<ComboOption & { currency: string }>;
  accounts: BankOption[];
  invoices: OpenInvoice[];
  localCurrency: string;
  defaultLocalRate: string;
  ratesByCurrency?: Record<string, string>;
  preselectedInvoiceId?: string;
  /** Collection agents from the master list. Names are never hardcoded. */
  agents: Array<{ id: string; name: string }>;
  canPost?: boolean;
  /** Opening a drawer creates a ledger account, so it is its own permission. */
  canCreateCashBank?: boolean;
}) {
  const router = useRouter();
  const { busy, start, opening } = useSaveAndOpen();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = React.useState<Record<string, string>>({});
  const [addAgentOpen, setAddAgentOpen] = React.useState(false);
  const [agentOptions, setAgentOptions] = React.useState<ComboOption[]>(() =>
    agents.map((agent) => ({ value: agent.id, label: agent.name })),
  );

  const preselected = invoices.find((i) => i.id === preselectedInvoiceId);
  const initialCurrency = preselected?.currency ?? 'USD';
  const rateFor = React.useCallback(
    (currency: string) =>
      currency === 'USD' ? '1' : (ratesByCurrency?.[currency] ?? defaultLocalRate),
    [ratesByCurrency, defaultLocalRate],
  );

  const [form, setForm] = React.useState({
    receiptDate: todayInputValue(),
    customerId: preselected?.customerId ?? null,
    currency: initialCurrency,
    amount: preselected?.outstanding ?? '',
    rateToUsd: rateFor(initialCurrency),
    usdEquivalent: '',
    rateLocalPerUsd: defaultLocalRate,
    paymentMethod: 'BANK_TRANSFER',
    cashBankAccountId: null as string | null,
    reference: '',
    description: '',
    chequeNumber: '',
    chequeDate: '',
    bankName: '',
    beneficiary: '',
    agentId: null as string | null,
  });

  const [allocations, setAllocations] = React.useState<Record<string, string>>(
    preselected ? { [preselected.id]: preselected.outstanding } : {},
  );
  const [entryMode, setEntryMode] = React.useState<'rate' | 'usd'>('rate');

  const customerInvoices = React.useMemo(
    () => invoices.filter((i) => i.customerId === form.customerId),
    [invoices, form.customerId],
  );

  const isForeign = form.currency !== 'USD';
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

  const allocatedTotal = sum(Object.values(allocations).filter(Boolean).map((v) => tryDec(v)));

  function submit(andPost: boolean) {
    setError(null);
    setFieldIssues({});

    if (isAgentCollection && !form.agentId) {
      setFieldIssues({ agentId: 'Choose the agent who collected this money.' });
      focusFirstError();
      return;
    }

    const agentCollectionReference = [form.chequeNumber.trim() ? `Cheque ${form.chequeNumber.trim()}` : '', form.reference.trim()]
      .filter(Boolean)
      .join(' · ');

    const payload = {
      receiptDate: form.receiptDate,
      customerId: form.customerId,
      currency: form.currency,
      amount: form.amount,
      rateToUsd: !isForeign ? '1' : entryMode === 'rate' ? form.rateToUsd : '',
      usdEquivalent: isForeign && entryMode === 'usd' && form.usdEquivalent ? form.usdEquivalent : undefined,
      rateLocalPerUsd: form.currency === localCurrency ? form.rateToUsd || '1' : form.rateLocalPerUsd,
      paymentMethod: form.paymentMethod,
      cashBankAccountId: cashBankAccountId ?? '',
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
        : null,
      shipmentId: '',
      reference: isAgentCollection ? agentCollectionReference : form.reference,
      description: form.description,
      allocations: Object.entries(allocations)
        .filter(([, amount]) => amount && Number(amount) > 0)
        .map(([salesInvoiceId, amount]) => ({ salesInvoiceId, amount })),
    };

    start(async () => {
      const result = await saveReceiptAction(null, JSON.stringify(payload));
      if (!result?.ok) {
        setError(result?.error ?? 'The receipt could not be saved.');
        setFieldIssues(result && !result.ok ? (result.errors ?? {}) : {});
        focusFirstError();
        return;
      }

      if (andPost) {
        const posted = await postReceiptAction(result.id);
        if (!posted.ok) {
          setError(posted.error);
          opening();
          router.push(`/finance/receipts/${result.id}`);
          return;
        }
        toast.success('Receipt posted.');
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
              create={customerCreateSpec(form.currency)}
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
                })
              }
            >
              <option value="USD">USD — US Dollar</option>
              <option value="AED">AED — UAE Dirham</option>
              <option value="MAD">MAD — Moroccan Dirham</option>
            </Select>
          </Field>

          <Field label="Amount received" required error={fieldIssues.amount}>
            <MoneyInput
              currency={form.currency}
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </Field>

          {!isCheque && !isAgentCollection ? (
            <Field
              label="Received into"
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
                    ? cashBankCreateSpec(form.currency, form.paymentMethod === 'CASH' ? 'CASH' : 'BANK')
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
                hint="Where applicable. This is a note on the collection, not a cheque FID is holding."
              >
                <Input
                  value={form.chequeNumber}
                  onChange={(e) => setForm({ ...form, chequeNumber: e.target.value })}
                  placeholder="Optional"
                />
              </Field>
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

      {isForeign ? (
        <Card>
          <CardHeader>
            <CardTitle>Conversion</CardTitle>
            <CardDescription>
              Enter whichever you actually agreed. The rate is stored on this receipt permanently and is never
              restated by a later change to the rate table.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="inline-flex rounded-lg border border-line-strong p-0.5">
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
              {entryMode === 'rate' ? (
                <Field
                  label={`Rate (${form.currency} per 1 USD)`}
                  required
                  error={fieldIssues.rateToUsd}
                  hint="e.g. 3.6725"
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
              customerInvoices.map((invoice) => (
                <div key={invoice.id} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{invoice.invoiceNumber}</p>
                    <p className="text-xs text-ink-subtle">
                      {formatDate(invoice.invoiceDate)} · {formatMoney(invoice.outstanding, invoice.currency)} outstanding
                    </p>
                  </div>
                  <div className="w-36 shrink-0">
                    <MoneyInput
                      aria-label={`Amount applied to ${invoice.invoiceNumber}`}
                      currency={invoice.currency}
                      value={allocations[invoice.id] ?? ''}
                      onChange={(e) => setAllocations({ ...allocations, [invoice.id]: e.target.value })}
                      placeholder="0.00"
                    />
                  </div>
                </div>
              ))
            )}

            {allocatedTotal.greaterThan(0) ? (
              <p className="text-right text-xs text-ink-muted">
                Applied: <span className="tnum font-semibold text-ink">{allocatedTotal.toString()}</span> ·
                Receipt worth <span className="tnum font-semibold text-ink">{formatMoney(amountUsd, 'USD')}</span>
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <Field label="Description">
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
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
        <Button variant="outline" onClick={() => submit(false)} loading={busy}>
          Save draft
        </Button>
        {canPost ? (
          <Button variant="accent" onClick={() => submit(true)} loading={busy}>
            Save and post
          </Button>
        ) : null}
      </div>
    </div>
  );
}
