'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, HandCoins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { dec, sum, convertToUsd } from '@/lib/money';
import { formatMoney, formatDate } from '@/lib/format';
import { savePaymentAction, postPaymentAction } from '@/server/actions/finance-actions';

export type OpenContract = {
  id: string;
  contractNumber: string;
  contractDate: string;
  currency: string;
  outstanding: string;
  vendorId: string;
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
}: {
  vendors: Array<ComboOption & { currency: string }>;
  accounts: Array<ComboOption & { currency: string }>;
  contracts: OpenContract[];
  localCurrency: string;
  defaultLocalRate: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = React.useState<Record<string, string>>({});

  const [form, setForm] = React.useState({
    paymentDate: new Date().toISOString().slice(0, 10),
    vendorId: null as string | null,
    currency: 'USD',
    amount: '',
    rateToUsd: '1',
    rateLocalPerUsd: defaultLocalRate,
    paymentMethod: 'BANK_TRANSFER',
    cashBankAccountId: null as string | null,
    reference: '',
    description: '',
    chequeNumber: '',
    chequeDate: '',
    bankName: '',
  });

  const [allocations, setAllocations] = React.useState<Record<string, string>>({});

  const vendorContracts = React.useMemo(
    () => contracts.filter((c) => c.vendorId === form.vendorId),
    [contracts, form.vendorId],
  );

  const isForeign = form.currency !== 'USD';
  const isCheque = form.paymentMethod === 'CHEQUE';

  const amountUsd = React.useMemo(() => {
    if (!form.amount) return dec(0);
    try {
      return isForeign ? convertToUsd(form.amount, form.rateToUsd || '1', form.currency) : dec(form.amount);
    } catch {
      return dec(0);
    }
  }, [form.amount, form.rateToUsd, form.currency, isForeign]);

  const allocatedTotal = sum(Object.values(allocations).filter(Boolean).map((v) => dec(v)));

  function submit(andPost: boolean) {
    setError(null);
    setFieldIssues({});

    const payload = {
      paymentDate: form.paymentDate,
      vendorId: form.vendorId,
      currency: form.currency,
      amount: form.amount,
      rateToUsd: isForeign ? form.rateToUsd : '1',
      rateLocalPerUsd: form.rateLocalPerUsd,
      paymentMethod: form.paymentMethod,
      cashBankAccountId: form.cashBankAccountId ?? '',
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
        .map(([purchaseContractId, amount]) => ({ purchaseContractId, amount })),
    };

    startTransition(async () => {
      const result = await savePaymentAction(null, JSON.stringify(payload));
      if (!result?.ok) {
        setError(result?.error ?? 'The payment could not be saved.');
        setFieldIssues(result && !result.ok ? (result.errors ?? {}) : {});
        return;
      }

      if (andPost) {
        const posted = await postPaymentAction(result.id);
        if (!posted.ok) {
          setError(posted.error);
          router.push(`/finance/payments/${result.id}`);
          return;
        }
        toast.success('Payment posted.');
      } else {
        toast.success('Payment saved as a draft.');
      }

      router.push(`/finance/payments/${result.id}`);
      router.refresh();
    });
  }

  if (vendors.length === 0) {
    return <EmptyState icon={HandCoins} title="No suppliers yet" description="Add a supplier before recording a payment." />;
  }

  return (
    <div className="space-y-5">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
          <CardDescription>Who was paid, how much, and from which account.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Supplier" required error={fieldIssues.vendorId}>
            <Combobox
              options={vendors}
              value={form.vendorId}
              onChange={(value) => {
                setForm({ ...form, vendorId: value });
                setAllocations({});
              }}
              placeholder="Choose a supplier…"
            />
          </Field>

          <Field label="Payment date" required error={fieldIssues.paymentDate}>
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

          <Field label="Currency paid" required>
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
            <Field label="Paid from" required hint={`Only ${form.currency} accounts are shown.`} error={fieldIssues.cashBankAccountId}>
              <Combobox
                options={accounts.filter((a) => a.currency === form.currency)}
                value={form.cashBankAccountId}
                onChange={(value) => setForm({ ...form, cashBankAccountId: value })}
                placeholder="Choose an account…"
                emptyText={`No ${form.currency} account exists`}
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

          <Field label={`Rate to ${localCurrency}`} required>
            <Input
              value={form.rateLocalPerUsd}
              onChange={(e) => setForm({ ...form, rateLocalPerUsd: e.target.value })}
              className="tnum text-right"
            />
          </Field>

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

      {form.vendorId ? (
        <Card>
          <CardHeader>
            <CardTitle>Apply to contracts</CardTitle>
            <CardDescription>Leave blank to hold the payment on account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {vendorContracts.length === 0 ? (
              <p className="py-4 text-center text-xs text-ink-subtle">This supplier has no outstanding contracts.</p>
            ) : (
              vendorContracts.map((contract) => (
                <div key={contract.id} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{contract.contractNumber}</p>
                    <p className="text-xs text-ink-subtle">
                      {formatDate(contract.contractDate)} · {formatMoney(contract.outstanding, contract.currency)} outstanding
                    </p>
                  </div>
                  <div className="w-36 shrink-0">
                    <MoneyInput
                      aria-label={`Amount applied to ${contract.contractNumber}`}
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
        <Button variant="outline" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button variant="outline" onClick={() => submit(false)} loading={pending}>
          Save draft
        </Button>
        <Button variant="accent" onClick={() => submit(true)} loading={pending}>
          Save and post
        </Button>
      </div>
    </div>
  );
}
