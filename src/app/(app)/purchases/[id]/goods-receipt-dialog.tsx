'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, Plus } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Callout } from '@/components/ui/feedback';
import { saveGoodsReceiptAction, postGoodsReceiptAction } from '@/server/actions/trading-actions';

export type ReceivableBatch = {
  batchId: string;
  batchNumber: string;
  itemName: string;
  lotNumber: string;
  containerNumber: string | null;
  orderedKg: string;
  receivedKg: string;
  outstandingKg: string;
  bagWeightKg: string;
  /** The contract named no lot, so this receipt has to. */
  traceabilityPending: boolean;
};

/** One quantity arriving under one identity. A batch may have several. */
type ReceiptLine = {
  key: string;
  batchId: string;
  quantityKg: string;
  lotNumber: string;
  batchNumber: string;
  containerNumber: string;
};

/**
 * Goods receipt entry.
 *
 * This is the moment the coffee becomes stock, so it is the moment the system
 * asks what the coffee actually is. The purchase order did not ask — the
 * supplier had not decided yet — so a contract that named no lot arrives here
 * with empty Lot and Batch boxes and one of them must be filled.
 *
 * A consignment can also arrive as more than one lot. "Arrived as another lot"
 * adds a second quantity under a second number against the same contract line,
 * which is the client's own case: 42 MT ordered landing as 21 MT under 120229
 * and 21 MT under 120230.
 *
 * The warehouse is mandatory — stock is held per location, so "received" with
 * no warehouse would be meaningless. Quantities default to everything still
 * outstanding, and a partial receipt is simply a smaller number.
 */
type GoodsReceiptDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchaseContractId: string;
  contractNumber: string;
  batches: ReceivableBatch[];
  warehouses: Array<{ id: string; name: string; code: string }>;
  defaultWarehouseId: string | null;
};

export function GoodsReceiptDialog(props: GoodsReceiptDialogProps) {
  // Remounting on each open reseeds the quantities from what is still
  // outstanding, without a reset effect that would render twice.
  return <GoodsReceiptDialogBody key={props.open ? 'open' : 'closed'} {...props} />;
}

