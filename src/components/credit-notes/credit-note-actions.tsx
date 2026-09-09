'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CheckCircle2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { postCreditNoteAction, reverseCreditNoteAction } from '@/server/actions/compliance-actions';

export function CreditNoteActions({
  id,
  number,
  status,
  returnsStock,
  basePath,
}: {
  id: string;
  number: string;
  status: string;
  returnsStock: boolean;
  basePath: string;
}) {
  const router = useRouter();
  const [posting, setPosting] = React.useState(false);
  const [confirmPost, setConfirmPost] = React.useState(false);
  const [confirmReverse, setConfirmReverse] = React.useState(false);

  return (
    <>
      {status === 'DRAFT' ? (
        <Button size="sm" variant="accent" loading={posting} onClick={() => setConfirmPost(true)}>
          <CheckCircle2 />
          Post
        </Button>
      ) : null}
      {status === 'POSTED' ? (
        <Button size="sm" variant="outline" onClick={() => setConfirmReverse(true)}>
          <Undo2 />
          Reverse
        </Button>
      ) : null}

      <ConfirmDialog
        open={confirmPost}
        onOpenChange={setConfirmPost}
        title={`Post ${number}?`}
        description={
          returnsStock
            ? 'The party ledger is credited, the coffee comes back into the warehouse at its landed cost, and the same cost is taken back out of cost of sales.'
            : 'The party ledger is credited and the amount is recorded against returns rather than netted into revenue.'
        }
        confirmLabel="Post"
        onConfirm={async () => {
          setPosting(true);
          try {
            const result = await postCreditNoteAction(id);
            if (result.ok) {
              toast.success(`${number} posted.`);
              router.refresh();
            } else {
              throw new Error(result.error);
            }
          } finally {
            setPosting(false);
          }
        }}
      />

      <ConfirmDialog
        open={confirmReverse}
        onOpenChange={setConfirmReverse}
        title={`Reverse ${number}?`}
        description={
          returnsStock
            ? 'A contra entry is written and the coffee this note brought back is taken out of the warehouse again. If it has since been sold on, the reversal will be refused.'
            : 'A contra entry is written. Nothing is deleted — both documents stay in the history.'
        }
        confirmLabel="Reverse"
        variant="danger"
        requireReason
        reasonLabel="Why is this being reversed?"
        onConfirm={async (reason) => {
          const result = await reverseCreditNoteAction(id, reason ?? '');
          if (result.ok) {
            toast.success(`${number} reversed.`);
            router.push(basePath);
            router.refresh();
          } else {
            throw new Error(result.error);
          }
        }}
      />
    </>
  );
}
