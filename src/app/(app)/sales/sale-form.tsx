'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Trash2, PackageX } from 'lucide-react';
import { focusFirstError } from '@/lib/focus-first-error';
import { FormError } from '@/components/shared/form-error';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Select } from '@/components/ui/input';
import { Field, FormSection } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { computeSalesLine } from '@/lib/calc/sales';
import { dec, toMoney, sum } from '@/lib/money';
import { formatMoney, formatQuantityKg, todayInputValue } from '@/lib/format';
import { preferZeroRateTax } from '@/lib/tax-default';
import { saveSalesInvoiceAction, postSalesInvoiceAction } from '@/server/actions/trading-actions';
import { useSaveAndOpen } from '@/lib/use-save-and-open';
import { AddCustomer } from '@/app/(app)/sales/add-customer';
import { InvoiceDeleteButton, canCancelSalesInvoice } from '@/app/(app)/sales/[id]/sale-actions';

/**
 * Sales invoice entry.
 *
 * Warehouse is chosen once at the top. Every line then picks coffee and batch
 * from that warehouse. Two empty rows are shown so a second coffee does not
 * require an extra click; a blank second row is simply ignored on save.
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
  itemId: string;
  stockKey: string | null;
  quantity: string;
  unit: 'KG' | 'MT' | 'BAG';
  unitPrice: string;
  taxCodeId: string;
};

export type SaleFormDefaults = {
  id?: string;
  status?: string;
  invoiceNumber?: string;
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
  warehouseId?: string;
  lines?: Array<Omit<LineState, 'key' | 'itemId'> & { itemId?: string; warehouseId?: string }>;
};

const newLine = (taxCodeId = ''): LineState => ({
  key: Math.random().toString(36).slice(2),
  itemId: '',
  stockKey: null,
  quantity: '',
  unit: 'KG',
  unitPrice: '',
  taxCodeId,
});

function atLeastTwo(lines: LineState[], taxCodeId: string): LineState[] {
  if (lines.length >= 2) return lines;
  return [...lines, ...Array.from({ length: 2 - lines.length }, () => newLine(taxCodeId))];
}

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
  canApprove = true,
  canCreateCustomer = true,
  canDelete = false,
  canReverse = false,
}: {
  customers: Array<ComboOption & { currency: string }>;
  cashAccounts: Array<{ id: string; name: string; code: string; currency: string }>;
  stock: StockOption[];
  localCurrency: string;
  defaultCurrency: string;
  defaultLocalRate: string;
  ratesByCurrency?: Record<string, string>;
  taxCodes?: Array<{ id: string; code: string; name: string; ratePct: string }>;
  taxLabel?: string;
  taxEnabled?: boolean;
  defaults?: SaleFormDefaults;
  canApprove?: boolean;
  canCreateCustomer?: boolean;
  canDelete?: boolean;
  canReverse?: boolean;
}) {
  const defaultTaxCodeId = preferZeroRateTax(taxCodes)?.id ?? '';
  const taxOptions = React.useMemo(
    () => [...taxCodes].sort((a, b) => Number(a.ratePct) - Number(b.ratePct) || a.code.localeCompare(b.code)),
    [taxCodes],
  );
  const router = useRouter();
  const [addCustomerOpen, setAddCustomerOpen] = React.useState(false);
  const [addCustomerName, setAddCustomerName] = React.useState('');
  const [customers, setCustomers] = React.useState(initialCustomers);
  const { busy, start, opening } = useSaveAndOpen();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = React.useState<Record<string, string>>({});

  const warehousesWithStock = React.useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>();
    for (const option of stock) {
      if (!seen.has(option.warehouseId)) {
        seen.set(option.warehouseId, { id: option.warehouseId, name: option.warehouseName });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [stock]);

  const initialWarehouseId = (() => {
    if (defaults?.warehouseId) return defaults.warehouseId;
    const firstKey = defaults?.lines?.[0]?.stockKey;
    const fromLine = firstKey ? stock.find((option) => option.value === firstKey)?.warehouseId : '';
    if (fromLine) return fromLine;
    if (warehousesWithStock.length === 1) return warehousesWithStock[0].id;
    return '';
  })();

  const [header, setHeader] = React.useState({
    invoiceNumber: defaults?.invoiceNumber ?? '',
    invoiceDate: defaults?.invoiceDate ?? todayInputValue(),
    customerId: defaults?.customerId ?? null,
    currency: defaults?.currency ?? defaultCurrency,
    rateToUsd: defaults?.rateToUsd ?? (defaultCurrency === 'USD' ? '1' : defaultLocalRate),
    rateLocalPerUsd: defaults?.rateLocalPerUsd ?? defaultLocalRate,
    dueDate: defaults?.dueDate ?? '',
    paymentType: defaults?.paymentType ?? 'CREDIT',
    cashBankAccountId: defaults?.cashBankAccountId ?? '',
    reference: defaults?.reference ?? '',
    notes: defaults?.notes ?? '',
    warehouseId: initialWarehouseId,
  });
  const isPosted = defaults?.status === 'POSTED';

  const [lines, setLines] = React.useState<LineState[]>(() =>
    atLeastTwo(
      defaults?.lines?.length
        ? defaults.lines.map((line, index) => {
            const option = stock.find((o) => o.value === line.stockKey);
            return {
              key: `line-${index}`,
              itemId: option?.itemId ?? line.itemId ?? '',
              stockKey: line.stockKey ?? null,
              quantity: line.quantity,
              unit: line.unit,
              unitPrice: line.unitPrice,
              taxCodeId: line.taxCodeId || defaultTaxCodeId,
            };
          })
        : [newLine(defaultTaxCodeId)],
      defaultTaxCodeId,
    ),
  );

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
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function changeWarehouse(warehouseId: string) {
    setHeader((prev) => ({ ...prev, warehouseId }));
    setLines((prev) => prev.map((line) => ({ ...line, itemId: '', stockKey: null })));
  }

  const stockByKey = React.useMemo(() => new Map(stock.map((s) => [s.value, s])), [stock]);

  function claimedElsewhere(stockKey: string, exceptKey: string) {
    return sum(
      lines
        .filter((line) => line.stockKey === stockKey && line.key !== exceptKey && line.quantity)
        .map((line) => {
          const option = stockByKey.get(stockKey);
          try {
            return computeSalesLine({
              quantity: line.quantity,
              unit: line.unit,
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
  const warehouseId = header.warehouseId;
  const itemOptions = itemsIn(warehouseId).map((item) => ({ value: item.id, label: item.name }));

  function submit() {
    setError(null);
    setFieldIssues({});

    if (hasOverdraw) {
      setError('One or more lines exceed the stock available in that warehouse.');
      return;
    }

    const payload = {
      invoiceNumber: header.invoiceNumber,
      invoiceDate: header.invoiceDate,
      customerId: header.customerId ?? '',
      currency: header.currency,
      rateToUsd: header.rateToUsd,
      rateLocalPerUsd: header.rateLocalPerUsd,
      dueDate: header.dueDate || undefined,
      paymentType: header.paymentType,
      cashBankAccountId: header.paymentType === 'CASH' ? header.cashBankAccountId : '',
      shipmentId: '',
      reference: header.reference,
      notes: header.notes,
      lines: lines
        .filter((line) => line.stockKey)
        .map((line) => {
          const option = stockByKey.get(line.stockKey!)!;
          return {
            batchId: option.batchId,
            warehouseId: option.warehouseId,
            quantity: line.quantity,
            unit: line.unit,
            unitPrice: line.unitPrice,
            taxCodeId: taxEnabled ? line.taxCodeId : '',
            notes: '',
          };
        }),
    };

    start(async () => {
      const result = await saveSalesInvoiceAction(defaults?.id ?? null, JSON.stringify(payload));
      if (!result) return;

      if (!result.ok) {
        setError(result.error);
        setFieldIssues(result.errors ?? {});
        focusFirstError();
        return;
      }

      if (isPosted) {
        toast.success('Invoice updated.');
      } else if (canApprove) {
        const posted = await postSalesInvoiceAction(result.id);
        if (!posted.ok) {
          setError(
            `${posted.error} The invoice is saved as a draft — open it to post once that is resolved.`,
          );
          opening();
          router.push(`/sales/${result.id}`);
          return;
        }

        toast.success(defaults?.id ? 'Invoice updated and posted.' : 'Invoice posted.');
      } else {
        toast.success(defaults?.id ? 'Draft updated.' : 'Invoice saved as a draft.');
      }
      opening();
      router.push(`/sales/${result.id}`);
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
          <CardDescription>Customer, dates, and the warehouse this invoice is issued from.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <div className="flex items-end gap-2">
              <Field
                label="Customer"
                htmlFor="customerId"
                required
                error={fieldIssues.customerId}
                className="min-w-0 flex-1"
              >
                <Combobox
                  autoFocus
                  id="customerId"
                  options={customers}
                  value={header.customerId}
                  onChange={(value) => {
                    const customer = customers.find((c) => c.value === value);
                    setHeader((prev) => ({
                      ...prev,
                      customerId: value,
                      currency: customer?.currency ?? prev.currency,
                      rateToUsd: customer?.currency === 'USD' ? '1' : prev.rateToUsd,
                    }));
                  }}
                  placeholder="Choose a customer…"
                  createLabel={canCreateCustomer ? '+ Add Customer' : undefined}
                  onCreate={
                    canCreateCustomer
                      ? (query) => {
                          setAddCustomerName(query ?? '');
                          setAddCustomerOpen(true);
                        }
                      : undefined
                  }
                />
              </Field>
              {canCreateCustomer ? (
                <Button
                  type="button"
                  variant="outline"
                  className="mb-0.5 shrink-0"
                  onClick={() => {
                    setAddCustomerName('');
                    setAddCustomerOpen(true);
                  }}
                >
                  Add Customer
                </Button>
              ) : null}
            </div>
            {canCreateCustomer ? (
              <AddCustomer
                defaultCurrency={header.currency}
                initialName={addCustomerName}
                open={addCustomerOpen}
                onOpenChange={(next) => {
                  setAddCustomerOpen(next);
                  if (!next) setAddCustomerName('');
                }}
                onCreated={(customer) => {
                  setCustomers((prev) => {
                    if (prev.some((row) => row.value === customer.id)) return prev;
                    return [
                      ...prev,
                      {
                        value: customer.id,
                        label: customer.name,
                        hint: customer.currency,
                        currency: customer.currency,
                      },
                    ].sort((a, b) => a.label.localeCompare(b.label));
                  });
                  setHeader((prev) => ({
                    ...prev,
                    customerId: customer.id,
                    currency: customer.currency,
                    rateToUsd:
                      customer.currency === 'USD'
                        ? '1'
                        : (ratesByCurrency?.[customer.currency] ?? prev.rateToUsd),
                  }));
                }}
              />
            ) : null}
          </div>

          <Field
            label="Invoice number"
            htmlFor="invoiceNumber"
            error={fieldIssues.invoiceNumber}
            hint="The next free number. You can type a different one — 5 or 005 both become the same document number."
          >
            <Input
              id="invoiceNumber"
              value={header.invoiceNumber}
              onChange={(e) => setHeader({ ...header, invoiceNumber: e.target.value })}
              placeholder="Next free number"
              autoComplete="off"
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

          <Field label="Due date" htmlFor="dueDate" hint="For a cash sale, the same day as the invoice.">
            <Input
              id="dueDate"
              type="date"
              value={header.dueDate}
              min={header.invoiceDate || undefined}
              onChange={(e) => setHeader({ ...header, dueDate: e.target.value })}
            />
          </Field>

          <Field
            label="Warehouse"
            htmlFor="warehouseId"
            required
            hint="Every item on this invoice leaves this warehouse."
            className="lg:col-span-2"
          >
            <Select
              id="warehouseId"
              value={header.warehouseId}
              onChange={(e) => changeWarehouse(e.target.value)}
            >
              <option value="">Choose…</option>
              {warehousesWithStock.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Currency" htmlFor="currency" hint="Defaults to the customer's ledger currency.">
            <Select
              id="currency"
              value={header.currency}
              onChange={(e) =>
                setHeader({
                  ...header,
                  currency: e.target.value,
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
            <CardTitle>Items</CardTitle>
            <CardDescription>
              Two rows are ready. Leave the second blank if you are selling one coffee. Availability is checked again
              when you post.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLines((prev) => [...prev, newLine(defaultTaxCodeId)])}
          >
            <Plus />
            Add item
          </Button>
        </CardHeader>
        <CardContent className="space-y-5">
          {fieldIssues.lines ? <p className="text-xs font-medium text-red-600">{fieldIssues.lines}</p> : null}

          {computed.map(({ line, option, math, over }, index) => {
            const available = option
              ? formatQuantityKg(option.availableKg)
              : line.itemId
                ? '—'
                : warehouseId
                  ? '—'
                  : '—';
            return (
              <div key={line.key} className="space-y-3 border-b border-line pb-5 last:border-b-0 last:pb-0">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
                    Item {index + 1}
                  </span>
                  {lines.length > 2 || (lines.length > 1 && !line.stockKey && !line.itemId) ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove item ${index + 1}`}
                      onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== line.key) : prev))}
                    >
                      <Trash2 className="text-red-500" />
                    </Button>
                  ) : null}
                </div>

                <div className="grid gap-3 lg:grid-cols-12">
                  <Field label="Item" required className="lg:col-span-4">
                    <Combobox
                      wrap
                      className="min-h-11 text-base"
                      options={itemOptions}
                      value={line.itemId || null}
                      onChange={(value) => setLine(line.key, { itemId: value ?? '', stockKey: null })}
                      placeholder={warehouseId ? 'Choose coffee…' : 'Choose a warehouse first'}
                      emptyText="No coffee in this warehouse"
                      disabled={!warehouseId}
                      aria-label={`Coffee on item ${index + 1}`}
                    />
                  </Field>

                  <Field label="Batch" required className="lg:col-span-3">
                    <Select
                      value={line.stockKey ?? ''}
                      disabled={!line.itemId}
                      onChange={(e) => setLine(line.key, { stockKey: e.target.value || null })}
                      aria-label={`Batch on item ${index + 1}`}
                    >
                      <option value="">{line.itemId ? 'Choose…' : 'Choose the coffee first'}</option>
                      {batchesIn(warehouseId, line.itemId).map((batch) => (
                        <option key={batch.value} value={batch.value}>
                          {batch.batchNumber} — {Number(batch.availableKg).toLocaleString()} KG available
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field label="Available KG" className="lg:col-span-2">
                    <div className="tnum flex h-10 items-center rounded-lg border border-line bg-forest-50 px-3 text-sm">
                      {option ? formatQuantityKg(option.availableKg) : available}
                    </div>
                  </Field>

                  <Field label="Quantity" required className="lg:col-span-3">
                    <div className="flex gap-2">
                      <Input
                        value={line.quantity}
                        onChange={(e) => setLine(line.key, { quantity: e.target.value })}
                        inputMode="decimal"
                        className="tnum text-right"
                        aria-invalid={over}
                        aria-label={`Quantity on item ${index + 1}`}
                      />
                      <Select
                        value={line.unit}
                        onChange={(e) => setLine(line.key, { unit: e.target.value as LineState['unit'] })}
                        aria-label={`Unit on item ${index + 1}`}
                        className="w-24"
                      >
                        <option value="KG">KG</option>
                        <option value="MT">MT</option>
                        <option value="BAG">Bags</option>
                      </Select>
                    </div>
                  </Field>

                  <Field label={`Price / ${line.unit === 'BAG' ? 'bag' : line.unit}`} required className="lg:col-span-3">
                    <MoneyInput
                      currency={header.currency}
                      value={line.unitPrice}
                      onChange={(e) => setLine(line.key, { unitPrice: e.target.value })}
                    />
                  </Field>

                  <Field label="Amount" className="lg:col-span-3">
                    <div className="tnum flex h-10 items-center justify-end rounded-lg border border-line bg-surface px-3 text-sm font-semibold">
                      {math ? formatMoney(math.lineTotal, header.currency) : '—'}
                    </div>
                  </Field>

                  {taxEnabled ? (
                    <Field label={taxLabel} className="lg:col-span-3">
                      <Select
                        value={line.taxCodeId}
                        onChange={(e) => setLine(line.key, { taxCodeId: e.target.value })}
                        aria-label={`${taxLabel} on item ${index + 1}`}
                      >
                        {taxOptions.map((code) => (
                          <option key={code.id} value={code.id}>
                            {code.code} — {Number(code.ratePct).toFixed(2)}%
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : null}
                </div>

                {over && option ? (
                  <p className="text-xs text-red-700">
                    <strong>Not enough stock.</strong> {option.warehouseName} holds{' '}
                    {formatQuantityKg(option.availableKg)} of batch {option.batchNumber}
                    {math ? ` — this line needs ${formatQuantityKg(math.quantityKg)}.` : '.'}
                  </p>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <FormSection
            title="Exchange rates"
            description={
              isForeign
                ? `${header.currency} ${header.rateToUsd || '—'} per USD · ${localCurrency} ${header.rateLocalPerUsd || '—'} per USD.`
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
                  hint="What this invoice was agreed at."
                >
                  <Input
                    id="rateToUsd"
                    value={header.rateToUsd}
                    onChange={(e) => setHeader({ ...header, rateToUsd: e.target.value })}
                    className="tnum text-right"
                  />
                </Field>
              ) : null}

              <Field label={`${localCurrency} per 1 USD`} htmlFor="rateLocalPerUsd">
                <Input
                  id="rateLocalPerUsd"
                  value={header.rateLocalPerUsd}
                  onChange={(e) => setHeader({ ...header, rateLocalPerUsd: e.target.value })}
                  className="tnum text-right"
                />
              </Field>
            </div>
          </FormSection>
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

      <Card>
        <CardHeader>
          <CardTitle>How is this being paid?</CardTitle>
          <CardDescription>
            A cash sale is settled the moment it is posted. A credit sale stays outstanding on the customer&rsquo;s
            ledger until a payment is recorded against it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Payment type"
            hint={isPosted ? 'Cash or credit cannot be changed on a posted invoice.' : undefined}
          >
            <Select
              value={header.paymentType}
              disabled={isPosted}
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
              hint={
                isPosted
                  ? 'The cash account on a posted invoice cannot be changed.'
                  : `Only ${header.currency} accounts are shown.`
              }
              error={fieldIssues.cashBankAccountId}
            >
              <Select
                value={header.cashBankAccountId}
                disabled={isPosted}
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

      {isPosted ? (
        <Callout tone="info" title="Saving restates this posted invoice">
          Quantity, rate, batch and dates can be corrected — including when the weighed KG differs from what was first
          entered. The invoice total, warehouse stock, customer balance and the related ledger entries are recalculated
          together.
        </Callout>
      ) : canApprove ? (
        <Callout tone="info" title="Saving posts this invoice">
          The coffee comes out of the batch you chose, cost of goods sold is recorded at that batch&rsquo;s landed cost
          and the customer is invoiced
          {header.paymentType === 'CASH'
            ? ', then the cash receipt settles it straight away — the money is in the account you named, dated today.'
            : ', and it stays outstanding on their ledger until a payment is recorded against it.'}
        </Callout>
      ) : (
        <Callout tone="info" title="Saving keeps this invoice as a draft">
          Stock is reserved. Someone who can approve sales will post it, which is when the coffee leaves the warehouse
          and the customer is billed.
        </Callout>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {defaults?.id &&
        canCancelSalesInvoice(defaults.status ?? 'DRAFT', {
          canDelete,
          canReverse,
          canEdit: true,
          canApprove,
        }) ? (
          <div className="sm:mr-auto">
            <InvoiceDeleteButton id={defaults.id} status={defaults.status ?? 'DRAFT'} />
          </div>
        ) : null}
        <Button variant="outline" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} loading={busy}>
          {busy ? 'Saving…' : defaults?.id ? 'Save changes' : canApprove ? 'Save invoice' : 'Save as draft'}
        </Button>
      </div>
    </div>
  );
}
