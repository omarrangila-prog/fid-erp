'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Trash2, PackageX } from 'lucide-react';
import { focusFirstError } from '@/lib/focus-first-error';
import { FormError } from '@/components/shared/form-error';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Select, Textarea } from '@/components/ui/input';
import { Field, FormSection } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { computeSalesLine } from '@/lib/calc/sales';
import { dec, toMoney, sum } from '@/lib/money';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import { saveSalesInvoiceAction } from '@/server/actions/trading-actions';
import { useSaveAndOpen } from '@/lib/use-save-and-open';
import { AddCustomer } from '@/app/(app)/sales/add-customer';
import { cn } from '@/lib/utils';

/**
 * Sales invoice entry.
 *
 * A line names a batch *and* the warehouse it leaves, because stock is held per
 * location. The picker therefore offers batch-in-warehouse combinations with
 * their free quantity, and refuses to let a line exceed it — the server checks
 * the same thing again under a row lock when the invoice is posted.
 */

export type StockOption = ComboOption & {
  batchId: string;
  warehouseId: string;
  batchNumber: string;
  availableKg: string;
  bagWeightKg: string;
  itemName: string;
  itemId: string;
  warehouseName: string;
  shipmentId: string;
};

type LineState = {
  key: string;
  /** Chosen first; narrows the coffee and the batch beneath it. */
  warehouseId: string;
  itemId: string;
  stockKey: string | null;
  quantity: string;
  unit: 'KG' | 'MT' | 'BAG';
  unitPrice: string;
  taxCodeId: string;
};

export type SaleFormDefaults = {
  id?: string;
  invoiceDate?: string;
  customerId?: string;
  currency?: string;
  rateToUsd?: string;
  rateLocalPerUsd?: string;
  dueDate?: string;
  paymentType?: 'CASH' | 'CREDIT';
  cashBankAccountId?: string;
  reference?: string;
  notes?: string;
  /**
   * A saved line knows its batch. The warehouse and coffee above it in the
   * cascade are read back from the stock list on mount, so a caller does not
   * have to supply what it can already work out.
   */
  lines?: Array<Omit<LineState, 'key' | 'warehouseId' | 'itemId'>>;
};

const newLine = (taxCodeId = ''): LineState => ({
  key: Math.random().toString(36).slice(2),
  warehouseId: '',
  itemId: '',
  stockKey: null,
  quantity: '',
  unit: 'KG',
  unitPrice: '',
  taxCodeId,
});

