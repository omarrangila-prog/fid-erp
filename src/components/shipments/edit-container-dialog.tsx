'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Input, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { editContainerAction } from '@/server/actions/trading-actions';

export type EditableContainer = {
  shipmentId: string;
  /** "Shipment 2" or the container number — what the dialog calls it. */
  label: string;
  quantityKg: string;
  containerNumber: string | null;
  lotNumber: string | null;
  batchNumber: string | null;
};

/**
 * Correct one container before it is received: kilograms, container number,
 * lot and batch. One form, used on the purchase order and in Quick Update,
 * through the same action — the supplier is owed the difference at the row's
 * price, and the old and new values with the reason go to the audit log.
 */
export function EditContainerDialog({
  container,
  onClose,
  onSaved,
}: {
  container: EditableContainer | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [edit, setEdit] = React.useState({ quantityKg: '', containerNumber: '', lotNumber: '', batchNumber: '', reason: '' });
  const [busy, setBusy] = React.useState(false);
  const [seeded, setSeeded] = React.useState<string | null>(null);

  // A new container to edit starts from its own values.
  if (container && seeded !== container.shipmentId) {
    setSeeded(container.shipmentId);
    setEdit({
      quantityKg: container.quantityKg.replace(/[^\d.]/g, ''),
      containerNumber: container.containerNumber ?? '',
      lotNumber: container.lotNumber ?? '',
      batchNumber: container.batchNumber ?? '',
      reason: '',
    });
  }
  if (!container && seeded !== null) setSeeded(null);

  async function save() {
    if (!container) return;
    setBusy(true);
    const result = await editContainerAction(
      JSON.stringify({
        shipmentId: container.shipmentId,
        quantityKg: edit.quantityKg.trim() || undefined,
        containerNumber: edit.containerNumber.trim() || undefined,
        lotNumber: edit.lotNumber.trim() || undefined,
        batchNumber: edit.batchNumber.trim() || undefined,
        reason: edit.reason.trim() || undefined,
      }),
    );
    setBusy(false);
    if (!result.ok) throw new Error(result.error);
    toast.success(`${container.label} corrected.`);
    await onSaved();
  }

  return (
    <ConfirmDialog
      open={container !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={container ? `Correct ${container.label}` : ''}
      description="Kilograms, container, lot and batch on this container only. The supplier is owed the difference at the row's price; old and new values are kept."
      confirmLabel={busy ? 'Saving…' : 'Save correction'}
      onConfirm={save}
      body={
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Quantity (KG)" htmlFor="editKg" required>
              <Input id="editKg" inputMode="decimal" className="tnum text-right" value={edit.quantityKg} onChange={(e) => setEdit((p) => ({ ...p, quantityKg: e.target.value }))} />
            </Field>
            <Field label="Container number" htmlFor="editCtr">
              <Input id="editCtr" className="font-mono" value={edit.containerNumber} onChange={(e) => setEdit((p) => ({ ...p, containerNumber: e.target.value }))} />
            </Field>
            <Field label="Lot number" htmlFor="editLot">
              <Input id="editLot" value={edit.lotNumber} onChange={(e) => setEdit((p) => ({ ...p, lotNumber: e.target.value }))} />
            </Field>
            <Field label="Batch number" htmlFor="editBatch">
              <Input id="editBatch" value={edit.batchNumber} onChange={(e) => setEdit((p) => ({ ...p, batchNumber: e.target.value }))} />
            </Field>
          </div>
          <Field label="Reason" htmlFor="editReason" hint="Kept with the old and new values.">
            <Textarea id="editReason" value={edit.reason} onChange={(e) => setEdit((p) => ({ ...p, reason: e.target.value }))} placeholder="Correction before final receipt" />
          </Field>
        </div>
      }
    />
  );
}
