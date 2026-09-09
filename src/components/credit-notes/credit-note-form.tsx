'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Trash2, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea, MoneyInput, QuantityInput } from '@/components/ui/input';
import { Field, FieldGroup } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Callout } from '@/components/ui/feedback';
import { dec, toMoney, sum, Decimal } from '@/lib/money';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import { saveCreditNoteAction } from '@/server/actions/compliance-actions';

export type CreditParty = { id: string; name: string; currency: string };
export type CreditDocument = {
  id: string;
  number: string;
  partyId: string;
  currency: string;
  totalLabel: string;
  headroomLabel: string;
};
export type CreditStock = {
  batchId: string;
  warehouseId: string;
  batchNumber: string;
  itemName: string;
  soldKg: string;
  landedUnitCostUsd: string;
};
export type CreditTaxCode = { id: string; code: string; name: string; ratePct: string };

type LineState = {
  key: string;
  description: string;
  mode: 'VALUE' | 'STOCK';
  batchId: string | null;
  warehouseId: string;
  quantityKg: string;
  unitPrice: string;
  amount: string;
  taxCodeId: string;
};

const newLine = (taxCodeId: string): LineState => ({
  key: Math.random().toString(36).slice(2),
  description: '',
  mode: 'VALUE',
  batchId: null,
  warehouseId: '',
  quantityKg: '',
  unitPrice: '',
  amount: '',
  taxCodeId,
});

/**
 * Raising a credit note.
 *
 * The form asks, per line, whether coffee is physically coming back or whether
 * this is a pure allowance. That distinction is the one that matters: a value
 * credit only moves money, while a stock credit also puts kilograms back in a
 * warehouse and takes the cost of them back out of cost of sales.
 */
