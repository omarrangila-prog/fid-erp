'use client';

import * as React from 'react';
import { MasterSelect } from '@/components/shared/master-select';
import { vendorCreateSpec, cashBankCreateSpec } from '@/components/shared/master-specs';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { HandCoins } from 'lucide-react';
import { focusFirstError } from '@/lib/focus-first-error';
import { FormError } from '@/components/shared/form-error';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { type ComboOption } from '@/components/ui/combobox';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { dec, tryDec, sum, convertToUsd } from '@/lib/money';
import { formatMoney, formatDate, todayInputValue } from '@/lib/format';
import { savePaymentAction, postPaymentAction } from '@/server/actions/finance-actions';
import { useSaveAndOpen } from '@/lib/use-save-and-open';
import { accountsFor } from '@/lib/cash-account-choice';

export type OpenContract = {
  /** A contract is the coffee; an expense is a cost the supplier billed. */
  kind: 'CONTRACT' | 'EXPENSE';
  id: string;
  /** What to call this on screen: the client's own reference, or the cost. */
  label: string;
  contractDate: string;
  currency: string;
  outstanding: string;
  /** Null for a cost booked without a supplier — it is settled from the cost itself. */
  vendorId: string | null;
};

/**
 * Supplier payment. The mirror of a receipt: money out, allocated against
 * purchase contracts rather than sales invoices.
 */
