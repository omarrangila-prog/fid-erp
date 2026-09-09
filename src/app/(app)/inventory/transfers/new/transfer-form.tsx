'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Trash2, AlertCircle, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { dec, sum } from '@/lib/money';
import { formatQuantityKg } from '@/lib/format';
import { saveStockTransferAction } from '@/server/actions/trading-actions';

export type TransferStock = {
  batchId: string;
  warehouseId: string;
  batchNumber: string;
  lotNumber: string;
  itemName: string;
  availableKg: string;
};

type LineState = { key: string; batchId: string | null; quantityKg: string };

const newLine = (): LineState => ({ key: Math.random().toString(36).slice(2), batchId: null, quantityKg: '' });

export function TransferForm({
  warehouses,
  stock,
}: {
  warehouses: Array<{ id: string; name: string }>;
  stock: TransferStock[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const [fromWarehouseId, setFrom] = React.useState(warehouses[0]?.id ?? '');
  const [toWarehouseId, setTo] = React.useState(warehouses[1]?.id ?? '');
  const [transferDate, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = React.useState('');
  const [lines, setLines] = React.useState<LineState[]>([newLine()]);

  // Only stock actually sitting in the chosen source warehouse can move.
  const sourceStock = React.useMemo(
    () => stock.filter((s) => s.warehouseId === fromWarehouseId && Number(s.availableKg) > 0),
    [stock, fromWarehouseId],
  );

  const options = sourceStock.map((s) => ({
    value: s.batchId,
    label: `${s.batchNumber} · ${s.itemName}`,
    hint: `Lot ${s.lotNumber} · ${formatQuantityKg(s.availableKg)} available`,
    keywords: `${s.lotNumber} ${s.itemName}`,
  }));

  /**
   * Changing the source warehouse invalidates every batch already chosen, since
   * those batches live in the old warehouse. Doing it here rather than in an
   * effect keeps it to a single render.
   */
  function changeSourceWarehouse(next: string) {
    setFrom(next);
    setLines((prev) => prev.map((l) => ({ ...l, batchId: null })));
  }

  function setLine(key: string, patch: Partial<LineState>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  const rows = lines.map((line) => {
    const option = line.batchId ? sourceStock.find((s) => s.batchId === line.batchId) : null;
    const quantity = line.quantityKg ? dec(line.quantityKg) : dec(0);
    const over = Boolean(option && quantity.greaterThan(dec(option.availableKg)));
    return { line, option, quantity, over };
  });

  const totalKg = sum(rows.map((r) => r.quantity));
  const hasOverdraw = rows.some((r) => r.over);
  const sameWarehouse = fromWarehouseId === toWarehouseId;

  function submit() {
    setError(null);
    if (sameWarehouse) {
      setError('The source and destination warehouses must be different.');
      return;
    }
    if (hasOverdraw) {
      setError('One or more lines exceed the stock available in the source warehouse.');
      return;
    }

    const payload = {
      transferDate,
      fromWarehouseId,
      toWarehouseId,
      notes,
      lines: rows
        .filter((r) => r.option && r.quantity.greaterThan(0))
        .map((r) => ({ batchId: r.option!.batchId, quantityKg: r.line.quantityKg, notes: '' })),
    };

    if (payload.lines.length === 0) {
      setError('Add at least one batch to transfer.');
      return;
    }

    startTransition(async () => {
      const result = await saveStockTransferAction(JSON.stringify(payload));
      if (result?.ok) {
        toast.success('Transfer created. Approve it to reserve the stock.');
        router.push('/inventory/transfers');
        router.refresh();
      } else {
        setError(result?.error ?? 'The transfer could not be created.');
      }
    });
  }

  if (warehouses.length < 2) {
    return (
      <EmptyState
        title="Two warehouses are needed"
        description="Add a second warehouse before transferring stock between locations."
      />
    );
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
          <CardTitle>Route</CardTitle>
          <CardDescription>Where the coffee is leaving from, and where it is going.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field label="From warehouse" htmlFor="from" required>
            <Select id="from" value={fromWarehouseId} onChange={(e) => changeSourceWarehouse(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="To warehouse"
            htmlFor="to"
            required
            error={sameWarehouse ? 'Choose a different destination.' : undefined}
          >
            <Select id="to" value={toWarehouseId} onChange={(e) => setTo(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Transfer date" htmlFor="transferDate" required>
            <Input id="transferDate" type="date" value={transferDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Batches to move</CardTitle>
            <CardDescription>Only batches with free stock in the source warehouse can be chosen.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, newLine()])}>
            <Plus />
            Add batch
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {sourceStock.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-subtle">
              This warehouse has no free stock to transfer.
            </p>
          ) : (
            rows.map(({ line, option, over }, index) => (
              <div
                key={line.key}
                className={`grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end ${
                  over ? 'border-red-300 bg-red-50/40' : 'border-line'
                }`}
              >
                <Field label={`Batch ${index + 1}`} required>
                  <Combobox
                    options={options}
                    value={line.batchId}
                    onChange={(value) => setLine(line.key, { batchId: value })}
                    placeholder="Choose a batch…"
                  />
                </Field>

                <Field
                  label="Quantity (KG)"
                  required
                  error={over && option ? `Only ${formatQuantityKg(option.availableKg)} free` : undefined}
                >
                  <Input
                    value={line.quantityKg}
                    onChange={(e) => setLine(line.key, { quantityKg: e.target.value })}
                    inputMode="decimal"
                    className="tnum text-right"
                    aria-invalid={over}
                  />
                </Field>

                {lines.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove batch ${index + 1}`}
                    onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                  >
                    <Trash2 className="text-red-500" />
                  </Button>
                ) : (
                  <span />
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <Field label="Notes" htmlFor="notes">
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      {totalKg.greaterThan(0) ? (
        <Card className="border-forest-200 bg-forest-50/50">
          <CardContent className="flex flex-wrap items-center gap-3 pt-5 text-sm">
            <span className="font-medium">{warehouses.find((w) => w.id === fromWarehouseId)?.name}</span>
            <ArrowRight className="size-4 text-ink-subtle" />
            <span className="font-medium">{warehouses.find((w) => w.id === toWarehouseId)?.name}</span>
            <span className="tnum ml-auto text-base font-semibold text-forest-800">{formatQuantityKg(totalKg)}</span>
          </CardContent>
        </Card>
      ) : null}

      <Callout tone="info">
        Creating the transfer changes nothing yet. Approving reserves the stock at the source; receiving posts the
        matched movement pair that actually relocates it.
      </Callout>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} loading={pending} disabled={hasOverdraw || sameWarehouse}>
          Create transfer
        </Button>
      </div>
    </div>
  );
}
