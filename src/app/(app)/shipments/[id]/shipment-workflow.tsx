'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, ArrowRight, FileText, Pencil } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Callout } from '@/components/ui/feedback';
import {
  SHIPMENT_STATUS_META,
  SHIPMENT_STATUS_TRANSITIONS,
  SHIPMENT_STATUS_REQUIREMENTS,
  DOCUMENT_STATUS_META,
} from '@/lib/constants';
import {
  changeShipmentStatusAction,
  changeDocumentStatusAction,
  updateShipmentDetailsAction,
} from '@/server/actions/trading-actions';

export type ShipmentFormValues = {
  bookingNumber: string;
  billOfLading: string;
  vesselName: string;
  voyageNumber: string;
  portOfLoading: string;
  portOfDischarge: string;
  shippingLineId: string;
  etdDate: string;
  etaDate: string;
  ataDate: string;
  loadingDate: string;
  clearanceDate: string;
  deliveryDate: string;
  destination: string;
  customerId: string;
  containers: string;
};

/**
 * Shipment workflow.
 *
 * A status change is not just a dropdown: "Loaded" implies a booking, a vessel
 * and dates, so the dialog asks for exactly what the target status requires and
 * the server refuses the move if any of it is missing.
 */
export function ShipmentWorkflow({
  shipmentId,
  status,
  documentStatus,
  values,
  shippingLines,
  ports,
  customers,
  canUpdate,
}: {
  shipmentId: string;
  status: string;
  documentStatus: string;
  values: ShipmentFormValues;
  shippingLines: Array<{ id: string; name: string }>;
  /** The port master, offered as suggestions rather than enforced. */
  ports: Array<{ id: string; code: string; name: string; country: string | null }>;
  customers: Array<{ id: string; name: string }>;
  canUpdate: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = React.useState<'status' | 'documents' | 'details' | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<ShipmentFormValues>(values);
  const [targetStatus, setTargetStatus] = React.useState<string>('');
  const [targetDocStatus, setTargetDocStatus] = React.useState<string>(documentStatus);
  const [notes, setNotes] = React.useState('');

  const nextStatuses = SHIPMENT_STATUS_TRANSITIONS[status] ?? [];
  const required = targetStatus ? (SHIPMENT_STATUS_REQUIREMENTS[targetStatus] ?? []) : [];

  function open(next: 'status' | 'documents' | 'details') {
    setError(null);
    setNotes('');
    setForm(values);
    setTargetStatus(nextStatuses[0] ?? '');
    setTargetDocStatus(documentStatus);
    setMode(next);
  }

  function set(key: keyof ShipmentFormValues, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function submitStatus() {
    setError(null);
    startTransition(async () => {
      const result = await changeShipmentStatusAction(
        shipmentId,
        JSON.stringify({ toStatus: targetStatus, ...form, containers: Number(form.containers || 0), notes }),
      );
      if (result?.ok) {
        toast.success(result.message);
        setMode(null);
        router.refresh();
      } else {
        setError(result?.error ?? 'The status could not be changed.');
      }
    });
  }

  function submitDocuments() {
    setError(null);
    startTransition(async () => {
      const result = await changeDocumentStatusAction(
        shipmentId,
        JSON.stringify({ toStatus: targetDocStatus, notes }),
      );
      if (result?.ok) {
        toast.success(result.message);
        setMode(null);
        router.refresh();
      } else {
        setError(result?.error ?? 'The document status could not be changed.');
      }
    });
  }

  function submitDetails() {
    setError(null);
    startTransition(async () => {
      const result = await updateShipmentDetailsAction(
        shipmentId,
        JSON.stringify({ ...form, containers: Number(form.containers || 0), notes: '' }),
      );
      if (result?.ok) {
        toast.success(result.message);
        setMode(null);
        router.refresh();
      } else {
        setError(result?.error ?? 'The shipment could not be updated.');
      }
    });
  }

  const fieldFor = (name: string) => {
    const labels: Record<string, string> = {
      loadingDate: 'Loading date',
      bookingNumber: 'Booking number',
      shippingLineId: 'Shipping line',
      vesselName: 'Vessel name',
      portOfLoading: 'Port of loading',
      portOfDischarge: 'Port of discharge',
      etdDate: 'ETD',
      etaDate: 'ETA',
      ataDate: 'Actual arrival date',
      billOfLading: 'Bill of lading',
      clearanceDate: 'Clearance date',
      deliveryDate: 'Delivery date',
    };
    const label = labels[name] ?? name;
    const isDate = name.endsWith('Date');
    const key = name as keyof ShipmentFormValues;

    if (name === 'shippingLineId') {
      return (
        <Field key={name} label={label} required>
          <Select value={form.shippingLineId} onChange={(e) => set('shippingLineId', e.target.value)}>
            <option value="">Choose a shipping line…</option>
            {shippingLines.map((line) => (
              <option key={line.id} value={line.id}>
                {line.name}
              </option>
            ))}
          </Select>
        </Field>
      );
    }

    return (
      <Field key={name} label={label} required>
        <Input type={isDate ? 'date' : 'text'} value={form[key]} onChange={(e) => set(key, e.target.value)} />
      </Field>
    );
  };

  if (!canUpdate) return null;

  return (
    <>
      <Button variant="outline" onClick={() => open('details')}>
        <Pencil />
        Edit details
      </Button>
      <Button variant="outline" onClick={() => open('documents')}>
        <FileText />
        Documents
      </Button>
      {nextStatuses.length > 0 ? (
        <Button onClick={() => open('status')}>
          <ArrowRight />
          Move status
        </Button>
      ) : null}

      {/* --- Status --------------------------------------------------------- */}
      <Sheet
        open={mode === 'status'}
        onOpenChange={(o) => !o && setMode(null)}
        title="Move shipment status"
        description={`Currently ${SHIPMENT_STATUS_META[status]?.label ?? status}.`}
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setMode(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submitStatus} loading={pending} disabled={!targetStatus}>
              Update status
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

          <Field label="New status" required>
            <Select value={targetStatus} onChange={(e) => setTargetStatus(e.target.value)}>
              {nextStatuses.map((s) => (
                <option key={s} value={s}>
                  {SHIPMENT_STATUS_META[s]?.label ?? s}
                </option>
              ))}
            </Select>
          </Field>

          {required.length > 0 ? (
            <>
              <Callout tone="info" title={`${SHIPMENT_STATUS_META[targetStatus]?.label ?? targetStatus} requires`}>
                These details must be present before the shipment can move to this status.
              </Callout>
              <div className="grid gap-4 sm:grid-cols-2">{required.map((r) => fieldFor(r.field))}</div>
            </>
          ) : null}

          <Field label="Notes" hint="Recorded against this status change in the history.">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      </Sheet>

      {/* --- Documents ------------------------------------------------------ */}
      <Sheet
        open={mode === 'documents'}
        onOpenChange={(o) => !o && setMode(null)}
        title="Document status"
        description="Documents move independently of the cargo: originals can still be with the supplier while the vessel sails."
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setMode(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submitDocuments} loading={pending}>
              Update documents
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

          <Field label="Document status" required>
            <Select value={targetDocStatus} onChange={(e) => setTargetDocStatus(e.target.value)}>
              {Object.entries(DOCUMENT_STATUS_META).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      </Sheet>

      {/* --- Details -------------------------------------------------------- */}
      <Sheet
        open={mode === 'details'}
        onOpenChange={(o) => !o && setMode(null)}
        title="Shipment details"
        description="Booking, vessel, ports and dates. Changing these does not move the workflow."
        width="lg"
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setMode(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submitDetails} loading={pending}>
              Save details
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
            <Field label="Buyer" hint="Assigning a buyer marks the cargo as sold-ahead.">
              <Select value={form.customerId} onChange={(e) => set('customerId', e.target.value)}>
                <option value="">Not yet sold</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Shipping line">
              <Select value={form.shippingLineId} onChange={(e) => set('shippingLineId', e.target.value)}>
                <option value="">—</option>
                {shippingLines.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Booking number">
              <Input value={form.bookingNumber} onChange={(e) => set('bookingNumber', e.target.value)} />
            </Field>
            <Field label="Bill of lading">
              <Input value={form.billOfLading} onChange={(e) => set('billOfLading', e.target.value)} />
            </Field>
            <Field label="Vessel name">
              <Input value={form.vesselName} onChange={(e) => set('vesselName', e.target.value)} />
            </Field>
            <Field label="Voyage number">
              <Input value={form.voyageNumber} onChange={(e) => set('voyageNumber', e.target.value)} />
            </Field>
            {/*
              A list-backed text box, not a dropdown. The port master keeps the
              spelling consistent, but a bill of lading occasionally names a
              berth or a terminal that is on nobody's list, and the document has
              to be able to say so.
            */}
            <Field label="Port of loading" hint={ports.length > 0 ? 'Choose one, or type what the B/L says.' : undefined}>
              <Input
                list="fid-ports"
                value={form.portOfLoading}
                onChange={(e) => set('portOfLoading', e.target.value)}
              />
            </Field>
            <Field label="Port of discharge" hint={ports.length > 0 ? 'Choose one, or type what the B/L says.' : undefined}>
              <Input
                list="fid-ports"
                value={form.portOfDischarge}
                onChange={(e) => set('portOfDischarge', e.target.value)}
              />
            </Field>

            <datalist id="fid-ports">
              {ports.map((port) => (
                <option key={port.id} value={port.name}>
                  {port.code}
                  {port.country ? ` · ${port.country}` : ''}
                </option>
              ))}
            </datalist>
            <Field label="Destination">
              <Input value={form.destination} onChange={(e) => set('destination', e.target.value)} />
            </Field>
            <Field label="Containers">
              <Input
                value={form.containers}
                onChange={(e) => set('containers', e.target.value)}
                inputMode="numeric"
                className="tnum text-right"
              />
            </Field>
            <Field label="Loading date">
              <Input type="date" value={form.loadingDate} onChange={(e) => set('loadingDate', e.target.value)} />
            </Field>
            <Field label="ETD">
              <Input type="date" value={form.etdDate} onChange={(e) => set('etdDate', e.target.value)} />
            </Field>
            <Field label="ETA">
              <Input type="date" value={form.etaDate} onChange={(e) => set('etaDate', e.target.value)} />
            </Field>
          </div>
        </div>
      </Sheet>
    </>
  );
}
