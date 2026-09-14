'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Ship, Building2 } from 'lucide-react';
import { focusFirstError } from '@/lib/focus-first-error';
import { FormError } from '@/components/shared/form-error';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Callout } from '@/components/ui/feedback';
import { dec, tryDec, convertToUsd } from '@/lib/money';
import { formatMoney, todayInputValue } from '@/lib/format';
import { saveExpenseAction, postExpenseAction } from '@/server/actions/finance-actions';
import { useSaveAndOpen } from '@/lib/use-save-and-open';
import { accountsFor } from '@/lib/cash-account-choice';

export type CategoryOption = ComboOption & { capitaliseByDefault: boolean; kind: 'SHIPMENT' | 'GENERAL' };

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
  ratesByCurrency,
  defaultShipmentId,
  canPost = true,
}: {
  categories: CategoryOption[];
  shipments: ComboOption[];
  vendors: ComboOption[];
  agents: ComboOption[];
  accounts: Array<ComboOption & { currency: string; accountType: 'CASH' | 'PETTY_CASH' | 'BANK' }>;
  localCurrency: string;
  defaultLocalRate: string;
  ratesByCurrency: Record<string, string>;
  defaultShipmentId?: string;
  canPost?: boolean;
}) {
  const router = useRouter();
  const { busy, start, opening } = useSaveAndOpen();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = React.useState<Record<string, string>>({});

  // The first question, and the one that decides the rest of the form: is this
  // money spent on one consignment, or on running the business?
  const [kind, setKind] = React.useState<'SHIPMENT' | 'GENERAL'>('SHIPMENT');
  const [settlement, setSettlement] = React.useState<'PAID' | 'UNPAID'>('PAID');
  const [unpaidTo, setUnpaidTo] = React.useState<'VENDOR' | 'AGENT'>('VENDOR');

  const [form, setForm] = React.useState({
    expenseDate: todayInputValue(),
    expenseCategoryId: null as string | null,
    shipmentId: defaultShipmentId ?? (null as string | null),
    vendorId: null as string | null,
    agentId: null as string | null,
    currency: localCurrency,
    amount: '',
    rateToUsd: localCurrency === 'USD' ? '1' : defaultLocalRate,
    rateLocalPerUsd: defaultLocalRate,
    paymentMethod: 'CASH',
    cashBankAccountId: null as string | null,
    reference: '',
    description: '',
  });

  // Cash goes into the drawer without asking; a bank transfer still needs to
  // say which bank.
  const accountChoice = React.useMemo(
    () => accountsFor(accounts, form.paymentMethod, form.currency),
    [accounts, form.paymentMethod, form.currency],
  );
  const cashBankAccountId = accountChoice.automatic ?? form.cashBankAccountId;

  // Only the categories that belong to the chosen type, so a staff dinner is
  // never one careless click away from a shipment's landed cost.
  const availableCategories = categories.filter((option) => option.kind === kind);
  const category = availableCategories.find((c) => c.value === form.expenseCategoryId);
  const [capitaliseOverride, setCapitaliseOverride] = React.useState<boolean | null>(null);
  const capitalise = kind === 'SHIPMENT' && (capitaliseOverride ?? category?.capitaliseByDefault ?? false);

  /** Switching type invalidates the category and the shipment beneath it. */
  function chooseKind(next: 'SHIPMENT' | 'GENERAL') {
    setKind(next);
    setCapitaliseOverride(null);
    setForm((current) => ({
      ...current,
      expenseCategoryId: null,
      shipmentId: next === 'GENERAL' ? null : (defaultShipmentId ?? null),
      agentId: next === 'GENERAL' ? null : current.agentId,
    }));
  }

  const isForeign = form.currency !== 'USD';

  const amountUsd = React.useMemo(() => {
    if (!form.amount) return dec(0);
    try {
      return isForeign ? convertToUsd(form.amount, form.rateToUsd || '1', form.currency) : tryDec(form.amount);
    } catch {
      return dec(0);
    }
  }, [form.amount, form.rateToUsd, form.currency, isForeign]);

  function submit(andPost: boolean) {
    setError(null);
    setFieldIssues({});

    if (kind === 'SHIPMENT' && !form.shipmentId) {
      setError('A shipment expense must name the contract / shipment it belongs to.');
      return;
    }

    if (settlement === 'PAID' && !cashBankAccountId) {
      setError('Choose the cash or bank this was paid from.');
      return;
    }

    if (settlement === 'UNPAID' && unpaidTo === 'VENDOR' && !form.vendorId) {
      setError('Choose the supplier this is owed to.');
      return;
    }

    if (settlement === 'UNPAID' && unpaidTo === 'AGENT' && !form.agentId) {
      setError('Choose the agent this is owed to.');
      return;
    }

    const paidFrom = settlement === 'PAID' ? (cashBankAccountId ?? '') : '';
    const vendorId = settlement === 'UNPAID' && unpaidTo === 'VENDOR' ? (form.vendorId ?? '') : '';
    const agentId = kind === 'SHIPMENT' ? (form.agentId ?? '') : '';
    const payableToAgentId = settlement === 'UNPAID' && unpaidTo === 'AGENT' ? (form.agentId ?? '') : '';

    const payload = {
      expenseDate: form.expenseDate,
      expenseCategoryId: form.expenseCategoryId,
      shipmentId: kind === 'SHIPMENT' ? (form.shipmentId ?? '') : '',
      purchaseContractId: '',
      vendorId,
      agentId,
      payableToAgentId,
      currency: form.currency,
      amount: form.amount,
      rateToUsd: isForeign ? form.rateToUsd : '1',
      // A voucher in the company's own currency carries one rate, and it is
      // the voucher's. Sending the other would be sending a number the user
      // was never shown.
      rateLocalPerUsd: form.currency === localCurrency ? form.rateToUsd || '1' : form.rateLocalPerUsd,
      paymentMethod: form.paymentMethod,
      cashBankAccountId: paidFrom,
      capitaliseToLandedCost: capitalise,
      kind,
      reference: form.reference,
      description: form.description,
    };

    start(async () => {
      const result = await saveExpenseAction(null, JSON.stringify(payload));
      if (!result?.ok) {
        setError(result?.error ?? 'The expense could not be saved.');
        setFieldIssues(result && !result.ok ? (result.errors ?? {}) : {});
        focusFirstError();
        return;
      }

      if (andPost) {
        const posted = await postExpenseAction(result.id);
        if (!posted.ok) {
          setError(posted.error);
          opening();
          router.push(`/finance/expenses/${result.id}`);
          return;
        }
        toast.success('Expense posted.');
      } else {
        toast.success('Expense saved as a draft.');
      }

      opening();

      router.push(`/finance/expenses/${result.id}`);
    });
  }

  return (
    <div className="space-y-5">
      <FormError message={error} fieldErrors={fieldIssues} />

      <Card>
        <CardHeader>
          <CardTitle>What is this expense for?</CardTitle>
          <CardDescription>
            This decides where the money lands. Everything below follows from it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <fieldset>
            <legend className="sr-only">Expense type</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  {
                    value: 'SHIPMENT' as const,
                    icon: Ship,
                    title: 'Shipment expense',
                    blurb:
                      'Clearing, documentation, duty, transport, commission — a cost of getting one consignment landed and sold.',
                  },
                  {
                    value: 'GENERAL' as const,
                    icon: Building2,
                    title: 'General company expense',
                    blurb:
                      'Meals, rent, utilities, travel, office costs — running the business, not one consignment.',
                  },
                ]
              ).map((option) => {
                const Icon = option.icon;
                const active = kind === option.value;
                return (
                  <label
                    key={option.value}
                    className={
                      active
                        ? 'flex cursor-pointer gap-3 rounded-xl border-2 border-forest-500 bg-forest-50/60 p-4'
                        : 'flex cursor-pointer gap-3 rounded-xl border-2 border-line bg-surface p-4 hover:border-forest-300'
                    }
                  >
                    <input
                      type="radio"
                      name="expenseKind"
                      className="sr-only"
                      checked={active}
                      onChange={() => chooseKind(option.value)}
                    />
                    <Icon className={active ? 'size-5 shrink-0 text-forest-700' : 'size-5 shrink-0 text-ink-subtle'} />
                    <span>
                      <span className="block text-sm font-semibold text-ink">{option.title}</span>
                      <span className="mt-0.5 block text-xs text-ink-muted">{option.blurb}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
        <CardTitle>Expense</CardTitle>
        <CardDescription>What it cost, in which currency, and which shipment it belongs to.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Category" required error={fieldIssues.expenseCategoryId}>
            <Combobox
              autoFocus
              options={availableCategories}
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

          {kind === 'SHIPMENT' ? (
            <Field
              label="Contract / shipment"
              required
              error={fieldIssues.shipmentId}
              hint="This amount is added to that shipment’s cost."
            >
              <Combobox
                options={shipments}
                value={form.shipmentId}
                onChange={(value) => setForm({ ...form, shipmentId: value })}
                placeholder="Choose the shipment…"
              />
            </Field>
          ) : null}

          <Field label="Currency">
            <Select
              value={form.currency}
              onChange={(e) => {
                const currency = e.target.value;
                setForm({
                  ...form,
                  currency,
                  rateToUsd: currency === 'USD' ? '1' : (ratesByCurrency[currency] ?? ''),
                  cashBankAccountId: null,
                });
              }}
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

          {/*
            One rate, not two.
            
            A MAD expense in a MAD company was asked for "Rate (MAD per 1 USD)"
            and then "Rate to MAD" — the same number, twice, both mandatory,
            and the second one ignored by the posting anyway because a voucher
            in the company's own currency uses its own rate. It is asked for
            only when the voucher is in neither USD nor the company's currency,
            which is the one case where the two genuinely differ.
          */}
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

          <Field label="Reference" hint="Invoice or receipt number.">
            <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How was this settled?</CardTitle>
          <CardDescription>
            Paid now takes the money out of cash or bank today. Unpaid sits as money owed to a supplier or agent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset>
            <legend className="sr-only">Paid or unpaid</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  {
                    value: 'PAID' as const,
                    title: 'Paid',
                    blurb: 'Cash in hand or the bank goes down. The cost is on the books today.',
                  },
                  {
                    value: 'UNPAID' as const,
                    title: 'Unpaid',
                    blurb: 'Owed to a supplier or an agent. Pay it later as a separate payment.',
                  },
                ]
              ).map((option) => {
                const active = settlement === option.value;
                return (
                  <label
                    key={option.value}
                    className={
                      active
                        ? 'flex cursor-pointer flex-col gap-1 rounded-xl border-2 border-forest-500 bg-forest-50/60 p-4'
                        : 'flex cursor-pointer flex-col gap-1 rounded-xl border-2 border-line bg-surface p-4 hover:border-forest-300'
                    }
                  >
                    <input
                      type="radio"
                      name="expenseSettlement"
                      className="sr-only"
                      checked={active}
                      onChange={() => {
                        setSettlement(option.value);
                        if (option.value === 'PAID') setUnpaidTo('VENDOR');
                      }}
                    />
                    <span className="text-sm font-semibold text-ink">{option.title}</span>
                    <span className="text-xs text-ink-muted">{option.blurb}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {settlement === 'PAID' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Paid from" required>
                <Select
                  value={form.paymentMethod === 'CASH' ? 'CASH' : 'BANK'}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      paymentMethod: e.target.value === 'CASH' ? 'CASH' : 'BANK_TRANSFER',
                      cashBankAccountId: null,
                    })
                  }
                >
                  <option value="CASH">Cash in hand</option>
                  <option value="BANK">Bank</option>
                </Select>
              </Field>
              <Field
                label={form.paymentMethod === 'CASH' ? 'Cash account' : 'Bank account'}
                required
                hint={
                  accountChoice.automatic
                    ? 'Cash in Hand is selected for this currency.'
                    : `Only ${form.currency} accounts are shown.`
                }
                error={fieldIssues.cashBankAccountId}
              >
                <Combobox
                  options={accountChoice.options}
                  value={cashBankAccountId}
                  onChange={(value) => setForm({ ...form, cashBankAccountId: value })}
                  placeholder="Choose an account…"
                  emptyText={`No ${form.currency} account exists`}
                />
              </Field>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {kind === 'SHIPMENT' ? (
                <Field label="Owed to" required>
                  <Select
                    value={unpaidTo}
                    onChange={(e) => setUnpaidTo(e.target.value === 'AGENT' ? 'AGENT' : 'VENDOR')}
                  >
                    <option value="VENDOR">Supplier</option>
                    <option value="AGENT">Agent</option>
                  </Select>
                </Field>
              ) : null}
              {unpaidTo === 'VENDOR' ? (
                <Field label="Supplier" required error={fieldIssues.vendorId}>
                  <Combobox
                    options={vendors}
                    value={form.vendorId}
                    onChange={(value) => setForm({ ...form, vendorId: value })}
                    placeholder="Choose the supplier…"
                  />
                </Field>
              ) : (
                <Field label="Agent" required error={fieldIssues.agentId}>
                  <Combobox
                    options={agents}
                    value={form.agentId}
                    onChange={(value) => setForm({ ...form, agentId: value })}
                    placeholder="Choose the agent…"
                  />
                </Field>
              )}
            </div>
          )}

          {kind === 'SHIPMENT' && settlement === 'PAID' ? (
            <Field label="Agent" hint="Optional — if this is their commission, already paid.">
              <Combobox
                options={agents}
                value={form.agentId}
                onChange={(value) => setForm({ ...form, agentId: value })}
                placeholder="—"
              />
            </Field>
          ) : null}
        </CardContent>
      </Card>

      {kind === 'SHIPMENT' && category ? (
        <Card>
          <CardHeader>
            <CardTitle>Add to this shipment’s cost?</CardTitle>
            <CardDescription>
              Clearing, freight and duty usually raise the coffee’s cost. Office costs should not.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                {
                  value: true,
                  title: 'Yes — add to this shipment’s cost',
                  body: 'The amount is included in this consignment’s costing and, where the category allows, in the coffee still in stock.',
                },
                {
                  value: false,
                  title: 'No — company P&L only',
                  body: 'Shown on this shipment’s cost sheet if you named one, but it does not raise the stock value of the coffee.',
                },
              ].map((option) => (
                <button
                  key={String(option.value)}
                  type="button"
                  onClick={() => setCapitaliseOverride(option.value)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    capitalise === option.value
                      ? 'border-gold-500 bg-gold-50'
                      : 'border-line hover:border-forest-300'
                  }`}
                >
                  <p className="text-sm font-semibold text-ink">{option.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">{option.body}</p>
                </button>
              ))}
            </div>

            {capitaliseOverride !== null && capitaliseOverride !== category.capitaliseByDefault ? (
              <Callout tone="warning">
                You have overridden the default for <strong>{category.label}</strong>, which is normally{' '}
                {category.capitaliseByDefault ? 'added to the shipment’s cost' : 'kept off the coffee’s stock value'}.
                The override is recorded on the voucher.
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
