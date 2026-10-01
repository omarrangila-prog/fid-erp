'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { DOCUMENT_STATUS_META } from '@/lib/constants';
import { changeDocumentStatusAction } from '@/server/actions/trading-actions';

/** Who the documents are waiting on — the question the client asks first. */
const WORKING_WITH = ['Supplier', 'Shipping line', 'Clearing agent', 'Bank', 'Customer', 'FID office'];

/**
 * The note kept with a document update, from its parts: "Working with:
 * Shipping line · Original B/L · Ref BL-123 · Received 01 Oct 2026 · waiting
 * for the release". One line in the document history, readable as it is.
 */
export function composeDocumentNote(parts: { workingWith?: string; document?: string; reference?: string; receivedOn?: string; memo?: string }): string {
  const received = parts.receivedOn
    ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${parts.receivedOn}T00:00:00Z`))
    : '';
  return [
    parts.workingWith ? `Working with: ${parts.workingWith}` : '',
    parts.document?.trim() ?? '',
    parts.reference?.trim() ? `Ref ${parts.reference.trim()}` : '',
    received ? `Received ${received}` : '',
    parts.memo?.trim() ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Document status is independent of the cargo. Originals can still be with
 * the supplier while the vessel is already at sea.
 *
 * Saving the same position again with a note is a progress update ("waiting
 * for the original B/L"); it goes into the document history like a change.
 */
export function DocumentStatusDialog({
  shipmentId,
  contractLabel,
  currentStatus,
  onClose,
}: {
  shipmentId: string;
  contractLabel: string;
  currentStatus: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [toStatus, setToStatus] = React.useState(currentStatus);
  const [notes, setNotes] = React.useState('');
  const [workingWith, setWorkingWith] = React.useState('');
  const [documentName, setDocumentName] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [receivedOn, setReceivedOn] = React.useState('');

  function submit() {
    setError(null);
    const note = composeDocumentNote({ workingWith, document: documentName, reference, receivedOn, memo: notes });
    startTransition(async () => {
      const result = await changeDocumentStatusAction(shipmentId, JSON.stringify({ toStatus, notes: note }));
      if (result?.ok) {
        toast.success(result.message);
        onClose();
        router.refresh();
      } else {
        setError(result?.error ?? 'The document status could not be changed.');
      }
    });
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title="Update document status"
      description={`${contractLabel}. Currently ${DOCUMENT_STATUS_META[currentStatus]?.label ?? currentStatus}.`}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Save document status
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

        <Field
          label="Document position"
          required
          hint="Pending, with the supplier, received, approved or complete — independent of Loaded / Arrived."
        >
          <Select value={toStatus} onChange={(e) => setToStatus(e.target.value)}>
            {Object.entries(DOCUMENT_STATUS_META).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Working with" htmlFor="docWith" hint="Who the documents are with or waiting on.">
            <Select id="docWith" value={workingWith} onChange={(e) => setWorkingWith(e.target.value)}>
              <option value="">—</option>
              {WORKING_WITH.map((who) => (
                <option key={who} value={who}>
                  {who}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Document" htmlFor="docName" hint="Original B/L, phyto, certificate of origin…">
            <Input id="docName" value={documentName} onChange={(e) => setDocumentName(e.target.value)} />
          </Field>
          <Field label="Reference" htmlFor="docRef">
            <Input id="docRef" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label="Received date" htmlFor="docReceived">
            <Input id="docReceived" type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
          </Field>
        </div>

        <Field label="Memo" htmlFor="docMemo">
          <Textarea id="docMemo" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Waiting for original BL" />
        </Field>
      </div>
    </Sheet>
  );
}