function GoodsReceiptDialogBody({
  open,
  onOpenChange,
  purchaseContractId,
  contractNumber,
  batches,
  warehouses,
  defaultWarehouseId,
}: GoodsReceiptDialogProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [warehouseId, setWarehouseId] = React.useState(defaultWarehouseId ?? warehouses[0]?.id ?? '');
  const [receiptDate, setReceiptDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = React.useState('');
  const [notes, setNotes] = React.useState('');
  // Seeded once on mount. The dialog is remounted each time it opens, so the
  // quantities always start from what is genuinely still outstanding.
  const [lines, setLines] = React.useState<ReceiptLine[]>(() =>
    batches.map((b) => ({
      key: b.batchId,
      batchId: b.batchId,
      quantityKg: b.outstandingKg,
      // A batch the contract already identified keeps its numbers; a
      // placeholder starts blank, because showing `MOR-PO-000042/1` in a box
      // the user is meant to replace invites them to leave it.
      lotNumber: b.traceabilityPending ? '' : b.lotNumber,
      batchNumber: b.traceabilityPending ? '' : b.batchNumber,
      containerNumber: b.containerNumber ?? '',
    })),
  );

  const byId = React.useMemo(() => new Map(batches.map((b) => [b.batchId, b])), [batches]);

  function update(key: string, patch: Partial<ReceiptLine>) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function splitFrom(line: ReceiptLine) {
    const batch = byId.get(line.batchId);
    if (!batch) return;

    // The new line starts with whatever the first one is not taking, so the
    // two add up to the consignment without anyone doing arithmetic.
    const claimed = lines
      .filter((l) => l.batchId === line.batchId)
      .reduce((sum, l) => sum + (Number(l.quantityKg) || 0), 0);
    const remaining = Math.max(0, Number(batch.outstandingKg) - claimed);

    setLines((prev) => {
      const index = prev.findIndex((l) => l.key === line.key);
      const created: ReceiptLine = {
        key: `${line.batchId}:${Date.now()}`,
        batchId: line.batchId,
        quantityKg: remaining > 0 ? String(remaining) : '',
        lotNumber: '',
        batchNumber: '',
        containerNumber: '',
      };
      return [...prev.slice(0, index + 1), created, ...prev.slice(index + 1)];
    });
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  function submit() {
    setError(null);

    const entered = lines.filter((l) => l.quantityKg.trim() !== '' && Number(l.quantityKg) > 0);

    if (entered.length === 0) {
      setError('Enter a quantity for at least one line.');
      return;
    }
    if (!warehouseId) {
      setError('Choose the warehouse the coffee was received into.');
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
        'Enter a Lot Number or a Batch Number for each line. This is the point the coffee becomes stock, and stock without an identity cannot be traced to a customer later.',
      );
      return;
    }

    // A second identity against the same contract line is a split, and the
    // parts cannot come to more than the line has left.
    for (const batch of batches) {
      const claimed = entered
        .filter((l) => l.batchId === batch.batchId)
        .reduce((sum, l) => sum + Number(l.quantityKg), 0);
      if (claimed > Number(batch.outstandingKg) + 0.0005) {
        setError(
          `${batch.itemName}: ${claimed.toLocaleString()} KG entered but only ${Number(
            batch.outstandingKg,
          ).toLocaleString()} KG is still to be received.`,
        );
        return;
      }
    }

    const payload = entered.map((l) => {
      const batch = byId.get(l.batchId);
      return {
        batchId: l.batchId,
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
      const created = await saveGoodsReceiptAction(
        JSON.stringify({ purchaseContractId, warehouseId, receiptDate, reference, notes, lines: payload }),
      );

      if (!created?.ok) {
        setError(created?.error ?? 'The goods receipt could not be created.');
        return;
      }

      // Creating and posting are one user action here: a receipt that is not
      // posted has not actually brought any coffee into stock.
      const posted = await postGoodsReceiptAction(created.id);
      if (!posted.ok) {
        setError(posted.error);
        return;
      }

      toast.success('Goods received into stock.');
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Receive goods"
      description={`Against ${contractNumber}. Stock becomes available in the warehouse you choose.`}
      width="lg"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Receive into stock
          </Button>
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
          <Field label="Warehouse" htmlFor="warehouseId" required hint="Stock is tracked per warehouse.">
            <Select id="warehouseId" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.code})
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Receipt date" htmlFor="receiptDate" required>
            <Input
              id="receiptDate"
              type="date"
              value={receiptDate}
              onChange={(e) => setReceiptDate(e.target.value)}
            />
          </Field>

          <Field label="Reference" htmlFor="reference" hint="Delivery note or weighbridge ticket.">
            <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>

        <div className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">What arrived</h4>

          {batches.map((batch) => {
            const rows = lines.filter((l) => l.batchId === batch.batchId);
            const claimed = rows.reduce((sum, l) => sum + (Number(l.quantityKg) || 0), 0);
            const over = claimed > Number(batch.outstandingKg) + 0.0005;

            return (
              <div key={batch.batchId} className="space-y-2 rounded-lg border border-line p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{batch.itemName}</p>
                  <p className="tnum mt-0.5 text-xs text-ink-muted">
                    Ordered {Number(batch.orderedKg).toLocaleString()} KG · already received{' '}
                    {Number(batch.receivedKg).toLocaleString()} KG · outstanding{' '}
                    <span className="font-semibold text-ink">
                      {Number(batch.outstandingKg).toLocaleString()} KG
                    </span>
                  </p>
                  {over ? (
                    <p className="tnum mt-1 text-xs font-medium text-red-700">
                      {claimed.toLocaleString()} KG entered, which is more than the contract has left.
                    </p>
                  ) : null}
                </div>

                {rows.map((line, index) => (
                  <div key={line.key} className="grid gap-2 sm:grid-cols-[1fr_1fr_7rem]">
                    <Field
                      label={index === 0 ? 'Lot number' : 'Lot number (second lot)'}
                      htmlFor={`lot-${line.key}`}
                      required={batch.traceabilityPending}
                      hint={
                        index === 0 && batch.traceabilityPending
                          ? 'Whatever the supplier marked it as.'
                          : undefined
                      }
                    >
                      <Input
                        id={`lot-${line.key}`}
                        value={line.lotNumber}
                        onChange={(e) => update(line.key, { lotNumber: e.target.value })}
                        placeholder="120229"
                      />
                    </Field>

                    <Field label="Batch number" htmlFor={`batch-${line.key}`} hint="If different from the lot.">
                      <Input
                        id={`batch-${line.key}`}
                        value={line.batchNumber}
                        onChange={(e) => update(line.key, { batchNumber: e.target.value })}
                        placeholder="Optional"
                      />
                    </Field>

                    <Field label="Quantity" htmlFor={`qty-${line.key}`} required>
                      <Input
                        id={`qty-${line.key}`}
                        value={line.quantityKg}
                        onChange={(e) => update(line.key, { quantityKg: e.target.value })}
                        inputMode="decimal"
                        className="tnum text-right"
                        placeholder="0"
                      />
                    </Field>

                    {rows.length > 1 ? (
                      <div className="sm:col-span-3">
                        <Button variant="ghost" size="sm" onClick={() => removeLine(line.key)}>
                          Remove this lot
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}

                <Button variant="outline" size="sm" onClick={() => splitFrom(rows[rows.length - 1])}>
                  <Plus />
                  Arrived as another lot
                </Button>
              </div>
            );
          })}
        </div>

        <Field label="Notes" htmlFor="grnNotes">
          <Textarea id="grnNotes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <Callout tone="info">
          Receiving moves the value from <strong>Inventory in Transit</strong> into <strong>Inventory</strong> at the
          batch&rsquo;s landed cost, and makes the coffee available to sell from this warehouse. You can receive a
          contract in as many partial receipts as reality requires.
        </Callout>
      </div>
    </Sheet>
  );
}
