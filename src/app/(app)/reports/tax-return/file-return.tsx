'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { FileCheck2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/confirm';
import { fileTaxReturnAction } from '@/server/actions/compliance-actions';

export function FileReturnButton({
  from,
  to,
  reconciled,
  netPayable,
  currency,
}: {
  from: string;
  to: string;
  reconciled: boolean;
  netPayable: string;
  currency: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [reference, setReference] = React.useState('');

  return (
    <>
      <Button
        size="sm"
        variant="accent"
        disabled={!reconciled}
        title={reconciled ? undefined : 'The return does not agree with the ledger yet'}
        onClick={() => setOpen(true)}
      >
        <FileCheck2 />
        Record as filed
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Record ${from} to ${to} as filed?`}
        description={`The figures are frozen as submitted, so a later correction shows up as a difference rather than silently rewriting what the authority has already seen. Net ${netPayable} ${currency}.`}
        confirmLabel="Record as filed"
        body={
          <Field label="Submission reference" hint="The acknowledgement number from the portal, if you have it.">
            <Input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={60} />
          </Field>
        }
        onConfirm={async () => {
          const result = await fileTaxReturnAction(JSON.stringify({ from, to, reference }));
          if (result?.ok) {
            toast.success('Return recorded as filed.');
            router.refresh();
          } else {
            throw new Error(result?.error ?? 'That could not be recorded.');
          }
        }}
      />
    </>
  );
}
