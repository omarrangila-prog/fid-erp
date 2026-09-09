'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Trash2, AlertCircle, PackageX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { computeSalesLine } from '@/lib/calc/sales';
import { dec, toMoney, sum } from '@/lib/money';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import { saveSalesInvoiceAction } from '@/server/actions/trading-actions';

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
  warehouseName: string;
  shipmentId: string;
};

type LineState = {
  key: string;
  stockKey: string | null;
  quantity: string;
  unit: 'KG' | 'MT' | 'BAG';
  unitPrice: string;
};

export type SaleFormDefaults = {
  id?: string;
  invoiceDate?: string;
  customerId?: string;
  currency?: string;
  rateToUsd?: string;
  rateLocalPerUsd?: string;
  paymentTermDays?: string;
  reference?: string;
  notes?: string;
  lines?: Array<Omit<LineState, 'key'>>;
};

const newLine = (): LineState => ({
  key: Math.random().toString(36).slice(2),
  stockKey: null,
  quantity: '',
  unit: 'KG',
  unitPrice: '',
});

export function SaleForm({
  customers,
  stock,
  localCurrency,
  defaultCurrency,
  defaultLocalRate,
  defaults,
}: {
  customers: Array<ComboOption & { currency: string; paymentTermDays: number }>;
  stock: StockOption[];
  localCurrency: string;
  defaultCurrency: string;
  defaultLocalRate: string;
  defaults?: SaleFormDefaults;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = React.useState<Record<string, string>>({});

  const [header, setHeader] = React.useState({
    invoiceDate: defaults?.invoiceDate ?? new Date().toISOString().slice(0, 10),
    customerId: defaults?.customerId ?? null,
    currency: defaults?.currency ?? defaultCurrency,
    rateToUsd: defaults?.rateToUsd ?? (defaultCurrency === 'USD' ? '1' : defaultLocalRate),
    rateLocalPerUsd: defaults?.rateLocalPerUsd ?? defaultLocalRate,
    paymentTermDays: defaults?.paymentTermDays ?? '30',
    reference: defaults?.reference ?? '',
    notes: defaults?.notes ?? '',
  });

  // Built in a lazy initialiser so the random keys are generated once, on mount,
  // rather than on every render.
  const [lines, setLines] = React.useState<LineState[]>(() =>
    defaults?.lines?.length ? defaults.lines.map((l, i) => ({ ...l, key: `line-${i}` })) : [newLine()],
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

  const totals = React.useMemo(() => {
    const valid = computed.filter((c) => c.math);
    return {
      quantityKg: sum(valid.map((c) => c.math!.quantityKg)),
      amount: toMoney(sum(valid.map((c) => c.math!.lineTotal))),
      amountUsd: toMoney(sum(valid.map((c) => c.math!.lineTotalUsd))),
    };
  }, [computed]);

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
      paymentTermDays: Number(header.paymentTermDays || 0),
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
            notes: '',
          };
        }),
    };

    startTransition(async () => {
      const result = await saveSalesInvoiceAction(defaults?.id ?? null, JSON.stringify(payload));
      if (!result) return;
      if (result.ok) {
        toast.success(result.message);
        router.push(`/sales/${result.id}`);
        router.refresh();
      } else {
        setError(result.error);
        setFieldIssues(result.errors ?? {});
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
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Invoice</CardTitle>
          <CardDescription>Who is buying, in which currency, and on what terms.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Customer" htmlFor="customerId" required error={fieldIssues.customerId}>
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
                  paymentTermDays: customer ? String(customer.paymentTermDays) : header.paymentTermDays,
                });
              }}
              placeholder="Choose a customer…"
            />
          </Field>

          <Field label="Invoice date" htmlFor="invoiceDate" required error={fieldIssues.invoiceDate}>
            <Input
              id="invoiceDate"
              type="date"
              value={header.invoiceDate}
              onChange={(e) => setHeader({ ...header, invoiceDate: e.target.value })}
            />
          </Field>

          <Field label="Payment terms (days)" htmlFor="paymentTermDays">
            <Input
              id="paymentTermDays"
              value={header.paymentTermDays}
              onChange={(e) => setHeader({ ...header, paymentTermDays: e.target.value })}
              className="tnum text-right"
            />
          </Field>

          <Field label="Currency" htmlFor="currency" required hint="Defaults to the customer's ledger currency.">
            <Select
              id="currency"
              value={header.currency}
              onChange={(e) =>
                setHeader({ ...header, currency: e.target.value, rateToUsd: e.target.value === 'USD' ? '1' : '' })
              }
            >
              <option value="USD">USD — US Dollar</option>
              <option value="AED">AED — UAE Dirham</option>
              <option value="MAD">MAD — Moroccan Dirham</option>
            </Select>
          </Field>

          <Field
            label="Rate to USD"
            htmlFor="rateToUsd"
            required
            hint={isForeign ? `Units of ${header.currency} per 1 USD.` : 'USD is always 1.'}
            error={fieldIssues.rateToUsd}
          >
            <Input
              id="rateToUsd"
              value={header.rateToUsd}
              disabled={!isForeign}
              onChange={(e) => setHeader({ ...header, rateToUsd: e.target.value })}
              className="tnum text-right"
            />
          </Field>

          <Field label={`Rate to ${localCurrency}`} htmlFor="rateLocalPerUsd" required>
            <Input
              id="rateLocalPerUsd"
              value={header.rateLocalPerUsd}
              onChange={(e) => setHeader({ ...header, rateLocalPerUsd: e.target.value })}
              className="tnum text-right"
            />
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
              Each line draws from one batch in one warehouse. Availability is checked again when you post.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, newLine()])}>
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
                <Field label="Batch and warehouse" required className="lg:col-span-2">
                  <Combobox
                    options={stock}
                    value={line.stockKey}
                    onChange={(value) => setLine(line.key, { stockKey: value })}
                    placeholder="Choose stock to sell…"
                    emptyText="No stock matches"
                  />
                </Field>

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

      <Callout tone="info" title="This saves as a draft">
        A draft reserves the stock so nobody else can sell it, but it does not touch the ledgers. Posting relieves the
        stock, records cost of goods sold at the batch&rsquo;s landed cost and raises the receivable.
      </Callout>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} loading={pending} disabled={hasOverdraw}>
          {defaults?.id ? 'Save changes' : 'Save draft'}
        </Button>
      </div>
    </div>
  );
}
