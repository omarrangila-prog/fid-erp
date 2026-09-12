'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field, FieldGroup } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { createStockCountAction } from '@/server/actions/compliance-actions';

export function StockCountForm({
  warehouses,
}: {
  warehouses: Array<{ id: string; name: string; batchCount: number; openCountNumber: string | null }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const [warehouseId, setWarehouseId] = React.useState(warehouses.find((w) => !w.openCountNumber)?.id ?? '');
  const [countDate, setCountDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = React.useState('');

  const chosen = warehouses.find((w) => w.id === warehouseId) ?? null;
  const available = warehouses.filter((w) => !w.openCountNumber);

  /**
   * The button stays live and the refusal is written down.
   *
   * It used to be disabled whenever no warehouse was chosen — which is every
   * warehouse already counting, or simply a fresh form. A dead button explains
   * nothing: the user presses it, nothing happens, and there is nowhere to
   * read why. The check below did exist, but sat behind a button that could
   * never be pressed to reach it.
   */
  function submit() {
    setError(null);

    if (!warehouseId) {
      setError(
        available.length === 0
          ? 'Every warehouse already has a count open. Finish or cancel the open sheet before starting another.'
          : 'Choose the warehouse being counted.',
      );
      return;
    }

    if (chosen && chosen.batchCount === 0) {
      setError(`${chosen.name} has no stock recorded against it, so there is nothing to count.`);
      return;
    }

    startTransition(async () => {
      const result = await createStockCountAction(JSON.stringify({ warehouseId, countDate, notes }));
      if (result?.ok) {
        toast.success(result.message);
        router.push(`/inventory/stock-counts/${result.id}`);
        router.refresh();
      } else {
        setError(result?.error ?? 'The count could not be opened.');
      }
    });
  }

  return (
    <div className="space-y-6">
      {error ? (
        <Callout tone="danger" title="This count could not be opened">
          {error}
        </Callout>
      ) : null}

      {available.length === 0 && warehouses.length > 0 ? (
        <Callout tone="warning" title="Every warehouse already has a count open">
          A warehouse can only be counted once at a time, so the figures cannot move underneath the sheet. Finish
          or cancel the open count before starting another.
        </Callout>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Open a count sheet</CardTitle>
          <CardDescription>
            Every batch currently recorded in the warehouse goes onto the sheet with its system quantity frozen.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FieldGroup>
            <Field label="Warehouse" required>
              <Select autoFocus value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}>
                <option value="">Choose…</option>
                {warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id} disabled={Boolean(warehouse.openCountNumber)}>
                    {warehouse.name}
                    {warehouse.openCountNumber
                      ? ` — ${warehouse.openCountNumber} still open`
                      : ` — ${warehouse.batchCount} batch${warehouse.batchCount === 1 ? '' : 'es'}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Count date" required hint="The date the shelves were actually walked.">
              <Input type="date" value={countDate} onChange={(event) => setCountDate(event.target.value)} />
            </Field>
          </FieldGroup>

          {chosen && chosen.batchCount === 0 ? (
            <Callout tone="warning" title="Nothing to count">
              {chosen.name} has no stock recorded against it, so there is nothing to verify.
            </Callout>
          ) : null}

          <Field label="Notes" hint="Who is counting, which aisles, anything the reviewer should know.">
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} maxLength={600} />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button onClick={submit} loading={pending}>
              Open count sheet
            </Button>
            <Button variant="ghost" onClick={() => router.push('/inventory/stock-counts')}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
