'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, Plus } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Callout } from '@/components/ui/feedback';
import { receiveContainersAction } from '@/server/actions/trading-actions';
import { todayInputValue } from '@/lib/format';

export type ReceivableBatch = {
  batchId: string;
  batchNumber: string;
  /** "Shipment 2" — which shipment on the order this batch sails in. */
  shipmentOrdinal: number;
  /** Landed, so it can be received. Ticked by default; the rest are not. */
  arrived: boolean;
  itemName: string;
  lotNumber: string;
  containerNumber: string | null;
  /** Every container this batch is received from — one row each. */
  containerNumbers: string[];
  orderedKg: string;
  receivedKg: string;
  outstandingKg: string;
  bagWeightKg: string;
  /** The contract named no lot, so this receipt has to. */
  traceabilityPending: boolean;
};

/** One container being received: its own identity, quantity and store. */
type ReceiptLine = {
  key: string;
  batchId: string;
  selected: boolean;
  quantityKg: string;
  lotNumber: string;
  batchNumber: string;
  containerNumber: string;
  warehouseId: string;
};

/**
 * Goods receipt, container by container.
 *
 * A purchase order is five or six containers that land on different days, so
 * this is the moment the user says exactly which of them are in: every
 * container on the order is a row with a tick box, and each ticked row carries
 * its own received kilograms, lot number, batch number and warehouse. Three
 * containers landing together and going to two stores is one press of the
 * button; the fourth landing tomorrow is another. Nothing here is fixed at
 * one or two rows — a batch that was ordered across two containers shows two.
 *
 * Lot and batch are asked here rather than on the order because this is when
 * the supplier has said what the coffee is. A batch the contract already
 * named keeps its numbers; a placeholder starts blank and must be filled in.
 */
type GoodsReceiptDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchaseContractId: string;
  contractLabel: string;
  batches: ReceivableBatch[];
  warehouses: Array<{ id: string; name: string; code: string }>;
  defaultWarehouseId: string | null;
};

export function GoodsReceiptDialog(props: GoodsReceiptDialogProps) {
  // Remounting on each open reseeds the rows from what is still outstanding,
  // without a reset effect that would render twice.
  return <GoodsReceiptDialogBody key={props.open ? 'open' : 'closed'} {...props} />;
}

/** Divide what is outstanding across the batch's containers, remainder on the last. */
function seedRows(batch: ReceivableBatch, warehouseId: string): ReceiptLine[] {
  const containers = batch.containerNumbers.length > 0 ? batch.containerNumbers : [batch.containerNumber ?? ''];
  const outstanding = Number(batch.outstandingKg) || 0;
  const each = Math.floor((outstanding / containers.length) * 1000) / 1000;
  return containers.map((containerNumber, index) => {
    const last = index === containers.length - 1;
    const quantity = last ? Math.round((outstanding - each * (containers.length - 1)) * 1000) / 1000 : each;
    return {
      key: `${batch.batchId}:${index}`,
      batchId: batch.batchId,
      selected: batch.arrived,
      quantityKg: quantity > 0 ? String(quantity) : '',
      // The first container keeps the numbers the contract named; the rest
      // are other containers and get their own at the gate. A placeholder
      // starts blank, because showing `ICUL/FID/002/1` in a box the user is
      // meant to replace invites them to leave it.
      lotNumber: index === 0 && !batch.traceabilityPending ? batch.lotNumber : '',
      batchNumber: index === 0 && !batch.traceabilityPending ? batch.batchNumber : '',
      containerNumber,
      warehouseId,
    };
  });
}

