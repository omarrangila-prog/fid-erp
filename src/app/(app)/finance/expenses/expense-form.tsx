'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Ship, Building2, Plus } from 'lucide-react';
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
import { AddExpenseCategoryDialog } from '@/app/(app)/finance/expenses/add-expense-category';
import { AddAgentDialog } from '@/app/(app)/finance/receipts/add-agent';
import { MasterSelect } from '@/components/shared/master-select';
import { cashBankCreateSpec } from '@/components/shared/master-specs';
import { useClientKey } from '@/lib/use-client-key';

export type CategoryOption = ComboOption & { capitaliseByDefault: boolean; kind: 'SHIPMENT' | 'GENERAL' };

export type ShipmentTrace = {
  containers: ComboOption[];
  batches: Array<ComboOption & { containerId: string | null }>;
};

export type ExpenseFormInitial = {
  /** Absent when the values come from a voucher being cloned: save creates. */
  id?: string;
  expenseDate: string;
  kind: 'SHIPMENT' | 'GENERAL';
  expenseCategoryId: string;
  shipmentId: string | null;
  containerId: string | null;
  batchId: string | null;
  agentId: string | null;
  vendorId: string | null;
  payableToAgentId: string | null;
  currency: string;
  amount: string;
  rateToUsd: string;
  rateLocalPerUsd: string;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'CHEQUE';
  cashBankAccountId: string | null;
  taxCodeId: string | null;
  reference: string;
  description: string;
  capitaliseToLandedCost: boolean;
  allocationMethod?: 'PER_ITEM' | 'BY_WEIGHT' | 'BY_VALUE';
};

/**
 * Expense entry.
 *
 * The one decision that matters here is whether the cost belongs in the landed
 * cost of the coffee or in the period's profit and loss. The category proposes
 * an answer; the user can override it, and the consequence is spelled out on
 * screen rather than buried in an accounting policy.
 */
