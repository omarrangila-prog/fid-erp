'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { DOCUMENT_STATUS_META } from '@/lib/constants';
import { changeDocumentStatusAction } from '@/server/actions/trading-actions';

/**
 * Document status is independent of the cargo. Originals can still be with
 * the supplier while the vessel is already at sea.
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

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await changeDocumentStatusAction(shipmentId, JSON.stringify({ toStatus, notes }));
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

        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Sheet>
  );
}
