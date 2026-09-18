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
import { todayInputValue } from '@/lib/format';

/**
 * Mark as loaded.
 *
 * The purchase order stopped asking for any of this, because when a contract
 * is signed none of it exists — there is no vessel, no bill of lading and no
 * arrival date to give. It all appears at once when the supplier actually
 * ships, and this is where it is taken.
 *
 * Arrival date and shipping line are required. So is identification: a
 * booking or B/L number, or the individual container numbers. One booking
 * routinely covers several boxes.
 */
export function MarkLoadedDialog({
  open,
  onOpenChange,
  shipmentId,
  contractLabel,
  shippingLines,
  ports = [],
  defaults,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shipmentId: string;
  contractLabel: string;
  shippingLines: Array<{ id: string; name: string }>;
  /** Names from the Ports master, offered as the user types. */
  ports?: string[];
  defaults?: {
    shippingLineId?: string | null;
    etaDate?: string | null;
    bookingNumber?: string | null;
    billOfLading?: string | null;
    containerNumber?: string | null;
    containerNumbers?: string[];
    containers?: number;
    portOfLoading?: string | null;
    portOfDischarge?: string | null;
  };
}) {
  return (
    <MarkLoadedBody
      key={open ? 'open' : 'closed'}
      open={open}
      onOpenChange={onOpenChange}
      shipmentId={shipmentId}
      contractLabel={contractLabel}
      shippingLines={shippingLines}
      ports={ports}
      defaults={defaults}
    />
  );
}

function MarkLoadedBody({
  open,
  onOpenChange,
  shipmentId,
  contractLabel,
  shippingLines,
  ports = [],
  defaults,
}: React.ComponentProps<typeof MarkLoadedDialog>) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const [form, setForm] = React.useState({
    loadingDate: todayInputValue(),
    etaDate: defaults?.etaDate ?? '',
    shippingLineId: defaults?.shippingLineId ?? (shippingLines.length === 1 ? shippingLines[0].id : ''),
    bookingNumber: defaults?.bookingNumber ?? '',
    billOfLading: defaults?.billOfLading ?? '',
    portOfLoading: defaults?.portOfLoading ?? '',
    portOfDischarge: defaults?.portOfDischarge ?? '',
    notes: '',
  });

  /*
   * "Three containers" means three boxes.
   *
   * The client asked for exactly this: say how many are on the booking and get
   * that many numbered fields, because one booking routinely covers several
   * containers and typing them into a single box loses which is which.
   */
  const initialContainers = Math.max(
    1,
    defaults?.containerNumbers?.length || defaults?.containers || (defaults?.containerNumber ? 1 : 1),
  );
  const [containerCount, setContainerCount] = React.useState(initialContainers);
  const [containerNumbers, setContainerNumbers] = React.useState<string[]>(() => {
    const known = defaults?.containerNumbers?.filter(Boolean) ?? [];
    if (known.length > 0) {
      const grown = [...known];
      while (grown.length < initialContainers) grown.push('');
      return grown;
    }
    return Array.from({ length: initialContainers }, (_, i) =>
      i === 0 ? (defaults?.containerNumber ?? '') : '',
    );
  });

  function setCount(next: number) {
    const count = Math.max(1, Math.min(40, Number.isFinite(next) ? next : 1));
    setContainerCount(count);
    setContainerNumbers((prev) => {
      const grown = [...prev];
      while (grown.length < count) grown.push('');
      return grown.slice(0, count);
    });
  }

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
    const identified =
      Boolean(form.bookingNumber.trim()) ||
      Boolean(form.billOfLading.trim()) ||
      containerNumbers.some((value) => value.trim());
    if (!identified) {
      setError(
        'Enter a booking or B/L number, or at least one container number. Loaded cannot be recorded without identifying the consignment.',
      );
      return;
    }

    startTransition(async () => {
      const result = await markShipmentLoadedAction(
        shipmentId,
        JSON.stringify({ ...form, containerNumbers: containerNumbers.map((n) => n.trim()).filter(Boolean) }),
      );
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
      description={`${contractLabel}. The loading sheet updates from what you enter here.`}
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

          <Field label="Port of loading" htmlFor="portOfLoading">
            <Input
              id="portOfLoading"
              list="loading-ports-list"
              value={form.portOfLoading}
              onChange={(e) => set({ portOfLoading: e.target.value })}
            />
          </Field>

          <Field label="Port of discharge" htmlFor="portOfDischarge">
            <Input
              id="portOfDischarge"
              list="loading-ports-list"
              value={form.portOfDischarge}
              onChange={(e) => set({ portOfDischarge: e.target.value })}
            />
          </Field>
          {/* The Ports master, offered as suggestions so one place is always spelled one way. */}
          <datalist id="loading-ports-list">
            {ports.map((port) => (
              <option key={port} value={port} />
            ))}
          </datalist>

          <Field label="Bill of lading" htmlFor="billOfLading" hint="Often issued after the booking.">
            <Input
              id="billOfLading"
              value={form.billOfLading}
              onChange={(e) => set({ billOfLading: e.target.value })}
            />
          </Field>

          <Field
            label="How many containers?"
            htmlFor="containerCount"
            hint="One booking often covers several."
          >
            <Input
              id="containerCount"
              type="number"
              min={1}
              max={40}
              value={String(containerCount)}
              onChange={(e) => setCount(Number(e.target.value))}
              className="tnum"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {containerNumbers.map((value, index) => (
            <Field
              key={index}
              label={containerCount === 1 ? 'Container number' : `Container ${index + 1}`}
              htmlFor={`container-${index}`}
            >
              <Input
                id={`container-${index}`}
                value={value}
                onChange={(e) =>
                  setContainerNumbers((prev) => prev.map((n, i) => (i === index ? e.target.value : n)))
                }
                placeholder="MSCU1234567"
              />
            </Field>
          ))}
        </div>

        <Field label="Notes" htmlFor="loadedNotes">
          <Textarea id="loadedNotes" rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>

        <Callout tone="info">
          Shipping line and estimated arrival are required. Identify the consignment with a booking or B/L
          number, or with the container numbers — one booking can cover several boxes.
        </Callout>
      </div>
    </Sheet>
  );
}
