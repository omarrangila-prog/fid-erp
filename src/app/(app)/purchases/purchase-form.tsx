'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Trash2, AlertCircle, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea, Select, MoneyInput, QuantityInput } from '@/components/ui/input';
import { Field, FormSection } from '@/components/ui/field';
import { Card, CardContent } from '@/components/ui/card';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Callout } from '@/components/ui/feedback';
import { ConfirmDialog } from '@/components/ui/confirm';
import { CONTAINER_TYPE_LABELS, INCOTERM_LABELS } from '@/lib/constants';
import { savePurchaseContractAction, postPurchaseContractAction } from '@/server/actions/trading-actions';
import { computePurchaseTotalsClient, type LineDraft } from '@/app/(app)/purchases/purchase-math';

/**
 * Purchase contract entry.
 *
 * One contract can carry several containers, each with its own lot and batch —
 * which is how the specification's worked example reads, and how coffee
 * actually arrives. Totals, freight allocation and the resulting landed cost
 * per kilogram are previewed live using the same arithmetic the server runs, so
 * what the buyer sees before approving is what gets posted.
 */

/** A coffee option carries the bag weight so the form can convert bag entry. */
export type ItemOption = ComboOption & { bagWeightKg: string; defaultUnit: string };

/** Line drafts supplied by the server have no client-only key yet. */
export type LineDefaults = Omit<LineDraft, 'key' | 'notes'> & { notes?: string };

export type PurchaseFormDefaults = {
  id?: string;
  contractReference?: string;
  supplierContractNo?: string;
  contractDate?: string;
  vendorId?: string;
  origin?: string;
  currency?: string;
  rateToUsd?: string;
  rateLocalPerUsd?: string;
  freightAmount?: string;
  otherCharges?: string;
  incoterm?: string;
  portOfLoading?: string;
  destination?: string;
  expectedShipmentDate?: string;
  paymentTermDays?: string;
  notes?: string;
  lines?: LineDefaults[];
};

const emptyLine = (bagWeightKg = '60'): LineDraft => ({
  key: crypto.randomUUID(),
  itemId: '',
  lotNumber: '',
  batchNumber: '',
  containerNumber: '',
  containerType: 'FT20',
  quantity: '',
  unit: 'KG',
  unitPrice: '',
  bags: '',
  bagWeightKg,
  notes: '',
});