export function ExpenseForm({
  categories: initialCategories,
  shipments,
  agents,
  accounts,
  localCurrency,
  defaultLocalRate,
  ratesByCurrency,
  defaultShipmentId,
  canPost = true,
  traceByShipment,
  taxEnabled = false,
  taxLabel = 'VAT',
  taxCodes = [],
  initial,
  canCreateCashBank = false,
}: {
  categories: CategoryOption[];
  shipments: ComboOption[];
  agents: ComboOption[];
  accounts: Array<ComboOption & { currency: string; accountType: 'CASH' | 'PETTY_CASH' | 'BANK' }>;
  localCurrency: string;
  defaultLocalRate: string;
  ratesByCurrency: Record<string, string>;
  defaultShipmentId?: string;
  canPost?: boolean;
  traceByShipment?: Record<string, ShipmentTrace>;
  taxEnabled?: boolean;
  taxLabel?: string;
  taxCodes?: Array<{ value: string; label: string; ratePct: string }>;
  initial?: ExpenseFormInitial;
  /** Opening a drawer creates a ledger account, so it is its own permission. */
  canCreateCashBank?: boolean;
}) {
  const router = useRouter();
  const clientKey = useClientKey();
  const { busy, start, opening } = useSaveAndOpen();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = React.useState<Record<string, string>>({});
  const [categories, setCategories] = React.useState(initialCategories);
  const [addCategoryOpen, setAddCategoryOpen] = React.useState(false);
  const [newCategoryName, setNewCategoryName] = React.useState('');
  const [agentOptions, setAgentOptions] = React.useState(agents);
  const [addAgentOpen, setAddAgentOpen] = React.useState(false);


  // The first question, and the one that decides the rest of the form: is this
  // money spent on one consignment, or on running the business?
  const [kind, setKind] = React.useState<'SHIPMENT' | 'GENERAL'>(initial?.kind ?? 'SHIPMENT');
  const [settlement, setSettlement] = React.useState<'PAID' | 'UNPAID'>(
    initial ? (initial.cashBankAccountId ? 'PAID' : 'UNPAID') : 'UNPAID',
  );

  const [form, setForm] = React.useState({
    expenseDate: initial?.expenseDate ?? todayInputValue(),
    expenseCategoryId: initial?.expenseCategoryId ?? (null as string | null),
    shipmentId: initial?.shipmentId ?? defaultShipmentId ?? (null as string | null),
    containerId: initial?.containerId ?? (null as string | null),
    batchId: initial?.batchId ?? (null as string | null),
    vendorId: initial?.vendorId ?? (null as string | null),
    payableToAgentId: initial?.payableToAgentId ?? (null as string | null),
    agentId: initial?.agentId ?? (null as string | null),
    currency: initial?.currency ?? localCurrency,
    amount: initial?.amount ?? '',
    rateToUsd: initial?.rateToUsd ?? (localCurrency === 'USD' ? '1' : defaultLocalRate),
    rateLocalPerUsd: initial?.rateLocalPerUsd ?? defaultLocalRate,
    paymentMethod: (initial?.paymentMethod ?? 'CASH') as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE',
    cashBankAccountId: initial?.cashBankAccountId ?? (null as string | null),
    reference: initial?.reference ?? '',
    description: initial?.description ?? '',
    taxCodeId: initial?.taxCodeId ?? (null as string | null),
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
  const [capitaliseOverride, setCapitaliseOverride] = React.useState<boolean | null>(
    initial ? initial.capitaliseToLandedCost : null,
  );
  const capitalise = kind === 'SHIPMENT' && (capitaliseOverride ?? category?.capitaliseByDefault ?? false);
  const [allocationMethod, setAllocationMethod] = React.useState<'PER_ITEM' | 'BY_WEIGHT' | 'BY_VALUE'>(
    initial?.allocationMethod ?? 'PER_ITEM',
  );

  function isCommissionCategory(option: CategoryOption | undefined) {
    const hay = `${option?.label ?? ''} ${option?.keywords ?? ''}`.toLowerCase();
    return /commission|broker/.test(hay);
  }

  /** Switching type invalidates the category and the shipment beneath it. */
  function chooseKind(next: 'SHIPMENT' | 'GENERAL') {
    setKind(next);
    setCapitaliseOverride(null);
    setSettlement(next === 'SHIPMENT' ? 'UNPAID' : 'PAID');
    setForm((current) => ({
      ...current,
      expenseCategoryId: null,
      shipmentId: next === 'GENERAL' ? null : (defaultShipmentId ?? null),
      containerId: null,
      batchId: null,
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

  /**
   * `thenWhat` decides where the user lands.
   *
   * "open" shows the voucher just saved. "new" clears the form and stays put,
   * for the common case of entering a stack of receipts in one sitting: the
   * date, the currency and the shipment are kept, because the next receipt in
   * the pile is nearly always from the same day and the same consignment, and
   * retyping them is where mistakes come from.
   */
  function submit(andPost: boolean, thenWhat: 'open' | 'new' = 'open') {
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

    const paidFrom = settlement === 'PAID' ? (cashBankAccountId ?? '') : '';
    const agentId = kind === 'SHIPMENT' && settlement === 'PAID' ? (form.agentId ?? '') : '';

    const payload = {
      // New expenses only: one Save is one expense, however often it arrives.
      clientKey: initial?.id ? undefined : clientKey(),
      expenseDate: form.expenseDate,
      expenseCategoryId: form.expenseCategoryId,
      shipmentId: kind === 'SHIPMENT' ? (form.shipmentId ?? '') : '',
      purchaseContractId: '',
      containerId: kind === 'SHIPMENT' ? (form.containerId ?? '') : '',
      batchId: kind === 'SHIPMENT' ? (form.batchId ?? '') : '',
      // An unpaid cost names nobody: it is accrued, and settled later from
      // the cost itself. A supplier or agent on the record is kept only when
      // the voucher was already booked that way.
      vendorId: settlement === 'UNPAID' ? (form.vendorId ?? '') : '',
      agentId,
      payableToAgentId: settlement === 'UNPAID' ? (form.payableToAgentId ?? '') : '',
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
      // Only meaningful for a cost spread over the whole order; a named
      // container or batch takes it all, however it is shared.
      allocationMethod: capitalise && !form.batchId ? allocationMethod : 'PER_ITEM',
      kind,
      taxCodeId: form.taxCodeId ?? '',
      reference: form.reference,
      description: form.description,
    };

    start(async () => {
      const result = await saveExpenseAction(initial?.id ?? null, JSON.stringify(payload));
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

      if (thenWhat === 'new') {
        setForm((current) => ({
          ...current,
          expenseCategoryId: null,
          containerId: null,
          batchId: null,
          amount: '',
          reference: '',
          description: '',
        }));
        setFieldIssues({});
        setError(null);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
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
          <CardDescription>
            Category, shipment and amount. If the category is not listed, add it here without leaving this screen.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kind === 'SHIPMENT' ? (
            <Field
              label="Contract / shipment"
              htmlFor="expenseShipment"
              required
              error={fieldIssues.shipmentId}
              hint="This amount is added to that shipment’s cost."
            >
              <Combobox
                id="expenseShipment"
                options={shipments}
                value={form.shipmentId}
                onChange={(value) =>
                  setForm({ ...form, shipmentId: value, containerId: null, batchId: null })
                }
                placeholder="Choose the shipment…"
              />
            </Field>
          ) : null}

          <Field
            label="Expense Category"
            htmlFor="expenseCategory"
            required
            error={fieldIssues.expenseCategoryId}
            className={kind === 'GENERAL' ? 'sm:col-span-2 lg:col-span-3' : undefined}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <Combobox
                  id="expenseCategory"
                  autoFocus
                  options={availableCategories}
                  value={form.expenseCategoryId}
                  onChange={(value) => {
                    const next = availableCategories.find((option) => option.value === value);
                    setForm({ ...form, expenseCategoryId: value });
                    setCapitaliseOverride(null);
                    if (isCommissionCategory(next)) setSettlement('UNPAID');
                  }}
                  placeholder="Choose a category…"
                  emptyText="No matching category — add a new one"
                  createLabel="+ Add New Category"
                  onCreate={(query) => {
                    setNewCategoryName(query ?? '');
                    setAddCategoryOpen(true);
                  }}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                  setNewCategoryName('');
                  setAddCategoryOpen(true);
                }}
              >
                <Plus />
                Add New Category
              </Button>
            </div>
          </Field>

          <Field label="Expense date" required error={fieldIssues.expenseDate}>
            <Input type="date" value={form.expenseDate} onChange={(e) => setForm({ ...form, expenseDate: e.target.value })} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>
            Unpaid records a payable and, for a shipment, adds the amount to that shipment’s cost now. Cash and bank
            are only asked for when you actually pay.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset>
            <legend className="sr-only">Paid or unpaid</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  {
                    value: 'UNPAID' as const,
                    title: 'Unpaid',
                    blurb: 'Book the cost now. Pay later from cash or bank when the money actually leaves.',
                  },
                  {
                    value: 'PAID' as const,
                    title: 'Paid',
                    blurb: 'Already paid from cash in hand or a bank. That account goes down today.',
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
                      onChange={() => setSettlement(option.value)}
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
            </div>
          ) : (
            <Callout tone="info" title="Pay later">
              Saving this records the cost now
              {kind === 'SHIPMENT' ? ' and adds it to the shipment' : ''}. Cash and bank are not touched until
              you record the payment from the cost itself.
            </Callout>
          )}

          {kind === 'SHIPMENT' && settlement === 'PAID' ? (
            <Field
              label="Agent"
              hint="Optional. Open the list and choose + Add New Agent if they are not already on file."
            >
              <Combobox
                options={agentOptions}
                value={form.agentId}
                onChange={(value) => setForm({ ...form, agentId: value })}
                placeholder="—"
                createLabel="+ Add New Agent"
                onCreate={() => setAddAgentOpen(true)}
              />
            </Field>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
        <CardTitle>Amount</CardTitle>
        <CardDescription>What it cost, in which currency.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kind === 'SHIPMENT' && form.shipmentId ? (
            <>
              <Field
                label="Container"
                hint="Leave blank to spread the cost across the whole job."
                error={fieldIssues.containerId}
              >
                <Combobox
                  options={[
                    { value: '__all__', label: 'Whole shipment' },
                    ...(traceByShipment?.[form.shipmentId]?.containers ?? []),
                  ]}
                  value={form.containerId ?? '__all__'}
                  onChange={(value) =>
                    setForm({ ...form, containerId: !value || value === '__all__' ? null : value, batchId: null })
                  }
                  placeholder="Whole shipment…"
                  emptyText="No containers on this shipment yet"
                />
              </Field>
              <Field
                label="Batch"
                hint="Leave blank to spread across every batch in the container (or the job)."
                error={fieldIssues.batchId}
              >
                <Combobox
                  options={[
                    { value: '__all__', label: 'Every batch' },
                    ...((traceByShipment?.[form.shipmentId]?.batches ?? []).filter(
                      (batch) => !form.containerId || batch.containerId === form.containerId,
                    )),
                  ]}
                  value={form.batchId ?? '__all__'}
                  onChange={(value) => {
                    const next = !value || value === '__all__' ? null : value;
                    const batchesForJob = form.shipmentId
                      ? (traceByShipment?.[form.shipmentId]?.batches ?? [])
                      : [];
                    const picked = batchesForJob.find((batch) => batch.value === next);
                    setForm({
                      ...form,
                      batchId: next,
                      containerId: picked?.containerId ?? form.containerId,
                    });
                  }}
                  placeholder="Every batch…"
                  emptyText="No batches on this shipment yet"
                />
              </Field>
            </>
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

          <Field label="Amount" required error={fieldIssues.amount} hint="The amount on the bill. This is what cash, the journal and shipment cost use.">
            <MoneyInput currency={form.currency} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>

          {taxEnabled ? (
            <Field
              label={taxLabel}
              htmlFor="expenseTax"
              hint="Leave as No tax unless this bill names tax separately. The amount above is never rewritten."
            >
              <Select
                id="expenseTax"
                value={form.taxCodeId ?? ''}
                onChange={(e) => setForm({ ...form, taxCodeId: e.target.value || null })}
              >
                <option value="">No tax</option>
                {taxCodes.map((code) => (
                  <option key={code.value} value={code.value}>
                    {code.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

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

            {capitalise && !form.batchId ? (
              <Field
                label="How to share this cost"
                hint="Between the coffees it is spread over. Equal per coffee is the usual rule."
              >
                <Select
                  aria-label="How to share this cost"
                  value={allocationMethod}
                  onChange={(e) => setAllocationMethod(e.target.value as typeof allocationMethod)}
                >
                  <option value="PER_ITEM">Equal share per coffee, then by weight</option>
                  <option value="BY_WEIGHT">By weight — kilograms in each container</option>
                  <option value="BY_VALUE">By value — what each container&rsquo;s coffee cost</option>
                </Select>
              </Field>
            ) : null}

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
          <Field label="Memo" hint="What the money was spent on — it shows on the expense list, the shipment costing and the cash book.">
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="e.g. Clearing charges for ICUL/FID/002, paid at the port"
              aria-label="Memo"
            />
          </Field>
          {amountUsd.greaterThan(0) ? (
            <p className="mt-3 text-right text-xs text-ink-muted">
              USD equivalent: <span className="tnum font-semibold text-ink">{formatMoney(amountUsd, 'USD')}</span>
            </p>
          ) : null}
          {taxEnabled && form.taxCodeId && form.amount ? (
            <p className="mt-1 text-right text-xs text-ink-muted">
              {taxLabel}{' '}
              {formatMoney(
                tryDec(form.amount)
                  .times(tryDec(taxCodes.find((code) => code.value === form.taxCodeId)?.ratePct ?? 0))
                  .dividedBy(100),
                form.currency,
              )}
              {' · cash/bank moves '}
              {formatMoney(
                tryDec(form.amount).plus(
                  tryDec(form.amount)
                    .times(tryDec(taxCodes.find((code) => code.value === form.taxCodeId)?.ratePct ?? 0))
                    .dividedBy(100),
                ),
                form.currency,
              )}
              . The original amount stays {formatMoney(tryDec(form.amount), form.currency)}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <AddExpenseCategoryDialog
        open={addCategoryOpen}
        onOpenChange={(open) => {
          setAddCategoryOpen(open);
          if (!open) setNewCategoryName('');
        }}
        kind={kind}
        initialName={newCategoryName}
        onCreated={(created) => {
          setCategories((current) =>
            current.some((option) => option.value === created.value)
              ? current
              : [...current, created].sort((a, b) => a.label.localeCompare(b.label)),
          );
          setForm((current) => ({ ...current, expenseCategoryId: created.value }));
          setCapitaliseOverride(null);
          if (isCommissionCategory(created)) setSettlement('UNPAID');
        }}
      />

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
          <>
            {/* Only when writing a new voucher: on an edit this would save the
                one on screen and then clear it, which reads as losing it. */}
            {initial?.id ? null : (
              <Button variant="outline" onClick={() => submit(true, 'new')} loading={busy}>
                Save &amp; New
              </Button>
            )}
            <Button variant="accent" onClick={() => submit(true)} loading={busy}>
              Save and post
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
