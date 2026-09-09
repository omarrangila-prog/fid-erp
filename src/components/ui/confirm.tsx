'use client';

import * as React from 'react';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';

/**
 * Confirmation before anything irreversible. When `requireReason` is set the
 * user must type a reason, which is stored on the reversal and in the audit log
 * — reversing a posted document is never anonymous.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  // Remounting on each open resets the reason and error without an effect, so
  // a half-typed reason from a previous confirmation can never leak through.
  return <ConfirmDialogBody key={props.open ? 'open' : 'closed'} {...props} />;
}

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  variant?: 'primary' | 'danger' | 'accent';
  requireReason?: boolean;
  reasonLabel?: string;
  /** Extra fields to collect alongside the confirmation, e.g. a reference. */
  body?: React.ReactNode;
  onConfirm: (reason: string) => Promise<void> | void;
};

function ConfirmDialogBody({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  variant = 'primary',
  requireReason = false,
  reasonLabel = 'Reason',
  body,
  onConfirm,
}: ConfirmDialogProps) {
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleConfirm() {
    if (requireReason && reason.trim().length < 3) {
      setError('Please give a reason of at least 3 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The action could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        {body}
        {requireReason ? (
          <Field label={reasonLabel} required error={error ?? undefined}>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why this is being reversed. This is recorded in the audit log."
            />
          </Field>
        ) : error ? (
          <p className="text-xs font-medium text-red-600">{error}</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant={variant} onClick={handleConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
