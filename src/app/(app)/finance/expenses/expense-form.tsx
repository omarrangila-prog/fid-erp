'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Callout } from '@/components/ui/feedback';
import { dec, convertToUsd } from '@/lib/money';
import { formatMoney } from '@/lib/format';
import { saveExpenseAction, postExpenseAction } from '@/server/actions/finance-actions';

export type CategoryOption = ComboOption & { capitaliseByDefault: boolean };

/**
 * Expense entry.
 *
 * The one decision that matters here is whether the cost belongs in the landed
 * cost of the coffee or in the period's profit and loss. The category proposes
 * an answer; the user can override it, and the consequence is spelled out on
 * screen rather than buried in an accounting policy.
 */
export function ExpenseForm({
  categories,
  shipments,
  vendors,
  agents,
  accounts,
  localCurrency,
  defaultLocalRate,
  defaultShipmentId,
}: {
  categories: CategoryOption[];
  shipments: ComboOption[];
  vendors: ComboOption[];
  agents: ComboOption[];
  accounts: Array<ComboOption & { currency: string }>;
  localCurrency: string;
  defaultLocalRate: string;
  defaultShipmentId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = React.useState<Record<string, string>>({});

  const [form, setForm] = React.useState({
    expenseDate: new Date().toISOString().slice(0, 10),
    expenseCategoryId: null as string | null,
    shipmentId: defaultShipmentId ?? (null as string | null),
    vendorId: null as string | null,
    agentId: null as string | null,
    currency: localCurrency,
    amount: '',
    rateToUsd: localCurrency === 'USD' ? '1' : defaultLocalRate,
    rateLocalPerUsd: defaultLocalRate,
    paymentMethod: 'BANK_TRANSFER',
    cashBankAccountId: null as string | null,
    reference: '',
    description: '',
  });

  const category = categories.find((c) => c.value === form.expenseCategoryId);
  const [capitaliseOverride, setCapitaliseOverride] = React.useState<boolean | null>(null);
  const capitalise = capitaliseOverride ?? category?.capitaliseByDefault ?? false;

  const isForeign = form.currency !== 'USD';

  const amountUsd = React.useMemo(() => {
    if (!form.amount) return dec(0);
    try {
      return isForeign ? convertToUsd(form.amount, form.rateToUsd || '1', form.currency) : dec(form.amount);
    } catch {
      return dec(0);
    }
  }, [form.amount, form.rateToUsd, form.currency, isForeign]);

  function submit(andPost: boolean) {
    setError(null);
    setFieldIssues({});

    if (capitalise && !form.shipmentId) {
      setError('A direct shipment cost must be linked to a job so its landed cost can be allocated.');
      return;
    }

    const payload = {
      expenseDate: form.expenseDate,
      expenseCategoryId: form.expenseCategoryId,
      shipmentId: form.shipmentId ?? '',
      purchaseContractId: '',
      vendorId: form.vendorId ?? '',
      agentId: form.agentId ?? '',
      currency: form.currency,
      amount: form.amount,
      rateToUsd: isForeign ? form.rateToUsd : '1',
      rateLocalPerUsd: form.rateLocalPerUsd,
      paymentMethod: form.paymentMethod,
      cashBankAccountId: form.cashBankAccountId ?? '',
      capitaliseToLandedCost: capitalise,
      reference: form.reference,
      description: form.description,
    };

    startTransition(async () => {
      const result = await saveExpenseAction(null, JSON.stringify(payload));
      if (!result?.ok) {
        setError(result?.error ?? 'The expense could not be saved.');
        setFieldIssues(result && !result.ok ? (result.errors ?? {}) : {});
        return;
      }

      if (andPost) {
        const posted = await postExpenseAction(result.id);
        if (!posted.ok) {
          setError(posted.error);
          router.push(`/finance/expenses/${result.id}`);
          return;
        }
        toast.success('Expense posted.');
      } else {
        toast.success('Expense saved as a draft.');
      }

      router.push(`/finance/expenses/${result.id}`);
      router.refresh();
    });
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
          <CardTitle>Expense</CardTitle>
          <CardDescription>What the cost was for, and how it was paid.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Category" required error={fieldIssues.expenseCategoryId}>
            <Combobox
              options={categories}
              value={form.expenseCategoryId}
              onChange={(value) => {
                setForm({ ...form, expenseCategoryId: value });
                setCapitaliseOverride(null);
              }}
              placeholder="Choose a category…"
            />
          </Field>

          <Field label="Expense date" required error={fieldIssues.expenseDate}>
            <Input type="date" value={form.expenseDate} onChange={(e) => setForm({ ...form, expenseDate: e.target.value })} />
          </Field>

          <Field
            label="Job / shipment"
            required={capitalise}
            hint={capitalise ? 'Required: the cost is spread across this job’s batches.' : 'Optional.'}
          >
            <Combobox
              options={shipments}
              value={form.shipmentId}
              onChange={(value) => setForm({ ...form, shipmentId: value })}
              placeholder="Not linked to a job"
            />
          </Field>

          <Field label="Currency" required>
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

          <Field label="Amount" required error={fieldIssues.amount}>
            <MoneyInput currency={form.currency} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>

          {isForeign ? (
            <Field label={`Rate (${form.currency} per 1 USD)`} required error={fieldIssues.rateToUsd}>
              <Input value={form.rateToUsd} onChange={(e) => setForm({ ...form, rateToUsd: e.target.value })} className="tnum text-right" />
            </Field>
          ) : null}

          <Field label="Paid from" required hint={`Only ${form.currency} accounts are shown.`} error={fieldIssues.cashBankAccountId}>
            <Combobox
              options={accounts.filter((a) => a.currency === form.currency)}
              value={form.cashBankAccountId}
              onChange={(value) => setForm({ ...form, cashBankAccountId: value })}
              placeholder="Choose an account…"
              emptyText={`No ${form.currency} account exists`}
            />
          </Field>

          <Field label="Payment method">
            <Select value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="CASH">Cash / petty cash</option>
              <option value="CHEQUE">Cheque</option>
            </Select>
          </Field>

          <Field label="Supplier / payee" hint="Optional.">
            <Combobox
              options={vendors}
              value={form.vendorId}
              onChange={(value) => setForm({ ...form, vendorId: value })}
              placeholder="—"
            />
          </Field>

          <Field label="Agent" hint="Optional.">
            <Combobox options={agents} value={form.agentId} onChange={(value) => setForm({ ...form, agentId: value })} placeholder="—" />
          </Field>

          <Field label={`Rate to ${localCurrency}`} required>
            <Input
              value={form.rateLocalPerUsd}
              onChange={(e) => setForm({ ...form, rateLocalPerUsd: e.target.value })}
              className="tnum text-right"
            />
          </Field>

          <Field label="Reference" hint="Invoice or receipt number.">
            <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
        </CardContent>
      </Card>

      {category ? (
        <Card>
          <CardHeader>
            <CardTitle>How this cost is treated</CardTitle>
            <CardDescription>This decides whether the cost lands in stock value or in the profit and loss.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                {
                  value: true,
                  title: 'Landed cost',
                  body: 'Spread across the job’s batches, raising the cost of coffee still in stock. The share already sold goes straight to cost of goods sold.',
                },
                {
                  value: false,
                  title: 'Period cost',
                  body: 'Charged to the profit and loss when incurred. Reduces net profit but not stock value or gross margin.',
                },
              ].map((option) => (
                <button
                  key={String(option.value)}
                  type="button"
                  onClick={() => setCapitaliseOverride(option.value)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    capitalise === option.value
                      ? 'border-teal-500 bg-teal-50'
                      : 'border-line hover:border-navy-300'
                  }`}
                >
                  <p className="text-sm font-semibold text-ink">{option.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">{option.body}</p>
                </button>
              ))}
            </div>

            {capitaliseOverride !== null && capitaliseOverride !== category.capitaliseByDefault ? (
              <Callout tone="warning">
                You have overridden the default for <strong>{category.label}</strong>, which is normally treated as a{' '}
                {category.capitaliseByDefault ? 'landed cost' : 'period cost'}. The override is recorded on the voucher.
              </Callout>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <Field label="Description">
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          {amountUsd.greaterThan(0) ? (
            <p className="mt-3 text-right text-xs text-ink-muted">
              USD equivalent: <span className="tnum font-semibold text-ink">{formatMoney(amountUsd, 'USD')}</span>
            </p>
          ) : null}
        </CardContent>
      </Card>

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
