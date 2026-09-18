'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Callout } from '@/components/ui/feedback';
import { saveShipmentContainersAction } from '@/server/actions/trading-actions';

export type ContainerEditLine = {
  batchId: string;
  itemName: string;
  quantity: string;
  batchNumber: string;
  lotNumber: string;
  containerNumber: string | null;
  traceabilityPending: boolean;
};

/**
 * Edit each container on a consignment without recreating the purchase order.
 */
export function ManageContainersDialog({
  shipmentId,
  contractLabel,
  lines,
  knownNumbers,
  onClose,
}: {
  shipmentId: string;
  contractLabel: string;
  lines: ContainerEditLine[];
  knownNumbers: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [numbers, setNumbers] = React.useState<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    for (const line of lines) next[line.batchId] = line.containerNumber ?? '';
    return next;
  });

  const duplicates = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const value of Object.values(numbers)) {
      const key = value.trim().toUpperCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
  }, [numbers]);

  const unused = knownNumbers.filter(
    (number) => !Object.values(numbers).some((value) => value.trim().toUpperCase() === number.trim().toUpperCase()),
  );

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveShipmentContainersAction(
        shipmentId,
        JSON.stringify({
          lines: lines.map((line) => ({
            batchId: line.batchId,
            containerNumber: numbers[line.batchId]?.trim() || null,
          })),
        }),
      );
      if (result?.ok) {
        toast.success(result.message);
        onClose();
        router.refresh();
      } else {
        setError(result?.error ?? 'The container numbers could not be saved.');
      }
    });
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title="Manage containers"
      description={`${contractLabel}. Each physical box has its own number, even when they share a PO.`}
      width="lg"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Save container numbers
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {duplicates.length > 0 ? (
          <Callout tone="warning" title="The same number is on more than one line">
            {duplicates.join(', ')}. Give each container its own number — for example MSCU1234567 and MSCU7654321 —
            then save. Warehouse and batch identity are confirmed when you receive the PO.
          </Callout>
        ) : (
          <Callout tone="info">
            Change a number here without recreating the purchase order. Receiving still asks for each container
            separately: number, batch, kilograms and warehouse.
          </Callout>
        )}

        {unused.length > 0 ? (
          <p className="text-xs text-ink-muted">
            Also recorded on this shipment, not yet on a coffee line:{' '}
            <span className="font-mono font-medium text-ink">{unused.join(', ')}</span>
          </p>
        ) : null}

        {lines.map((line, index) => (
          <div key={line.batchId} className="space-y-3 rounded-lg border border-line p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">Container {index + 1}</p>
            <p className="text-sm font-medium text-ink">{line.itemName}</p>
            <p className="text-xs text-ink-muted">
              {line.quantity}
              {line.batchNumber ? ` · Batch ${line.batchNumber}` : ''}
              {line.lotNumber && !line.traceabilityPending ? ` · Lot ${line.lotNumber}` : ''}
            </p>
            <Field label="Container number" htmlFor={`ctr-${line.batchId}`} required={lines.length > 1}>
              <Input
                id={`ctr-${line.batchId}`}
                value={numbers[line.batchId] ?? ''}
                onChange={(e) => setNumbers((prev) => ({ ...prev, [line.batchId]: e.target.value }))}
                placeholder={`MSCU${index === 0 ? '1234567' : '7654321'}`}
                className="font-mono"
              />
            </Field>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
