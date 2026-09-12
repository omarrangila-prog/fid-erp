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
import { markShipmentLoadedAction } from '@/server/actions/trading-actions';

/**
 * Mark as loaded.
 *
 * The purchase order stopped asking for any of this, because when a contract
 * is signed none of it exists — there is no vessel, no bill of lading and no
 * arrival date to give. It all appears at once when the supplier actually
 * ships, and this is where it is taken.
 *
 * Arrival date and shipping line are required. Everything else is genuinely
 * optional: a booking number often precedes the B/L by a fortnight, and
 * demanding both would put the user back where they started, unable to record
 * what they know because they cannot yet record what they do not.
 */
export function MarkLoadedDialog({
  open,
  onOpenChange,
  shipmentId,
  contractNumber,
  shippingLines,
  defaults,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shipmentId: string;
  contractNumber: string;
  shippingLines: Array<{ id: string; name: string }>;
  defaults?: {
    shippingLineId?: string | null;
    etaDate?: string | null;
    bookingNumber?: string | null;
    billOfLading?: string | null;
    containerNumber?: string | null;
  };
}) {
  return (
    <MarkLoadedBody
      key={open ? 'open' : 'closed'}
      open={open}
      onOpenChange={onOpenChange}
      shipmentId={shipmentId}
      contractNumber={contractNumber}
      shippingLines={shippingLines}
      defaults={defaults}
    />
  );
}

function MarkLoadedBody({
  open,
  onOpenChange,
  shipmentId,
  contractNumber,
  shippingLines,
  defaults,
}: React.ComponentProps<typeof MarkLoadedDialog>) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const [form, setForm] = React.useState({
    loadingDate: new Date().toISOString().slice(0, 10),
    etaDate: defaults?.etaDate ?? '',
    shippingLineId: defaults?.shippingLineId ?? (shippingLines.length === 1 ? shippingLines[0].id : ''),
    bookingNumber: defaults?.bookingNumber ?? '',
    billOfLading: defaults?.billOfLading ?? '',
    containerNumber: defaults?.containerNumber ?? '',
    notes: '',
  });

  const set = (patch: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...patch }));

  function submit() {
    setError(null);

    // The same two rules the server holds, said here so they are read beside
    // the boxes rather than after pressing the button.
    if (!form.etaDate) {
      setError('Enter the estimated arrival date. The loading sheet is read to find out when coffee lands.');
      return;
    }
    if (!form.shippingLineId) {
      setError('Choose the shipping line carrying this consignment.');
      return;
    }

    startTransition(async () => {
      const result = await markShipmentLoadedAction(shipmentId, JSON.stringify(form));
      if (!result?.ok) {
        setError(result?.error ?? 'This consignment could not be marked loaded.');
        return;
      }

      toast.success('Marked as loaded.');
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Mark as loaded"
      description={`${contractNumber}. The loading sheet updates from what you enter here.`}
      width="md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Mark as loaded
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Loading date" htmlFor="loadingDate" required>
            <Input
              id="loadingDate"
              type="date"
              value={form.loadingDate}
              onChange={(e) => set({ loadingDate: e.target.value })}
            />
          </Field>

          <Field label="Estimated arrival" htmlFor="etaDate" required hint="When it is expected to land.">
            <Input
              id="etaDate"
              type="date"
              value={form.etaDate}
              min={form.loadingDate || undefined}
              onChange={(e) => set({ etaDate: e.target.value })}
            />
          </Field>

          <Field label="Shipping line" htmlFor="shippingLineId" required>
            <Select
              id="shippingLineId"
              value={form.shippingLineId}
              onChange={(e) => set({ shippingLineId: e.target.value })}
            >
              <option value="">Choose…</option>
              {shippingLines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Booking number" htmlFor="bookingNumber">
            <Input
              id="bookingNumber"
              value={form.bookingNumber}
              onChange={(e) => set({ bookingNumber: e.target.value })}
            />
          </Field>

          <Field label="Bill of lading" htmlFor="billOfLading" hint="Often issued after the booking.">
            <Input
              id="billOfLading"
              value={form.billOfLading}
              onChange={(e) => set({ billOfLading: e.target.value })}
            />
          </Field>

          <Field label="Container number" htmlFor="containerNumber">
            <Input
              id="containerNumber"
              value={form.containerNumber}
              onChange={(e) => set({ containerNumber: e.target.value })}
              placeholder="MSCU1234567"
            />
          </Field>
        </div>

        <Field label="Notes" htmlFor="loadedNotes">
          <Textarea id="loadedNotes" rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>

        <Callout tone="info">
          Anything you leave blank can be added later from the consignment itself — a bill of lading that has not been
          issued yet should not stop you recording that the coffee is on the water.
        </Callout>
      </div>
    </Sheet>
  );
}