export function PurchaseForm({
  vendors,
  items,
  localCurrency,
  defaultLocalRate,
  defaults,
  canApprove = true,
}: {
  vendors: ComboOption[];
  items: ItemOption[];
  localCurrency: string;
  defaultLocalRate: string;
  defaults?: PurchaseFormDefaults;
  /** Hidden for users who may raise a contract but not approve it. */
  canApprove?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [confirmApprove, setConfirmApprove] = React.useState(false);

  const [header, setHeader] = React.useState({
    contractReference: defaults?.contractReference ?? '',
    supplierContractNo: defaults?.supplierContractNo ?? '',
    contractDate: defaults?.contractDate ?? new Date().toISOString().slice(0, 10),
    vendorId: defaults?.vendorId ?? '',
    origin: defaults?.origin ?? '',
    currency: defaults?.currency ?? 'USD',
    rateToUsd: defaults?.rateToUsd ?? '1',
    rateLocalPerUsd: defaults?.rateLocalPerUsd ?? defaultLocalRate,
    freightAmount: defaults?.freightAmount ?? '0',
    otherCharges: defaults?.otherCharges ?? '0',
    incoterm: defaults?.incoterm ?? 'FOB',
    portOfLoading: defaults?.portOfLoading ?? '',
    destination: defaults?.destination ?? '',
    expectedShipmentDate: defaults?.expectedShipmentDate ?? '',
    paymentTermDays: defaults?.paymentTermDays ?? '60',
    notes: defaults?.notes ?? '',
  });

  const [lines, setLines] = React.useState<LineDraft[]>(() =>
    defaults?.lines?.length
      ? defaults.lines.map((line) => ({ ...line, notes: line.notes ?? '', key: crypto.randomUUID() }))
      : [emptyLine()],
  );

  function setField<K extends keyof typeof header>(key: K, value: string) {
    setHeader((prev) => {
      // USD needs no conversion; locking the rate avoids a meaningless field.
      if (key === 'currency' && value === 'USD') return { ...prev, currency: value, rateToUsd: '1' };
      return { ...prev, [key]: value };
    });
  }

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function chooseItem(key: string, itemId: string | null) {
    const item = items.find((i) => i.value === itemId);
    updateLine(key, {
      itemId: itemId ?? '',
      bagWeightKg: item?.bagWeightKg ?? '60',
      unit: (item?.defaultUnit as LineDraft['unit']) ?? 'KG',
    });
  }

  const totals = React.useMemo(
    () =>
      computePurchaseTotalsClient({
        lines,
        freightAmount: header.freightAmount,
        otherCharges: header.otherCharges,
        rateToUsd: header.rateToUsd,
        currency: header.currency,
      }),
    [lines, header.freightAmount, header.otherCharges, header.rateToUsd, header.currency],
  );

  function buildPayload() {
    return JSON.stringify({
      ...header,
      paymentTermDays: header.paymentTermDays || '0',
      freightAmount: header.freightAmount || '0',
      otherCharges: header.otherCharges || '0',
      lines: lines.map((line) => ({
        itemId: line.itemId,
        lotNumber: line.lotNumber,
        batchNumber: line.batchNumber,
        containerNumber: line.containerNumber,
        containerType: line.containerType,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        ...(line.bags ? { bags: Number(line.bags) } : {}),
        bagWeightKg: line.bagWeightKg,
        notes: line.notes,
      })),
    });
  }

  function save(thenApprove: boolean) {
    setError(null);
    setErrors({});

    startTransition(async () => {
      const result = await savePurchaseContractAction(defaults?.id ?? null, buildPayload());

      if (!result?.ok) {
        setError(result?.error ?? 'The contract could not be saved.');
        setErrors(result && !result.ok ? (result.errors ?? {}) : {});
        return;
      }

      if (!thenApprove) {
        toast.success(result.message);
        router.push(`/purchases/${result.id}`);
        router.refresh();
        return;
      }

      const posted = await postPurchaseContractAction(result.id);
      if (!posted.ok) {
        toast.error(posted.error);
        router.push(`/purchases/${result.id}`);
        router.refresh();
        return;
      }

      toast.success('Contract approved. The job, lots and batches have been created.');
      router.push(`/purchases/${result.id}`);
      router.refresh();
    });
  }

  const lineError = (index: number, field: string) => errors[`lines.${index}.${field}`];

  return (
    <div className="space-y-6">
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <Card>
        <CardContent className="space-y-6 pt-5">
          <FormSection title="Contract" description="Who we are buying from, and on what terms.">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Contract reference" htmlFor="contractReference" required error={errors.contractReference} hint="Your own reference. Must be unique.">
                <Input
                  autoFocus
                  id="contractReference"
                  value={header.contractReference}
                  onChange={(e) => setField('contractReference', e.target.value)}
                  placeholder="FID-CTR-1001"
                />
              </Field>

              <Field label="Supplier contract no." htmlFor="supplierContractNo" hint="The seller's own contract number.">
                <Input
                  id="supplierContractNo"
                  value={header.supplierContractNo}
                  onChange={(e) => setField('supplierContractNo', e.target.value)}
                />
              </Field>

              <Field label="Contract date" htmlFor="contractDate" required error={errors.contractDate}>
                <Input
                  id="contractDate"
                  type="date"
                  value={header.contractDate}
                  onChange={(e) => setField('contractDate', e.target.value)}
                />
              </Field>

              <Field label="Supplier" htmlFor="vendorId" required error={errors.vendorId}>
                <Combobox
                  id="vendorId"
                  options={vendors}
                  value={header.vendorId || null}
                  onChange={(v) => setField('vendorId', v ?? '')}
                  placeholder="Choose a supplier…"
                />
              </Field>

              <Field label="Origin" htmlFor="origin" hint="Where the coffee is shipped from.">
                <Input
                  id="origin"
                  value={header.origin}
                  onChange={(e) => setField('origin', e.target.value)}
                  placeholder="Santos, Brazil"
                />
              </Field>

              <Field label="Payment terms (days)" htmlFor="paymentTermDays">
                <Input
                  id="paymentTermDays"
                  inputMode="numeric"
                  className="tnum text-right"
                  value={header.paymentTermDays}
                  onChange={(e) => setField('paymentTermDays', e.target.value)}
                />
              </Field>
            </div>
          </FormSection>

          <FormSection title="Currency" description="The rate is stored on the contract and never restated later.">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Contract currency" htmlFor="currency" required>
                <Select id="currency" value={header.currency} onChange={(e) => setField('currency', e.target.value)}>
                  <option value="USD">USD — US Dollar</option>
                  <option value="AED">AED — UAE Dirham</option>
                  <option value="MAD">MAD — Moroccan Dirham</option>
                </Select>
              </Field>

              <Field
                label="Exchange rate"
                htmlFor="rateToUsd"
                required
                error={errors.rateToUsd}
                hint={header.currency === 'USD' ? 'Fixed at 1 for USD.' : `${header.currency} per 1 USD.`}
              >
                <Input
                  id="rateToUsd"
                  inputMode="decimal"
                  className="tnum text-right"
                  value={header.rateToUsd}
                  disabled={header.currency === 'USD'}
                  onChange={(e) => setField('rateToUsd', e.target.value)}
                />
              </Field>

              <Field
                label={`Local rate (${localCurrency} per USD)`}
                htmlFor="rateLocalPerUsd"
                required
                error={errors.rateLocalPerUsd}
                hint="Used for this company's own reporting."
              >
                <Input
                  id="rateLocalPerUsd"
                  inputMode="decimal"
                  className="tnum text-right"
                  value={header.rateLocalPerUsd}
                  onChange={(e) => setField('rateLocalPerUsd', e.target.value)}
                />
              </Field>
            </div>
          </FormSection>

          <FormSection title="Shipping terms">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Incoterm" htmlFor="incoterm">
                <Select id="incoterm" value={header.incoterm} onChange={(e) => setField('incoterm', e.target.value)}>
                  {Object.entries(INCOTERM_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Port of loading" htmlFor="portOfLoading">
                <Input id="portOfLoading" value={header.portOfLoading} onChange={(e) => setField('portOfLoading', e.target.value)} placeholder="Santos" />
              </Field>
              <Field label="Destination" htmlFor="destination">
                <Input id="destination" value={header.destination} onChange={(e) => setField('destination', e.target.value)} placeholder="Jebel Ali" />
              </Field>
              <Field label="Expected shipment" htmlFor="expectedShipmentDate">
                <Input
                  id="expectedShipmentDate"
                  type="date"
                  value={header.expectedShipmentDate}
                  onChange={(e) => setField('expectedShipmentDate', e.target.value)}
                />
              </Field>
            </div>
          </FormSection>
        </CardContent>
      </Card>

      {/* --- Lines ------------------------------------------------------- */}
      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">Coffee lines</h3>
              <p className="mt-0.5 text-xs text-ink-muted">
                One line per lot/batch. Add a container number to track it separately through the shipment.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLines((prev) => [...prev, emptyLine(prev.at(-1)?.bagWeightKg ?? '60')])}
            >
              <Plus />
              Add line
            </Button>
          </div>

          {errors.lines ? <p className="text-xs font-medium text-red-600">{errors.lines}</p> : null}

          <div className="space-y-4">
            {lines.map((line, index) => {
              const math = totals.lines[index];
              return (
                <div key={line.key} className="rounded-xl border border-line bg-forest-50/30 p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
                      Line {index + 1}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Duplicate line"
                        onClick={() =>
                          setLines((prev) => {
                            const copy = { ...line, key: crypto.randomUUID(), batchNumber: '', containerNumber: '' };
                            const next = [...prev];
                            next.splice(index + 1, 0, copy);
                            return next;
                          })
                        }
                      >
                        <Copy />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove line"
                        disabled={lines.length === 1}
                        onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="Coffee" required error={lineError(index, 'itemId')} className="lg:col-span-2">
                      <Combobox
                        options={items}
                        value={line.itemId || null}
                        onChange={(v) => chooseItem(line.key, v)}
                        placeholder="Choose a coffee…"
                      />
                    </Field>

                    <Field label="Lot number" required error={lineError(index, 'lotNumber')}>
                      <Input
                        value={line.lotNumber}
                        onChange={(e) => updateLine(line.key, { lotNumber: e.target.value })}
                        placeholder="BR-001"
                      />
                    </Field>

                    <Field label="Batch number" required error={lineError(index, 'batchNumber')}>
                      <Input
                        value={line.batchNumber}
                        onChange={(e) => updateLine(line.key, { batchNumber: e.target.value })}
                        placeholder="B001"
                      />
                    </Field>

                    <Field label="Container number">
                      <Input
                        value={line.containerNumber}
                        onChange={(e) => updateLine(line.key, { containerNumber: e.target.value })}
                        placeholder="MSCU1000001"
                      />
                    </Field>

                    <Field label="Container type">
                      <Select
                        value={line.containerType}
                        onChange={(e) => updateLine(line.key, { containerType: e.target.value as LineDraft['containerType'] })}
                      >
                        {Object.entries(CONTAINER_TYPE_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field label="Quantity" required error={lineError(index, 'quantity')}>
                      <QuantityInput
                        unit={line.unit}
                        value={line.quantity}
                        onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                        placeholder="19200"
                      />
                    </Field>

                    <Field label="Unit">
                      <Select
                        value={line.unit}
                        onChange={(e) => updateLine(line.key, { unit: e.target.value as LineDraft['unit'] })}
                      >
                        <option value="KG">KG</option>
                        <option value="MT">MT</option>
                        <option value="BAG">Bags</option>
                      </Select>
                    </Field>

                    <Field label={`Price per ${line.unit === 'BAG' ? 'bag' : line.unit}`} required error={lineError(index, 'unitPrice')}>
                      <MoneyInput
                        currency={header.currency}
                        value={line.unitPrice}
                        onChange={(e) => updateLine(line.key, { unitPrice: e.target.value })}
                        placeholder="4.50"
                      />
                    </Field>

                    <Field label="Bags" hint="Left blank, derived from bag weight.">
                      <QuantityInput
                        value={line.bags}
                        onChange={(e) => updateLine(line.key, { bags: e.target.value })}
                        placeholder={math ? String(math.bags) : '320'}
                      />
                    </Field>

                    <Field label="Bag weight (KG)">
                      <QuantityInput
                        unit="KG"
                        value={line.bagWeightKg}
                        onChange={(e) => updateLine(line.key, { bagWeightKg: e.target.value })}
                      />
                    </Field>
                  </div>

                  {math && math.quantityKg > 0 ? (
                    <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-4">
                      <div>
                        <dt className="text-[11px] text-ink-subtle">Quantity</dt>
                        <dd className="tnum text-sm font-medium">{math.quantityKg.toLocaleString()} KG</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-ink-subtle">Goods value</dt>
                        <dd className="tnum text-sm font-medium">
                          {header.currency} {math.lineSubtotal.toLocaleString()}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-ink-subtle">Freight + charges</dt>
                        <dd className="tnum text-sm font-medium">
                          {header.currency} {math.allocated.toLocaleString()}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-ink-subtle">Landed cost / KG</dt>
                        <dd className="tnum text-sm font-semibold text-gold-700">
                          {header.currency} {math.unitCostKg}
                        </dd>
                      </div>
                    </dl>
                  ) : null}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* --- Charges and totals ------------------------------------------- */}
      <Card>
        <CardContent className="space-y-4 pt-5">
          <FormSection
            title="Freight and direct charges"
            description="Spread across the lines by value and folded into the cost per kilogram, so they reach profit through cost of goods sold exactly once."
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Freight" htmlFor="freightAmount" error={errors.freightAmount}>
                <MoneyInput
                  id="freightAmount"
                  currency={header.currency}
                  value={header.freightAmount}
                  onChange={(e) => setField('freightAmount', e.target.value)}
                />
              </Field>
              <Field label="Other direct charges" htmlFor="otherCharges" error={errors.otherCharges}>
                <MoneyInput
                  id="otherCharges"
                  currency={header.currency}
                  value={header.otherCharges}
                  onChange={(e) => setField('otherCharges', e.target.value)}
                />
              </Field>
            </div>
          </FormSection>

          <div className="rounded-xl border border-line bg-forest-50/40 p-4">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ['Total quantity', `${totals.totalQuantityKg.toLocaleString()} KG`],
                ['Total bags', totals.totalBags.toLocaleString()],
                ['Containers', String(totals.totalContainers)],
                ['Goods value', `${header.currency} ${totals.subtotal.toLocaleString()}`],
                ['Contract value', `${header.currency} ${totals.totalValue.toLocaleString()}`],
                ['In USD', `USD ${totals.totalValueUsd.toLocaleString()}`],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[11px] text-ink-subtle">{label}</dt>
                  <dd className="tnum mt-0.5 text-sm font-semibold text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <Field label="Notes" htmlFor="notes">
            <Textarea id="notes" value={header.notes} onChange={(e) => setField('notes', e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Callout tone="info" title="What approving does">
        Approving posts the supplier payable, opens a job, and creates the lots, containers and batches — but it does
        not put coffee in a warehouse. Record a goods receipt when the containers actually arrive.
      </Callout>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button variant="subtle" onClick={() => save(false)} loading={pending}>
          Save as draft
        </Button>
        {canApprove ? (
          <Button variant="accent" onClick={() => setConfirmApprove(true)} disabled={pending}>
            Save and approve
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmApprove}
        onOpenChange={setConfirmApprove}
        title="Approve this contract?"
        description="This posts the supplier payable, opens the job and creates the lots and batches. A posted contract can only be corrected by reversing it."
        confirmLabel="Approve and post"
        variant="accent"
        onConfirm={() => save(true)}
      />
    </div>
  );
}
