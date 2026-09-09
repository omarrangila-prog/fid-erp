'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
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
};

/**
 * Goods receipt entry.
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
  const [quantities, setQuantities] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(batches.map((b) => [b.batchId, b.outstandingKg])),
  );

  function submit() {
    setError(null);

    const lines = batches
      .map((b) => ({ batch: b, quantityKg: (quantities[b.batchId] ?? '').trim() }))
      .filter((l) => l.quantityKg !== '' && Number(l.quantityKg) > 0)
      .map((l) => ({
        batchId: l.batch.batchId,
        quantityKg: l.quantityKg,
        bags:
          Number(l.batch.bagWeightKg) > 0
            ? Math.round(Number(l.quantityKg) / Number(l.batch.bagWeightKg))
            : undefined,
      }));

    if (lines.length === 0) {
      setError('Enter a quantity for at least one batch.');
      return;
    }
    if (!warehouseId) {
      setError('Choose the warehouse the coffee was received into.');
      return;
    }

    startTransition(async () => {
      const created = await saveGoodsReceiptAction(
        JSON.stringify({ purchaseContractId, warehouseId, receiptDate, reference, notes, lines }),
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
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">Batches to receive</h4>
          {batches.map((b) => (
            <div key={b.batchId} className="rounded-lg border border-line p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{b.batchNumber}</p>
                  <p className="truncate text-xs text-ink-subtle">
                    {b.itemName} · Lot {b.lotNumber}
                    {b.containerNumber ? ` · ${b.containerNumber}` : ''}
                  </p>
                  <p className="tnum mt-1 text-xs text-ink-muted">
                    Ordered {Number(b.orderedKg).toLocaleString()} KG · already received{' '}
                    {Number(b.receivedKg).toLocaleString()} KG · outstanding{' '}
                    <span className="font-semibold text-ink">{Number(b.outstandingKg).toLocaleString()} KG</span>
                  </p>
                </div>
                <div className="w-32 shrink-0">
                  <Input
                    aria-label={`Quantity received for ${b.batchNumber}`}
                    value={quantities[b.batchId] ?? ''}
                    onChange={(e) => setQuantities((prev) => ({ ...prev, [b.batchId]: e.target.value }))}
                    inputMode="decimal"
                    className="tnum text-right"
                    placeholder="0"
                  />
                  <p className="mt-1 text-right text-[11px] text-ink-subtle">KG</p>
                </div>
              </div>
            </div>
          ))}
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