export function PaymentForm({
  vendors,
  accounts,
  contracts,
  localCurrency,
  defaultLocalRate,
  preselectedExpenseId,
  canCreateCashBank = false,
  canPost = true,
}: {
  vendors: Array<ComboOption & { currency: string }>;
  accounts: Array<ComboOption & { currency: string; accountType: 'CASH' | 'PETTY_CASH' | 'BANK' }>;
  contracts: OpenContract[];
  localCurrency: string;
  defaultLocalRate: string;
  preselectedExpenseId?: string;
  canPost?: boolean;
  /** Opening a drawer creates a ledger account, so it is its own permission. */
  canCreateCashBank?: boolean;
}) {
  const router = useRouter();
  const { busy, start, opening } = useSaveAndOpen();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = React.useState<Record<string, string>>({});

  const preselected = contracts.find((c) => c.kind === 'EXPENSE' && c.id === preselectedExpenseId);
  // A cost booked to nobody is paid from the cost itself: no supplier is asked
  // for, and the payment goes against that cost and nothing else.
  const accruedCost = preselected && !preselected.vendorId ? preselected : null;

  const [form, setForm] = React.useState({
    paymentDate: todayInputValue(),
    vendorId: preselected?.vendorId ?? null,
    currency: preselected?.currency ?? 'USD',
    amount: preselected?.outstanding ?? '',
    rateToUsd: preselected && preselected.currency !== 'USD' ? defaultLocalRate : '1',
    rateLocalPerUsd: defaultLocalRate,
    paymentMethod: 'BANK_TRANSFER',
    cashBankAccountId: null as string | null,
    reference: '',
    description: '',
    chequeNumber: '',
    chequeDate: '',
    bankName: '',
  });

  const [allocations, setAllocations] = React.useState<Record<string, string>>(
    preselected ? { [preselected.id]: preselected.outstanding } : {},
  );

  const vendorContracts = React.useMemo(
    () => (accruedCost ? [accruedCost] : contracts.filter((c) => Boolean(c.vendorId) && c.vendorId === form.vendorId)),
    [contracts, form.vendorId, accruedCost],
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

  const amountUsd = React.useMemo(() => {
    if (!form.amount) return dec(0);
    try {
      return isForeign ? convertToUsd(form.amount, form.rateToUsd || '1', form.currency) : dec(form.amount);
    } catch {
      return dec(0);
    }
  }, [form.amount, form.rateToUsd, form.currency, isForeign]);

  const allocatedTotal = sum(Object.values(allocations).filter(Boolean).map((v) => tryDec(v)));

  function submit(andPost: boolean) {
    setError(null);
    setFieldIssues({});

    const payload = {
      paymentDate: form.paymentDate,
      vendorId: accruedCost ? '' : (form.vendorId ?? ''),
      currency: form.currency,
      amount: form.amount,
      rateToUsd: isForeign ? form.rateToUsd : '1',
      rateLocalPerUsd: form.currency === localCurrency ? form.rateToUsd || '1' : form.rateLocalPerUsd,
      paymentMethod: form.paymentMethod,
      cashBankAccountId: cashBankAccountId ?? '',
      cheque: isCheque
        ? {
            chequeNumber: form.chequeNumber,
            chequeDate: form.chequeDate || form.paymentDate,
            bankName: form.bankName,
            beneficiary: '',
            agentId: '',
            notes: '',
          }
        : null,
      shipmentId: '',
      reference: form.reference,
      description: form.description,
      allocations: Object.entries(allocations)
        .filter(([, amount]) => amount && Number(amount) > 0)
        .map(([id, amount]) => {
          const row = contracts.find((c) => c.id === id);
          return row?.kind === 'EXPENSE'
            ? { expenseId: id, amount }
            : { purchaseContractId: id, amount };
        }),
    };

    start(async () => {
      const result = await savePaymentAction(null, JSON.stringify(payload));
      if (!result?.ok) {
        setError(result?.error ?? 'The payment could not be saved.');
        setFieldIssues(result && !result.ok ? (result.errors ?? {}) : {});
        focusFirstError();
        return;
      }

      if (andPost) {
        const posted = await postPaymentAction(result.id);
        if (!posted.ok) {
          setError(posted.error);
          opening();
          router.push(`/finance/payments/${result.id}`);
          return;
        }
        toast.success('Payment posted.');
      } else {
        toast.success('Payment saved as a draft.');
      }

      opening();

      router.push(`/finance/payments/${result.id}`);
    });
  }

  if (vendors.length === 0) {
    return <EmptyState icon={HandCoins} title="No suppliers yet" description="Add a supplier before recording a payment." />;
  }

  return (
    <div className="space-y-5">
      <FormError message={error} fieldErrors={fieldIssues} />

      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
          <CardDescription>Who was paid, how much, and from which account.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {accruedCost ? (
            <Field label="Settles" hint="Booked without a supplier, so none is asked for here.">
              <Input value={accruedCost.label} readOnly />
            </Field>
          ) : (
            <Field label="Supplier" required error={fieldIssues.vendorId}>
              <MasterSelect
                autoFocus
                options={vendors}
                value={form.vendorId}
                onChange={(value) => {
                  setForm({ ...form, vendorId: value });
                  setAllocations({});
                }}
                placeholder="Choose a supplier…"
                invalid={Boolean(fieldIssues.vendorId)}
                create={vendorCreateSpec(form.currency)}
              />
            </Field>
          )}

          <Field label="Payment date" error={fieldIssues.paymentDate}>
            <Input type="date" value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} />
          </Field>

          <Field label="Payment method" required>
            <Select
              value={form.paymentMethod}
              onChange={(e) => setForm({ ...form, paymentMethod: e.target.value, cashBankAccountId: null })}
            >
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="CASH">Cash</option>
              <option value="CHEQUE">Cheque</option>
            </Select>
          </Field>

          <Field label="Currency paid">
            <Select
              value={form.currency}
              onChange={(e) =>
                setForm({ ...form, currency: e.target.value, rateToUsd: e.target.value === 'USD' ? '1' : '', cashBankAccountId: null })
              }
            >
              <option value="USD">USD — US Dollar</option>
              <option value="AED">AED — UAE Dirham</option>
              <option value="MAD">MAD — Moroccan Dirham</option>
            </Select>
          </Field>

          <Field label="Amount paid" required error={fieldIssues.amount}>
            <MoneyInput currency={form.currency} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>

          {!isCheque ? (
            <Field
              label="Paid from"
              required
              hint={accountChoice.automatic ? 'Cash comes out of Cash in Hand.' : `Only ${form.currency} accounts are shown.`}
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

          {isForeign ? (
            <>
              <Field label={`Rate (${form.currency} per 1 USD)`} required error={fieldIssues.rateToUsd}>
                <Input value={form.rateToUsd} onChange={(e) => setForm({ ...form, rateToUsd: e.target.value })} className="tnum text-right" />
              </Field>
              <Field label="USD equivalent">
                <div className="tnum flex h-10 items-center justify-end rounded-lg border border-line bg-forest-50 px-3 text-sm font-semibold">
                  {formatMoney(amountUsd, 'USD')}
                </div>
              </Field>
            </>
          ) : null}

          {/*
            Only when the voucher is in neither USD nor the company's own
            currency. A MAD payment from a MAD company was asked for the MAD
            rate twice — once as the voucher rate and again here — and the
            second was ignored by the posting, which uses the voucher's own.
          */}
          {form.currency !== localCurrency ? (
            <Field label={`Rate (${localCurrency} per 1 USD)`} required hint="For this company's own reporting.">
              <Input
                value={form.rateLocalPerUsd}
                onChange={(e) => setForm({ ...form, rateLocalPerUsd: e.target.value })}
                className="tnum text-right"
              />
            </Field>
          ) : null}

          <Field label="Reference">
            <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
        </CardContent>
      </Card>

      {isCheque ? (
        <Card>
          <CardHeader>
            <CardTitle>Cheque details</CardTitle>
            <CardDescription>The bank is only reduced when the cheque is presented and cleared.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <Field label="Cheque number" required>
              <Input value={form.chequeNumber} onChange={(e) => setForm({ ...form, chequeNumber: e.target.value })} />
            </Field>
            <Field label="Cheque date" required>
              <Input type="date" value={form.chequeDate} onChange={(e) => setForm({ ...form, chequeDate: e.target.value })} />
            </Field>
            <Field label="Drawn on bank" required>
              <Input value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} />
            </Field>
          </CardContent>
        </Card>
      ) : null}

      {form.vendorId || accruedCost ? (
        <Card>
          <CardHeader>
            <CardTitle>Apply to what is owed</CardTitle>
            <CardDescription>Leave blank to hold the payment on account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {vendorContracts.length === 0 ? (
              <p className="py-4 text-center text-xs text-ink-subtle">Nothing is outstanding with this supplier.</p>
            ) : (
              vendorContracts.map((contract) => (
                <div key={contract.id} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{contract.label}</p>
                    <p className="text-xs text-ink-subtle">
                      {contract.kind === 'EXPENSE' ? 'Cost · ' : ''}
                      {formatDate(contract.contractDate)} · {formatMoney(contract.outstanding, contract.currency)} outstanding
                    </p>
                  </div>
                  <div className="w-36 shrink-0">
                    <MoneyInput
                      aria-label={`Amount applied to ${contract.label}`}
                      currency={contract.currency}
                      value={allocations[contract.id] ?? ''}
                      onChange={(e) => setAllocations({ ...allocations, [contract.id]: e.target.value })}
                      placeholder="0.00"
                    />
                  </div>
                </div>
              ))
            )}

            {allocatedTotal.greaterThan(0) ? (
              <p className="text-right text-xs text-ink-muted">
                Applied: <span className="tnum font-semibold text-ink">{allocatedTotal.toString()}</span>
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
        Posting reduces the supplier&rsquo;s payable in their own currency and decreases the account the money left by
        exactly what was paid. Where the two currencies differ, the exchange difference is recognised at revaluation.
      </Callout>

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