export function CreditNoteForm({
  type,
  parties,
  documents,
  stock,
  warehouses,
  taxCodes,
  taxLabel,
  taxEnabled,
  localCurrency,
  defaultRateLocalPerUsd,
  basePath,
}: {
  type: 'CUSTOMER' | 'VENDOR';
  parties: CreditParty[];
  documents: CreditDocument[];
  stock: CreditStock[];
  warehouses: Array<{ id: string; name: string }>;
  taxCodes: CreditTaxCode[];
  taxLabel: string;
  taxEnabled: boolean;
  localCurrency: string;
  defaultRateLocalPerUsd: string;
  basePath: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const defaultTaxCode = taxCodes[0]?.id ?? '';
  const [partyId, setPartyId] = React.useState<string | null>(parties[0]?.id ?? null);
  const [documentId, setDocumentId] = React.useState<string | null>(null);
  const [creditDate, setCreditDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = React.useState(parties[0]?.currency ?? 'USD');
  const [rateToUsd, setRateToUsd] = React.useState('1');
  const [rateLocalPerUsd, setRateLocalPerUsd] = React.useState(defaultRateLocalPerUsd);
  const [reason, setReason] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [lines, setLines] = React.useState<LineState[]>([newLine(defaultTaxCode)]);

  const partyDocuments = documents.filter((d) => d.partyId === partyId);

  function choosePartyId(next: string | null) {
    setPartyId(next);
    setDocumentId(null);
    const chosen = parties.find((p) => p.id === next);
    if (chosen) {
      setCurrency(chosen.currency);
      if (chosen.currency === 'USD') setRateToUsd('1');
    }
  }

  function setLine(key: string, patch: Partial<LineState>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  const rateFor = (id: string) => dec(taxCodes.find((c) => c.id === id)?.ratePct ?? 0);

  const computed = lines.map((line) => {
    const net =
      line.mode === 'STOCK'
        ? toMoney(dec(line.quantityKg || 0).times(dec(line.unitPrice || 0)))
        : toMoney(dec(line.amount || 0));
    const rate = taxEnabled ? rateFor(line.taxCodeId) : new Decimal(0);
    const tax = rate.isZero() ? new Decimal(0) : toMoney(net.times(rate).dividedBy(100));
    const source = line.batchId ? stock.find((s) => s.batchId === line.batchId) : null;
    const overReturn = Boolean(source && dec(line.quantityKg || 0).greaterThan(dec(source.soldKg)));
    return { line, net, tax, total: toMoney(net.plus(tax)), source, overReturn };
  });

  const subtotal = toMoney(sum(computed.map((c) => c.net)));
  const taxTotal = toMoney(sum(computed.map((c) => c.tax)));
  const grandTotal = toMoney(subtotal.plus(taxTotal));

  const chosenDocument = documents.find((d) => d.id === documentId) ?? null;
  const hasOverReturn = computed.some((c) => c.overReturn);

  function submit() {
    setError(null);

    if (!partyId) {
      setError(type === 'CUSTOMER' ? 'Choose the customer this credit belongs to.' : 'Choose the supplier.');
      return;
    }
    if (!reason.trim()) {
      setError('State why the credit is being raised. It appears on the document and in the audit trail.');
      return;
    }
    if (hasOverReturn) {
      setError('One or more lines return more coffee than the batch has ever sold.');
      return;
    }

    const payload = {
      type,
      creditDate,
      customerId: type === 'CUSTOMER' ? partyId : '',
      vendorId: type === 'VENDOR' ? partyId : '',
      salesInvoiceId: type === 'CUSTOMER' ? (documentId ?? '') : '',
      purchaseContractId: type === 'VENDOR' ? (documentId ?? '') : '',
      currency,
      rateToUsd,
      rateLocalPerUsd,
      reason,
      reference,
      notes,
      lines: computed
        .filter((c) => c.net.greaterThan(0))
        .map((c) => ({
          description: c.line.description || reason,
          batchId: c.line.mode === 'STOCK' ? (c.line.batchId ?? '') : '',
          warehouseId: c.line.mode === 'STOCK' ? c.line.warehouseId : '',
          quantityKg: c.line.mode === 'STOCK' ? c.line.quantityKg : '',
          unitPrice: c.line.mode === 'STOCK' ? c.line.unitPrice : '',
          amount: c.line.mode === 'VALUE' ? c.line.amount : '',
          taxCodeId: taxEnabled ? c.line.taxCodeId : '',
        })),
    };

    if (payload.lines.length === 0) {
      setError('Add at least one line with a value.');
      return;
    }

    startTransition(async () => {
      const result = await saveCreditNoteAction(JSON.stringify(payload));
      if (result?.ok) {
        toast.success(result.message);
        router.push(`${basePath}/${result.id}`);
        router.refresh();
      } else {
        setError(result?.error ?? 'The note could not be saved.');
      }
    });
  }

  const partyLabel = type === 'CUSTOMER' ? 'Customer' : 'Supplier';
  const documentLabel = type === 'CUSTOMER' ? 'Against invoice' : 'Against contract';

  return (
    <div className="space-y-6">
      {error ? (
        <Callout tone="danger" title="This could not be saved">
          {error}
        </Callout>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Who and why</CardTitle>
          <CardDescription>
            Linking the note to a document caps it at what that document still has left to credit.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FieldGroup>
            <Field label={partyLabel} required>
              <Combobox
                autoFocus
                options={parties.map((p) => ({ value: p.id, label: p.name, hint: p.currency }))}
                value={partyId}
                onChange={choosePartyId}
                placeholder={`Choose a ${partyLabel.toLowerCase()}…`}
              />
            </Field>
            <Field label="Credit date" required>
              <Input type="date" value={creditDate} onChange={(e) => setCreditDate(e.target.value)} />
            </Field>
          </FieldGroup>

          <FieldGroup>
            <Field
              label={documentLabel}
              hint={
                chosenDocument
                  ? `${chosenDocument.headroomLabel} still available to credit`
                  : 'Optional. Leave blank for a standalone credit.'
              }
            >
              <Combobox
                options={partyDocuments.map((d) => ({
                  value: d.id,
                  label: d.number,
                  hint: `${d.totalLabel} · ${d.headroomLabel} left`,
                }))}
                value={documentId}
                onChange={setDocumentId}
                placeholder="None"
              />
            </Field>
            <Field label="Your reference" hint="A supplier credit number, an email, a claim reference.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
            </Field>
          </FieldGroup>

          <Field label="Reason" required hint="Short-shipment, quality claim, price adjustment, goods returned.">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} />
          </Field>

          <FieldGroup className="sm:grid-cols-3">
            <Field label="Currency" required>
              <Select
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value);
                  if (e.target.value === 'USD') setRateToUsd('1');
                }}
              >
                {['USD', 'AED', 'MAD'].map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Rate to USD" required hint={`Units of ${currency} per 1 USD.`}>
              <Input
                value={rateToUsd}
                onChange={(e) => setRateToUsd(e.target.value)}
                inputMode="decimal"
                disabled={currency === 'USD'}
              />
            </Field>
            <Field label={`Rate to ${localCurrency}`} required hint={`Units of ${localCurrency} per 1 USD.`}>
              <Input value={rateLocalPerUsd} onChange={(e) => setRateLocalPerUsd(e.target.value)} inputMode="decimal" />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
          <CardDescription>
            A value line moves money only. A stock line also puts coffee back in a warehouse and takes its cost back
            out of cost of sales.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {computed.map(({ line, net, tax, total, source, overReturn }, index) => (
            <div key={line.key} className="rounded-lg border border-line bg-canvas p-3 sm:p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-ink-muted">Line {index + 1}</span>
                {lines.length > 1 ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove line ${index + 1}`}
                    onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                  >
                    <Trash2 className="text-red-500" />
                  </Button>
                ) : null}
              </div>

              <div className="space-y-3">
                <FieldGroup>
                  <Field label="Description" required>
                    <Input
                      value={line.description}
                      onChange={(e) => setLine(line.key, { description: e.target.value })}
                      placeholder="Quality allowance on lot 24-118"
                      maxLength={300}
                    />
                  </Field>
                  <Field label="What is being credited">
                    <Select
                      value={line.mode}
                      onChange={(e) =>
                        setLine(line.key, { mode: e.target.value as LineState['mode'], batchId: null })
                      }
                    >
                      <option value="VALUE">Value only — no coffee moves</option>
                      <option value="STOCK">Coffee comes back into a warehouse</option>
                    </Select>
                  </Field>
                </FieldGroup>

                {line.mode === 'STOCK' ? (
                  <FieldGroup className="sm:grid-cols-4">
                    <Field label="Batch" required className="sm:col-span-2">
                      <Combobox
                        options={stock.map((s) => ({
                          value: s.batchId,
                          label: `${s.batchNumber} · ${s.itemName}`,
                          hint: `${formatQuantityKg(s.soldKg)} sold`,
                          keywords: s.itemName,
                        }))}
                        value={line.batchId}
                        onChange={(value) => setLine(line.key, { batchId: value })}
                        placeholder="Choose the batch being returned…"
                        aria-label={`Batch on line ${index + 1}`}
                      />
                    </Field>
                    <Field label="Back into" required>
                      <Select
                        value={line.warehouseId}
                        onChange={(e) => setLine(line.key, { warehouseId: e.target.value })}
                        aria-label={`Warehouse on line ${index + 1}`}
                      >
                        <option value="">Choose…</option>
                        {warehouses.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Quantity (KG)" required error={overReturn ? 'More than was ever sold' : undefined}>
                      <QuantityInput
                        value={line.quantityKg}
                        onChange={(e) => setLine(line.key, { quantityKg: e.target.value })}
                        aria-label={`Quantity on line ${index + 1}`}
                      />
                    </Field>
                  </FieldGroup>
                ) : null}

                <FieldGroup className={taxEnabled ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}>
                  {line.mode === 'STOCK' ? (
                    <Field label="Price per KG" required>
                      <MoneyInput
                        value={line.unitPrice}
                        onChange={(e) => setLine(line.key, { unitPrice: e.target.value })}
                        aria-label={`Price on line ${index + 1}`}
                      />
                    </Field>
                  ) : (
                    <Field label={`Amount (${currency})`} required>
                      <MoneyInput
                        value={line.amount}
                        onChange={(e) => setLine(line.key, { amount: e.target.value })}
                        aria-label={`Amount on line ${index + 1}`}
                      />
                    </Field>
                  )}

                  {taxEnabled ? (
                    <Field label={taxLabel}>
                      <Select
                        value={line.taxCodeId}
                        onChange={(e) => setLine(line.key, { taxCodeId: e.target.value })}
                        aria-label={`${taxLabel} code on line ${index + 1}`}
                      >
                        {taxCodes.map((code) => (
                          <option key={code.id} value={code.id}>
                            {code.code} — {code.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : null}

                  <Field label="Line total">
                    <output className="flex h-9 items-center rounded-md border border-line bg-surface px-3 text-sm font-medium tabular-nums">
                      {formatMoney(total, currency)}
                    </output>
                  </Field>
                </FieldGroup>

                {taxEnabled && tax.greaterThan(0) ? (
                  <p className="text-xs text-ink-subtle">
                    {formatMoney(net, currency)} net + {formatMoney(tax, currency)} {taxLabel}
                  </p>
                ) : null}
                {source ? (
                  <p className="text-xs text-ink-subtle">
                    Coffee returns at its landed cost of USD {dec(source.landedUnitCostUsd).toFixed(4)}/KG, which comes
                    back out of cost of sales.
                  </p>
                ) : null}
              </div>
            </div>
          ))}

          <Button variant="outline" onClick={() => setLines((prev) => [...prev, newLine(defaultTaxCode)])}>
            <Plus />
            Add line
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-muted">Net</dt>
              <dd className="tabular-nums">{formatMoney(subtotal, currency)}</dd>
            </div>
            {taxEnabled ? (
              <div className="flex justify-between">
                <dt className="text-ink-muted">{taxLabel}</dt>
                <dd className="tabular-nums">{formatMoney(taxTotal, currency)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-line pt-1.5 text-base font-semibold">
              <dt>Total credit</dt>
              <dd className="tabular-nums">{formatMoney(grandTotal, currency)}</dd>
            </div>
          </dl>

          {chosenDocument ? (
            <p className="flex items-start gap-1.5 text-xs text-ink-subtle">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              {chosenDocument.number} has {chosenDocument.headroomLabel} left to credit. A note above that will be
              refused.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={submit} loading={pending}>
              Save as draft
            </Button>
            <Button variant="ghost" onClick={() => router.push(basePath)}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-ink-subtle">
            Saving does not post anything. You review the draft and post it as a separate step.
          </p>

          <Field label="Notes" className="pt-2">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} />
          </Field>
        </CardContent>
      </Card>
    </div>
  );
}
