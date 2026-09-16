'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { quickCreateAgentAction } from '@/server/actions/master-actions';

export type CreatedAgent = {
  value: string;
  label: string;
  hint?: string;
  keywords?: string;
};

/**
 * Add an agent without leaving the receipt.
 *
 * Collection agents are master data, not names written into the voucher.
 * When a cheque is handed to someone who is not yet on the list, the name,
 * an optional phone number and an optional note are enough to create them
 * and select them immediately.
 */
export function AddAgentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: CreatedAgent) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <AddAgentBody
          onClose={() => onOpenChange(false)}
          onCreated={(agent) => {
            onCreated(agent);
            onOpenChange(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function AddAgentBody({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (agent: CreatedAgent) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [agentName, setAgentName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [notes, setNotes] = React.useState('');

  function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (pending) return;
    setError(null);
    if (!agentName.trim()) {
      setError('Enter the agent name.');
      return;
    }

    startTransition(async () => {
      const result = await quickCreateAgentAction(
        JSON.stringify({
          agentName: agentName.trim(),
          phone: phone.trim(),
          notes: notes.trim(),
        }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`${result.data.agentName} added.`);
      onCreated({
        value: result.data.id,
        label: result.data.agentName,
        hint: result.data.agentCode,
        keywords: result.data.agentCode,
      });
    });
  }

  return (
    <DialogContent
      title="Add new agent"
      description="The name is enough. They can collect from customers as soon as you save."
    >
      <form onSubmit={submit} className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Field label="Agent name" htmlFor="newAgentName" required>
          <Input
            id="newAgentName"
            autoFocus
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
          />
        </Field>

        <Field label="Phone" htmlFor="newAgentPhone" hint="Optional.">
          <Input
            id="newAgentPhone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>

        <Field label="Notes" htmlFor="newAgentNotes" hint="Optional.">
          <Textarea
            id="newAgentNotes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        </Field>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
