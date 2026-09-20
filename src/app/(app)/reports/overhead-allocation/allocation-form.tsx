'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { allocateOverheadsAction } from '@/server/actions/finance-actions';

type Candidate = { shipmentId: string; label: string; itemName: string; receivedKg: string; salesUsd: string };

const BASES = [
  { value: 'QUANTITY', label: 'By weight — each shipment takes its share by kilograms' },
  { value: 'SALES_VALUE', label: 'By sales value — the shipments that sold more take more' },
  { value: 'EQUAL', label: 'Equally — the same amount to each shipment chosen' },
  { value: 'PERCENTAGE', label: 'By percentage — you say what each takes' },
] as const;

/** Choose the period, the basis and the shipments. Nothing is posted. */
export function OverheadAllocationForm({
  from,
  to,
  totalUsd,
  candidates,
  canAllocate,
}: {
  from: string;
  to: string;
  totalUsd: string;
  candidates: Candidate[];
  canAllocate: boolean;
}) {
  const router = useRouter();
  const [basis, setBasis] = React.useState<(typeof BASES)[number]['value']>('QUANTITY');
  const [chosen, setChosen] = React.useState<Set<string>>(() => new Set(candidates.map((c) => c.shipmentId)));
  const [percentages, setPercentages] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    setError(null);
    if (chosen.size === 0) return setError('Choose at least one shipment.');
    setBusy(true);
    const result = await allocateOverheadsAction(
      JSON.stringify({
        from,
        to,
        basis,
        notes: notes.trim() || undefined,
        shipments: [...chosen].map((shipmentId) => ({
          shipmentId,
          percentage: basis === 'PERCENTAGE' ? (percentages[shipmentId] ?? '0') : undefined,
        })),
      }),
    );
    setBusy(false);
    if (!result.ok) return setError(result.error);
    toast.success(`${totalUsd} of overheads shared across ${result.data.shipments} shipments, for reporting only.`);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Share {totalUsd} across shipments</CardTitle>
        <CardDescription>
          Choose how the period&rsquo;s overheads should be spread. The result appears on shipment profitability as a
          clearly-marked management figure; the accounts do not change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Basis" htmlFor="basis" required>
            <Select id="basis" value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
              {BASES.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Period" htmlFor="period" hint="Change it with the dates in the address bar.">
            <Input id="period" readOnly value={`${from} to ${to}`} />
          </Field>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">Shipments</p>
          {candidates.map((candidate) => (
            <div key={candidate.shipmentId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3">
              <label className="flex min-w-0 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-gold-600"
                  checked={chosen.has(candidate.shipmentId)}
                  onChange={() => toggle(candidate.shipmentId)}
                  aria-label={`Include ${candidate.label}`}
                />
                <span>
                  <span className="block font-medium">{candidate.label}</span>
                  <span className="tnum block text-xs text-ink-muted">
                    {candidate.itemName} · {Number(candidate.receivedKg).toLocaleString()} KG received · sales USD{' '}
                    {Number(candidate.salesUsd).toLocaleString()}
                  </span>
                </span>
              </label>
              {basis === 'PERCENTAGE' && chosen.has(candidate.shipmentId) ? (
                <Input
                  aria-label={`Percentage for ${candidate.label}`}
                  className="tnum h-9 w-24 text-right"
                  inputMode="decimal"
                  placeholder="%"
                  value={percentages[candidate.shipmentId] ?? ''}
                  onChange={(e) => setPercentages((prev) => ({ ...prev, [candidate.shipmentId]: e.target.value }))}
                />
              ) : null}
            </div>
          ))}
        </div>

        <Field label="Notes" htmlFor="allocNotes" hint="Why this basis, for whoever reads the report later.">
          <Textarea id="allocNotes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}

        <div className="flex justify-end">
          <Button onClick={submit} loading={busy} disabled={!canAllocate}>
            <Scale />
            Allocate for reporting
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