function GoodsReceiptDialogBody({
  open,
  onOpenChange,
  purchaseContractId,
  contractLabel,
  batches,
  warehouses,
  defaultWarehouseId,
}: GoodsReceiptDialogProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const firstWarehouse = defaultWarehouseId ?? warehouses[0]?.id ?? '';
  const [receiptDate, setReceiptDate] = React.useState(todayInputValue());
  const [reference, setReference] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [lines, setLines] = React.useState<ReceiptLine[]>(() =>
    batches.flatMap((batch) => seedRows(batch, firstWarehouse)),
  );

  const byId = React.useMemo(() => new Map(batches.map((b) => [b.batchId, b])), [batches]);
  const selected = lines.filter((l) => l.selected);
  const allSelected = lines.length > 0 && selected.length === lines.length;

  function update(key: string, patch: Partial<ReceiptLine>) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function selectAll(value: boolean) {
    setLines((prev) => prev.map((line) => ({ ...line, selected: value })));
  }

  /** Every ticked container into the same store, in one motion. */
  function sendAllTo(warehouseId: string) {
    setLines((prev) => prev.map((line) => (line.selected ? { ...line, warehouseId } : line)));
  }

  /** A container that arrived as two lots: one more row against the same batch. */
  function splitFrom(line: ReceiptLine) {
    const batch = byId.get(line.batchId);
    if (!batch) return;
    const claimed = lines
      .filter((l) => l.batchId === line.batchId)
      .reduce((sum, l) => sum + (Number(l.quantityKg) || 0), 0);
    const remaining = Math.max(0, Number(batch.outstandingKg) - claimed);
    setLines((prev) => {
      const index = prev.findIndex((l) => l.key === line.key);
      const created: ReceiptLine = {
        key: `${line.batchId}:${Date.now()}`,
        batchId: line.batchId,
        selected: true,
        quantityKg: remaining > 0 ? String(remaining) : '',
        lotNumber: '',
        batchNumber: '',
        containerNumber: line.containerNumber,
        warehouseId: line.warehouseId,
      };
      return [...prev.slice(0, index + 1), created, ...prev.slice(index + 1)];
    });
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  function submit() {
    setError(null);

    const entered = selected.filter((l) => l.quantityKg.trim() !== '' && Number(l.quantityKg) > 0);
    if (selected.length === 0) {
      setError('Tick the containers that have been received.');
      return;
    }
    if (entered.length !== selected.length) {
      setError('Enter the kilograms received for every ticked container.');
      return;
    }
    const noStore = entered.find((l) => !l.warehouseId);
    if (noStore) {
      setError('Choose the warehouse for every ticked container.');
      return;
    }

    // The same rule the server enforces, said here so the user reads it
    // beside the box rather than after pressing the button.
    const unnamed = entered.find((l) => {
      const batch = byId.get(l.batchId);
      const named = l.lotNumber.trim() || l.batchNumber.trim();
      return !named && (batch?.traceabilityPending ?? false);
    });
    if (unnamed) {
      setError(
        `Enter a Lot Number or a Batch Number for container ${unnamed.containerNumber || ''}. This is the point the coffee becomes stock, and stock without an identity cannot be traced to a customer later.`,
      );
      return;
    }

    // The weighbridge may say a little more than the contract; a lot more
    // is a typo. The same tenth the server allows.
    for (const batch of batches) {
      const claimed = entered
        .filter((l) => l.batchId === batch.batchId)
        .reduce((sum, l) => sum + Number(l.quantityKg), 0);
      const allowance = Number(batch.orderedKg) * 0.1;
      if (claimed > Number(batch.outstandingKg) + allowance + 0.0005) {
        setError(
          `${batch.itemName}: ${claimed.toLocaleString()} KG entered, but ${Number(batch.outstandingKg).toLocaleString()} KG is still to be received and at most ${Math.round(allowance).toLocaleString()} KG more than ordered can be accepted. Check the weight, or correct the order first.`,
        );
        return;
      }
    }

    const payload = entered.map((l) => {
      const batch = byId.get(l.batchId);
      return {
        batchId: l.batchId,
        warehouseId: l.warehouseId,
        quantityKg: l.quantityKg.trim(),
        lotNumber: l.lotNumber.trim() || undefined,
        batchNumber: l.batchNumber.trim() || undefined,
        containerNumber: l.containerNumber.trim() || undefined,
        bags:
          batch && Number(batch.bagWeightKg) > 0
            ? Math.round(Number(l.quantityKg) / Number(batch.bagWeightKg))
            : undefined,
      };
    });

    startTransition(async () => {
      const result = await receiveContainersAction(
        JSON.stringify({ purchaseContractId, receiptDate, reference, notes, lines: payload }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const stores = new Set(payload.map((l) => l.warehouseId)).size;
      toast.success(
        `${payload.length} ${payload.length === 1 ? 'container' : 'containers'} received into stock${stores > 1 ? ` across ${stores} warehouses` : ''}.`,
      );
      onOpenChange(false);
      router.refresh();
    });
  }

  const warehouseName = (id: string) => warehouses.find((w) => w.id === id)?.name ?? '';

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Receive goods"
      description={`Against ${contractLabel}. Tick the containers that are in; each becomes stock in the warehouse you choose for it.`}
      width="lg"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-ink-muted">
            {selected.length} of {lines.length} {lines.length === 1 ? 'container' : 'containers'} ticked
          </span>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} loading={pending} disabled={selected.length === 0}>
              {allSelected ? 'Receive all' : `Receive selected (${selected.length})`}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Receipt date" htmlFor="receiptDate" required>
            <Input id="receiptDate" type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} />
          </Field>
          <Field label="Reference" htmlFor="reference" hint="Delivery note or weighbridge ticket.">
            <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field
            label="Send all ticked containers to"
            htmlFor="allWarehouse"
            hint="A shortcut. Each container below still has its own warehouse."
          >
            <Select id="allWarehouse" value="" onChange={(e) => e.target.value && sendAllTo(e.target.value)}>
              <option value="">Choose a warehouse…</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
                Containers on this order
              </h4>
              <p className="text-xs text-ink-muted">
                Containers that have arrived are ticked. Untick any that are not in yet, or tick them all.
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs font-medium text-ink">
              <input
                type="checkbox"
                className="size-4 accent-gold-600"
                checked={allSelected}
                onChange={(e) => selectAll(e.target.checked)}
                aria-label="Select all containers"
              />
              Select all
            </label>
          </div>

          {lines.map((line, index) => {
            const batch = byId.get(line.batchId);
            if (!batch) return null;
            const siblings = lines.filter((l) => l.batchId === line.batchId);
            const claimed = siblings.filter((l) => l.selected).reduce((sum, l) => sum + (Number(l.quantityKg) || 0), 0);
            const excess = claimed - Number(batch.outstandingKg);
            const allowance = Number(batch.orderedKg) * 0.1;
            const over = excess > 0.0005;
            const tooFar = excess > allowance + 0.0005;
            const perContainer = Number(batch.orderedKg) / Math.max(1, batch.containerNumbers.length);

            return (
              <div
                key={line.key}
                className={`space-y-3 rounded-lg border p-3 ${line.selected ? 'border-line' : 'border-line/60 bg-surface-sunken/40'}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <label className="flex min-w-0 items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-gold-600"
                      checked={line.selected}
                      onChange={(e) => update(line.key, { selected: e.target.checked })}
                      aria-label={`Receive container ${index + 1}`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">
                        Container {index + 1}
                        {line.containerNumber ? (
                          <span className="ml-2 font-mono text-xs text-ink-muted">{line.containerNumber}</span>
                        ) : null}
                        <span className="ml-2 text-xs font-normal text-ink-muted">· {batch.itemName}</span>
                      </span>
                      <span className="tnum block text-xs text-ink-muted">
                        Ordered {perContainer.toLocaleString(undefined, { maximumFractionDigits: 0 })} KG
                        {siblings.length > 1
                          ? ` (${Number(batch.orderedKg).toLocaleString()} KG across ${siblings.length} containers)`
                          : ''}{' '}
                        · outstanding{' '}
                        <span className="font-semibold text-ink">{Number(batch.outstandingKg).toLocaleString()} KG</span>
                        {batches.length > 1 ? ` · Shipment ${batch.shipmentOrdinal}` : ''}
                      </span>
                    </span>
                  </label>
                  <Badge tone={batch.arrived ? 'progress' : 'neutral'}>
                    {batch.arrived ? 'Arrived' : 'Pending arrival'}
                  </Badge>
                </div>

                {over && line.key === siblings[siblings.length - 1].key ? (
                  <p className={`tnum text-xs ${tooFar ? 'font-medium text-red-700' : 'text-amber-800'}`}>
                    {tooFar
                      ? `${claimed.toLocaleString()} KG entered for ${batch.itemName}; ${Number(batch.outstandingKg).toLocaleString()} KG is still to be received and at most ${Math.round(allowance).toLocaleString()} KG more than ordered can be accepted.`
                      : `${claimed.toLocaleString()} KG entered for ${batch.itemName} — ${Math.round(excess).toLocaleString()} KG more than the ${Number(batch.outstandingKg).toLocaleString()} KG ordered. The extra is received at no extra cost; the supplier is owed the contract value.`}
                  </p>
                ) : null}

                {line.selected ? (
                  <>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                      <Field label="Container number" htmlFor={`ctr-${line.key}`}>
                        <Input
                          id={`ctr-${line.key}`}
                          value={line.containerNumber}
                          onChange={(e) => update(line.key, { containerNumber: e.target.value })}
                          placeholder="MSCU1234567"
                          className="font-mono"
                        />
                      </Field>
                      <Field
                        label="Lot number"
                        htmlFor={`lot-${line.key}`}
                        required={batch.traceabilityPending}
                        hint={batch.traceabilityPending ? 'Whatever the supplier marked it as.' : undefined}
                      >
                        <Input
                          id={`lot-${line.key}`}
                          value={line.lotNumber}
                          onChange={(e) => update(line.key, { lotNumber: e.target.value })}
                          placeholder="120229"
                        />
                      </Field>
                      <Field label="Batch number" htmlFor={`batch-${line.key}`} required={batch.traceabilityPending}>
                        <Input
                          id={`batch-${line.key}`}
                          value={line.batchNumber}
                          onChange={(e) => update(line.key, { batchNumber: e.target.value })}
                          placeholder={batch.traceabilityPending ? '' : 'Optional'}
                        />
                      </Field>
                      <Field label="Received (KG)" htmlFor={`qty-${line.key}`} required>
                        <Input
                          id={`qty-${line.key}`}
                          value={line.quantityKg}
                          onChange={(e) => update(line.key, { quantityKg: e.target.value })}
                          inputMode="decimal"
                          className="tnum text-right"
                          placeholder="0"
                        />
                      </Field>
                      <Field label="Warehouse" htmlFor={`wh-${line.key}`} required>
                        <Select
                          id={`wh-${line.key}`}
                          value={line.warehouseId}
                          onChange={(e) => update(line.key, { warehouseId: e.target.value })}
                        >
                          {warehouses.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="ghost" size="sm" onClick={() => splitFrom(line)}>
                        <Plus />
                        Arrived as another lot
                      </Button>
                      {siblings.length > 1 ? (
                        <Button variant="ghost" size="sm" onClick={() => removeLine(line.key)}>
                          Remove this row
                        </Button>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-ink-subtle">
                    Not being received now.
                    {line.warehouseId ? ` Would go to ${warehouseName(line.warehouseId)}.` : ''}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <Field label="Notes" htmlFor="grnNotes">
          <Textarea id="grnNotes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <Callout tone="info">
          Receiving moves the value from <strong>Inventory in Transit</strong> into <strong>Inventory</strong> at the
          batch&rsquo;s landed cost, and makes each container&rsquo;s coffee available to sell from its warehouse. Containers
          that land later are received the same way, on their own day.
        </Callout>
      </div>
    </Sheet>
  );
}