export function SaleForm({
  customers: initialCustomers,
  cashAccounts,
  stock,
  localCurrency,
  defaultCurrency,
  defaultLocalRate,
  ratesByCurrency,
  taxCodes = [],
  taxLabel = 'VAT',
  taxEnabled = false,
  defaults,
}: {
  customers: Array<ComboOption & { currency: string; paymentTermDays: number }>;
  /** For a cash sale: where the money went. */
  cashAccounts: Array<{ id: string; name: string; code: string; currency: string }>;
  stock: StockOption[];
  localCurrency: string;
  defaultCurrency: string;
  defaultLocalRate: string;
  /** The rate on file for each currency, so choosing one proposes its rate. */
  ratesByCurrency?: Record<string, string>;
  taxCodes?: Array<{ id: string; code: string; name: string; ratePct: string }>;
  taxLabel?: string;
  taxEnabled?: boolean;
  defaults?: SaleFormDefaults;
}) {
  const defaultTaxCodeId = taxCodes[0]?.id ?? '';
  const router = useRouter();
  // Held locally so a customer added from this screen can be selected without
  // a round trip that would throw away the half-filled invoice.
  const [customers, setCustomers] = React.useState(initialCustomers);

  /*
   * Two ways to choose stock, because the two companies work differently.
   *
   * Morocco sells out of a named store, so §11 asks for the warehouse first
   * and then only what is in it. Dubai sells whole containers, where the row
   * is the container and three dropdowns is two more than the job needs — and
   * anybody who already knows the batch number wants to type it, not walk a
   * cascade.
   *
   * So both, chosen per invoice. It starts on the cascade, which is the safer
   * default: it cannot offer stock from the wrong warehouse.
   */
  const [pickMode, setPickMode] = React.useState<'warehouse' | 'search'>('warehouse');
  const { busy, start, opening } = useSaveAndOpen();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = React.useState<Record<string, string>>({});

  const [header, setHeader] = React.useState({
    invoiceDate: defaults?.invoiceDate ?? new Date().toISOString().slice(0, 10),
    customerId: defaults?.customerId ?? null,
    currency: defaults?.currency ?? defaultCurrency,
    rateToUsd: defaults?.rateToUsd ?? (defaultCurrency === 'USD' ? '1' : defaultLocalRate),
    rateLocalPerUsd: defaults?.rateLocalPerUsd ?? defaultLocalRate,
    dueDate: defaults?.dueDate ?? '',
    paymentType: defaults?.paymentType ?? 'CREDIT',
    cashBankAccountId: defaults?.cashBankAccountId ?? '',
    reference: defaults?.reference ?? '',
    notes: defaults?.notes ?? '',
  });

  // Built in a lazy initialiser so the random keys are generated once, on mount,
  // rather than on every render.
  const [lines, setLines] = React.useState<LineState[]>(() =>
    defaults?.lines?.length
      ? defaults.lines.map((l, i) => {
          // A saved line knows its batch; the warehouse and coffee above it are
          // read back from the stock list so the cascade shows what was chosen.
          const option = stock.find((o) => o.value === l.stockKey);
          return {
            ...l,
            key: `line-${i}`,
            warehouseId: option?.warehouseId ?? '',
            itemId: option?.itemId ?? '',
          };
        })
      : [newLine(defaultTaxCodeId)],
  );

  /*
   * The three lists, each narrowed by the one above it.
   *
   * Derived from the stock list rather than held separately: there is exactly
   * one source of truth for what is where, and a warehouse with nothing in it
   * should not be offered at all.
   */
  const warehousesWithStock = React.useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>();
    for (const option of stock) {
      if (!seen.has(option.warehouseId)) {
        seen.set(option.warehouseId, { id: option.warehouseId, name: option.warehouseName });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [stock]);

  const itemsIn = React.useCallback(
    (warehouseId: string) => {
      const seen = new Map<string, { id: string; name: string }>();
      for (const option of stock) {
        if (option.warehouseId !== warehouseId) continue;
        if (!seen.has(option.itemId)) seen.set(option.itemId, { id: option.itemId, name: option.itemName });
      }
      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    [stock],
  );

  const batchesIn = React.useCallback(
    (warehouseId: string, itemId: string) =>
      stock
        .filter((option) => option.warehouseId === warehouseId && option.itemId === itemId)
        .sort((a, b) => a.batchNumber.localeCompare(b.batchNumber)),
    [stock],
  );

  function setLine(key: string, patch: Partial<LineState>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  const stockByKey = React.useMemo(() => new Map(stock.map((s) => [s.value, s])), [stock]);

  /** Quantity already claimed by other lines drawing on the same stock. */
  function claimedElsewhere(stockKey: string, exceptKey: string) {
    return sum(
      lines
        .filter((l) => l.stockKey === stockKey && l.key !== exceptKey && l.quantity)
        .map((l) => {
          const option = stockByKey.get(stockKey);
          try {
            return computeSalesLine({
              quantity: l.quantity,
              unit: l.unit,
              unitPrice: '0',
              currency: 'USD',
              rateToUsd: '1',
              bagWeightKg: option?.bagWeightKg,
            }).quantityKg;
          } catch {
            return dec(0);
          }
        }),
    );
  }

  const computed = lines.map((line) => {
    const option = line.stockKey ? stockByKey.get(line.stockKey) : null;
    if (!option || !line.quantity || !line.unitPrice) return { line, option, math: null, over: false };
    try {
      const math = computeSalesLine({
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        currency: header.currency,
        rateToUsd: header.rateToUsd || '1',
        bagWeightKg: option.bagWeightKg,
      });
      const claimed = claimedElsewhere(line.stockKey!, line.key);
      const over = math.quantityKg.plus(claimed).greaterThan(dec(option.availableKg));
      return { line, option, math, over };
    } catch {
      return { line, option, math: null, over: false };
    }
  });

  // Tax is previewed here from the chosen code's rate, and computed again on
  // the server from the code itself. Only the server's figure is ever saved —
  // this one exists so the person typing sees what the customer will owe.
  const rateFor = React.useCallback(
    (taxCodeId: string) => dec(taxCodes.find((code) => code.id === taxCodeId)?.ratePct ?? 0),
    [taxCodes],
  );

  const totals = React.useMemo(() => {
    const valid = computed.filter((c) => c.math);
    const net = toMoney(sum(valid.map((c) => c.math!.lineTotal)));
    const tax = taxEnabled
      ? toMoney(
          sum(
            valid.map((c) => {
              const rate = rateFor(c.line.taxCodeId);
              return rate.isZero() ? dec(0) : toMoney(c.math!.lineTotal.times(rate).dividedBy(100));
            }),
          ),
        )
      : dec(0);
    return {
      quantityKg: sum(valid.map((c) => c.math!.quantityKg)),
      net,
      tax,
      amount: toMoney(net.plus(tax)),
      amountUsd: toMoney(sum(valid.map((c) => c.math!.lineTotalUsd))),
    };
  }, [computed, rateFor, taxEnabled]);

  const hasOverdraw = computed.some((c) => c.over);

  function submit() {
    setError(null);
    setFieldIssues({});

    if (hasOverdraw) {
      setError('One or more lines exceed the stock available in that warehouse.');
      return;
    }

    const payload = {
      ...header,
      dueDate: header.dueDate || undefined,
      paymentType: header.paymentType,
      cashBankAccountId: header.paymentType === 'CASH' ? header.cashBankAccountId : '',
      shipmentId: '',
      lines: lines
        .filter((l) => l.stockKey)
        .map((l) => {
          const option = stockByKey.get(l.stockKey!)!;
          return {
            batchId: option.batchId,
            warehouseId: option.warehouseId,
            quantity: l.quantity,
            unit: l.unit,
            unitPrice: l.unitPrice,
            taxCodeId: taxEnabled ? l.taxCodeId : '',
            notes: '',
          };
        }),
    };

    start(async () => {
      const result = await saveSalesInvoiceAction(defaults?.id ?? null, JSON.stringify(payload));
      if (!result) return;
      if (result.ok) {
        toast.success(result.message);
        opening();
        router.push(`/sales/${result.id}`);
      } else {
        setError(result.error);
        setFieldIssues(result.errors ?? {});
        focusFirstError();
      }
    });
  }

  if (stock.length === 0 && !defaults?.id) {
    return (
      <EmptyState
        icon={PackageX}
        title="No coffee available to sell"
        description="Approve a purchase contract and receive the goods into a warehouse before raising a sales invoice."
      />
    );
  }

  const isForeign = header.currency !== 'USD';

  return (
    <div className="space-y-5">
      <FormError message={error} fieldErrors={fieldIssues} />

      <Card>
        <CardHeader>
          <CardTitle>Invoice</CardTitle>
          <CardDescription>Who is buying, in which currency, and on what terms.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Customer"
            htmlFor="customerId"
            required
            error={fieldIssues.customerId}
            hint={
              <AddCustomer
                defaultCurrency={header.currency}
                onCreated={(customer) => {
                  setCustomers((prev) =>
                    [
                      ...prev,
                      {
                        value: customer.id,
                        label: customer.name,
                        hint: customer.currency,
                        currency: customer.currency,
                        paymentTermDays: customer.paymentTermDays,
                      },
                    ].sort((a, b) => a.label.localeCompare(b.label)),
                  );
                  setHeader({
                    ...header,
                    customerId: customer.id,
                    currency: customer.currency,
                    rateToUsd: customer.currency === 'USD' ? '1' : header.rateToUsd,
                    dueDate: header.invoiceDate
                      ? addDays(header.invoiceDate, customer.paymentTermDays)
                      : header.dueDate,
                  });
                }}
              />
            }
          >
            <Combobox
              autoFocus
              id="customerId"
              options={customers}
              value={header.customerId}
              onChange={(value) => {
                const customer = customers.find((c) => c.value === value);
                setHeader({
                  ...header,
                  customerId: value,
                  currency: customer?.currency ?? header.currency,
                  rateToUsd: customer?.currency === 'USD' ? '1' : header.rateToUsd,
                  // Their usual terms, offered as a date the user can change.
                  // Nobody has to count thirty days forward in their head, and
                  // nobody is stuck with thirty if the deal was different.
                  dueDate:
                    customer && header.invoiceDate
                      ? addDays(header.invoiceDate, customer.paymentTermDays)
                      : header.dueDate,
                });
              }}
              placeholder="Choose a customer…"
            />
          </Field>

          <Field label="Invoice date" htmlFor="invoiceDate" error={fieldIssues.invoiceDate}>
            <Input
              id="invoiceDate"
              type="date"
              value={header.invoiceDate}
              onChange={(e) => setHeader({ ...header, invoiceDate: e.target.value })}
            />
          </Field>

          <Field
            label="Due date"
            htmlFor="dueDate"
            hint="For a cash sale, the same day as the invoice."
          >
            <Input
              id="dueDate"
              type="date"
              value={header.dueDate}
              min={header.invoiceDate || undefined}
              onChange={(e) => setHeader({ ...header, dueDate: e.target.value })}
            />
          </Field>

          <Field label="Currency" htmlFor="currency" hint="Defaults to the customer's ledger currency.">
            <Select
              id="currency"
              value={header.currency}
              onChange={(e) =>
                setHeader({
                  ...header,
                  currency: e.target.value,
                  // Propose the rate on file rather than blanking it and
                  // making somebody look it up.
                  rateToUsd: ratesByCurrency?.[e.target.value] ?? (e.target.value === 'USD' ? '1' : ''),
                })
              }
            >
              <option value="USD">USD — US Dollar</option>
              <option value="AED">AED — UAE Dirham</option>
              <option value="MAD">MAD — Moroccan Dirham</option>
            </Select>
          </Field>

          <Field label="Customer reference" htmlFor="reference">
            <Input
              id="reference"
              value={header.reference}
              onChange={(e) => setHeader({ ...header, reference: e.target.value })}
              placeholder="Customer PO number"
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Coffee sold</CardTitle>
            <CardDescription>
              Each line draws from one batch in one warehouse. Choose the warehouse first, or search all stock if you
              already know the batch. Availability is checked again when you post.
            </CardDescription>
          </div>
          <div className="inline-flex rounded-lg border border-line-strong p-0.5" role="group" aria-label="How to choose stock">
            <button
              type="button"
              onClick={() => setPickMode('warehouse')}
              aria-pressed={pickMode === 'warehouse'}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                pickMode === 'warehouse' ? 'bg-forest-800 text-white' : 'text-ink-muted hover:text-ink',
              )}
            >
              By warehouse
            </button>
            <button
              type="button"
              onClick={() => setPickMode('search')}
              aria-pressed={pickMode === 'search'}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                pickMode === 'search' ? 'bg-forest-800 text-white' : 'text-ink-muted hover:text-ink',
              )}
            >
              Search stock
            </button>
          </div>

          <Button variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, newLine(defaultTaxCodeId)])}>
            <Plus />
            Add line
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {fieldIssues.lines ? <p className="text-xs font-medium text-red-600">{fieldIssues.lines}</p> : null}

          {computed.map(({ line, option, math, over }, index) => (
            <div
              key={line.key}
              className={`rounded-lg border p-4 ${over ? 'border-red-300 bg-red-50/40' : 'border-line bg-forest-50/30'}`}
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
                  Line {index + 1}
                </span>
                {lines.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove line ${index + 1}`}
                    onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                  >
                    <Trash2 className="text-red-500" />
                  </Button>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {/*
                  Warehouse, then coffee, then batch — §11, in that order.
                  
                  A single "batch and warehouse" picker worked but asked the
                  question backwards: the user knows which store they are
                  selling out of before they know which parcel. Choosing the
                  warehouse first also narrows what follows to stock that is
                  actually in that warehouse, so a batch sitting in the other
                  store cannot be picked by mistake.
                */}
                {pickMode === 'search' ? (
                  <Field label="Batch and warehouse" required className="lg:col-span-3">
                    <Combobox
                      options={stock}
                      value={line.stockKey}
                      onChange={(value) => {
                        // Keep the cascade in step, so switching back shows
                        // the warehouse and coffee this batch belongs to.
                        const option = stock.find((o) => o.value === value);
                        setLine(line.key, {
                          stockKey: value,
                          warehouseId: option?.warehouseId ?? '',
                          itemId: option?.itemId ?? '',
                        });
                      }}
                      placeholder="Search batch, lot, container or coffee…"
                      emptyText="No stock matches"
                    />
                  </Field>
                ) : (
                <>
                <Field label="Warehouse" required>
                  <Select
                    value={line.warehouseId}
                    onChange={(e) =>
                      // Changing the warehouse invalidates the coffee and the
                      // batch beneath it, so both are cleared rather than left
                      // pointing at stock that is somewhere else.
                      setLine(line.key, { warehouseId: e.target.value, itemId: '', stockKey: null })
                    }
                  >
                    <option value="">Choose…</option>
                    {warehousesWithStock.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Coffee" required>
                  <Select
                    value={line.itemId}
                    disabled={!line.warehouseId}
                    onChange={(e) => setLine(line.key, { itemId: e.target.value, stockKey: null })}
                  >
                    <option value="">{line.warehouseId ? 'Choose…' : 'Choose a warehouse first'}</option>
                    {itemsIn(line.warehouseId).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Batch" required hint="Only batches with stock in that warehouse.">
                  <Select
                    value={line.stockKey ?? ''}
                    disabled={!line.itemId}
                    onChange={(e) => setLine(line.key, { stockKey: e.target.value || null })}
                  >
                    <option value="">{line.itemId ? 'Choose…' : 'Choose the coffee first'}</option>
                    {batchesIn(line.warehouseId, line.itemId).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.batchNumber} — {Number(option.availableKg).toLocaleString()} KG available
                      </option>
                    ))}
                  </Select>
                </Field>
                </>
                )}

                <Field label="Quantity" required>
                  <Input
                    value={line.quantity}
                    onChange={(e) => setLine(line.key, { quantity: e.target.value })}
                    inputMode="decimal"
                    className="tnum text-right"
                    aria-invalid={over}
                  />
                </Field>

                <Field label="Unit">
                  <Select
                    value={line.unit}
                    onChange={(e) => setLine(line.key, { unit: e.target.value as LineState['unit'] })}
                  >
                    <option value="KG">KG</option>
                    <option value="MT">MT</option>
                    <option value="BAG">Bags</option>
                  </Select>
                </Field>

                <Field label={`Price per ${line.unit === 'BAG' ? 'bag' : line.unit}`} required>
                  <MoneyInput
                    currency={header.currency}
                    value={line.unitPrice}
                    onChange={(e) => setLine(line.key, { unitPrice: e.target.value })}
                  />
                </Field>

                {taxEnabled ? (
                  <Field label={taxLabel}>
                    <Select
                      value={line.taxCodeId}
                      onChange={(e) => setLine(line.key, { taxCodeId: e.target.value })}
                      aria-label={`${taxLabel} code on this line`}
                    >
                      {taxCodes.map((code) => (
                        <option key={code.id} value={code.id}>
                          {code.code} — {Number(code.ratePct).toFixed(2)}%
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}

                {math ? (
                  <Field label="Line value">
                    <div className="tnum flex h-10 items-center justify-end rounded-lg border border-line bg-surface px-3 text-sm font-semibold">
                      {formatMoney(math.lineTotal, header.currency)}
                    </div>
                  </Field>
                ) : null}
              </div>

              {option ? (
                <p className={`mt-3 border-t pt-3 text-xs ${over ? 'border-red-200 text-red-700' : 'border-line text-ink-muted'}`}>
                  {over ? (
                    <>
                      <strong>Not enough stock.</strong> {option.warehouseName} holds{' '}
                      {formatQuantityKg(option.availableKg)} of batch {option.batchNumber} —
                      {math ? ` this line needs ${formatQuantityKg(math.quantityKg)}.` : ' reduce the quantity.'}
                    </>
                  ) : (
                    <>
                      {option.warehouseName} · {formatQuantityKg(option.availableKg)} available
                      {math ? ` · selling ${formatQuantityKg(math.quantityKg)}` : ''}
                    </>
                  )}
                </p>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <FormSection
            title="Exchange rates"
            description={
              isForeign
                ? `${header.currency} ${header.rateToUsd || '—'} per USD · ${localCurrency} ${header.rateLocalPerUsd || '—'} per USD. Taken from the rates on file; change them if this invoice was agreed at a different one.`
                : `${localCurrency} ${header.rateLocalPerUsd || '—'} per USD, used for this company's own reporting.`
            }
            collapsible
            className="sm:col-span-2 lg:col-span-3"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {isForeign ? (
                <Field
                  label={`${header.currency} per 1 USD`}
                  htmlFor="rateToUsd"
                  error={fieldIssues.rateToUsd}
                  hint="What this invoice was agreed at. Stored on the voucher and never recalculated later."
                >
                  <Input
                    id="rateToUsd"
                    value={header.rateToUsd}
                    onChange={(e) => setHeader({ ...header, rateToUsd: e.target.value })}
                    className="tnum text-right"
                  />
                </Field>
              ) : null}

              <Field
                label={`${localCurrency} per 1 USD`}
                htmlFor="rateLocalPerUsd"
                hint="Used for this company's own reporting, whatever the invoice currency."
              >
                <Input
                  id="rateLocalPerUsd"
                  value={header.rateLocalPerUsd}
                  onChange={(e) => setHeader({ ...header, rateLocalPerUsd: e.target.value })}
                  className="tnum text-right"
                />
              </Field>
            </div>
          </FormSection>

          <Field label="Notes" htmlFor="notes">
            <Textarea
              id="notes"
              value={header.notes}
              onChange={(e) => setHeader({ ...header, notes: e.target.value })}
            />
          </Field>
        </CardContent>
      </Card>

      {totals.quantityKg.greaterThan(0) ? (
        <Card className="border-forest-200 bg-forest-50/50">
          <CardContent className="pt-5">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-ink-muted">Total quantity</dt>
                <dd className="tnum text-base font-semibold">{formatQuantityKg(totals.quantityKg)}</dd>
              </div>
              {taxEnabled ? (
                <>
                  <div>
                    <dt className="text-xs text-ink-muted">Net of {taxLabel}</dt>
                    <dd className="tnum text-base font-semibold">{formatMoney(totals.net, header.currency)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-muted">{taxLabel}</dt>
                    <dd className="tnum text-base font-semibold">{formatMoney(totals.tax, header.currency)}</dd>
                  </div>
                </>
              ) : null}
              <div>
                <dt className="text-xs text-ink-muted">Invoice value</dt>
                <dd className="tnum text-base font-semibold text-forest-800">
                  {formatMoney(totals.amount, header.currency)}
                </dd>
              </div>
              {isForeign ? (
                <div>
                  <dt className="text-xs text-ink-muted">USD equivalent</dt>
                  <dd className="tnum text-base font-semibold">{formatMoney(totals.amountUsd, 'USD')}</dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      ) : null}

      {/*
        Cash or credit, at the bottom of the invoice, where the client asked
        for it. A cash sale settles as it is raised — posting it records the
        receipt too — so it needs to know which account took the money.
      */}
      <Card>
        <CardHeader>
          <CardTitle>How is this being paid?</CardTitle>
          <CardDescription>
            A cash sale is settled the moment it is posted. A credit sale stays outstanding on the customer&rsquo;s
            ledger until a payment is recorded against it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Payment type">
            <Select
              value={header.paymentType}
              onChange={(e) =>
                setHeader({ ...header, paymentType: e.target.value as 'CASH' | 'CREDIT', cashBankAccountId: '' })
              }
            >
              <option value="CREDIT">Credit — pay later</option>
              <option value="CASH">Cash — paid now</option>
            </Select>
          </Field>

          {header.paymentType === 'CASH' ? (
            <Field
              label="Paid into"
              required
              hint={`Only ${header.currency} accounts are shown.`}
              error={fieldIssues.cashBankAccountId}
            >
              <Select
                value={header.cashBankAccountId}
                onChange={(e) => setHeader({ ...header, cashBankAccountId: e.target.value })}
              >
                <option value="">Choose an account…</option>
                {cashAccounts
                  .filter((account) => account.currency === header.currency)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} ({account.code})
                    </option>
                  ))}
              </Select>
            </Field>
          ) : null}
        </CardContent>
      </Card>

      <Callout tone="info" title="This saves as a draft">
        A draft reserves the stock so nobody else can sell it, but it does not touch the ledgers. Posting relieves the
        stock, records cost of goods sold at the batch&rsquo;s landed cost and raises the receivable
        {header.paymentType === 'CASH' ? ', then settles it with the cash receipt' : ''}.
      </Callout>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} loading={busy} disabled={hasOverdraw}>
          {defaults?.id ? 'Save changes' : 'Save draft'}
        </Button>
      </div>
    </div>
  );
}


/** `2026-09-10` plus n days, as `2026-10-10`. Date inputs speak this format. */
function addDays(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Date(parsed.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
