'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Truck, PackageCheck, Pencil, Trash2, Undo2, X, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import {
  advanceStockTransferAction,
  deleteStockTransferAction,
  reverseStockTransferAction,
  correctStockTransferAction,
} from '@/server/actions/trading-actions';

type Pending = 'delete' | 'cancel' | 'reverse' | 'correct' | null;

/**
 * Every action a transfer allows at its stage, and nothing it does not.
 *
 *   Draft       Edit · Approve · Delete
 *   Approved    Dispatch · Receive · Cancel (releases the reserved stock)
 *   In transit  Receive · Cancel
 *   Received    Correct (moves the stock back and opens a new draft) · Reverse
 *   Cancelled   —
 *
 * A received transfer's movements are never rewritten: correcting or
 * reversing it posts a matched move back, so out always equals in.
 */
export function TransferActions({ id, label, state, canManage }: { id: string; label: string; state: string; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState<Pending>(null);
  if (!canManage) return null;

  async function advance(to: 'APPROVED' | 'IN_TRANSIT' | 'RECEIVED') {
    setBusy(true);
    try {
      const result = await advanceStockTransferAction(id, to);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(to === 'RECEIVED' ? 'Stock moved.' : to === 'APPROVED' ? 'Transfer approved and stock reserved.' : 'Transfer dispatched.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const dialog = {
    delete: { title: `Delete ${label}?`, description: 'A draft moves no stock, so it is removed and its number is issued again.', confirmLabel: 'Delete draft', requireReason: false },
    cancel: { title: `Cancel ${label}?`, description: 'The stock it reserved is released back to the source warehouse. The transfer stays on the list as cancelled.', confirmLabel: 'Cancel transfer', requireReason: true },
    reverse: { title: `Reverse ${label}?`, description: 'Every line is moved back from the destination to the source as a matched pair. The original movements stay in the history.', confirmLabel: 'Reverse transfer', requireReason: true },
    correct: { title: `Correct ${label}?`, description: 'The stock is moved back, this transfer is kept as reversed, and a new draft with the same lines opens for you to change and receive again.', confirmLabel: 'Move back and open a draft', requireReason: true },
  } as const;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {state === 'DRAFT' ? (
        <>
          <Button asChild variant="outline" size="sm">
            <Link href={`/inventory/transfers/${id}/edit`}>
              <Pencil />
              Edit
            </Link>
          </Button>
          <Button size="sm" onClick={() => advance('APPROVED')} loading={busy}>
            <Check />
            Approve
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPending('delete')}>
            <Trash2 className="text-red-500" />
            Delete
          </Button>
        </>
      ) : null}
      {state === 'APPROVED' ? (
        <Button variant="outline" size="sm" onClick={() => advance('IN_TRANSIT')} loading={busy}>
          <Truck />
          Dispatch
        </Button>
      ) : null}
      {state === 'APPROVED' || state === 'IN_TRANSIT' ? (
        <>
          <Button variant="accent" size="sm" onClick={() => advance('RECEIVED')} loading={busy}>
            <PackageCheck />
            Receive
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPending('cancel')}>
            <X className="text-red-500" />
            Cancel
          </Button>
        </>
      ) : null}
      {state === 'RECEIVED' ? (
        <>
          <Button variant="outline" size="sm" onClick={() => setPending('correct')}>
            <Wrench />
            Correct
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPending('reverse')}>
            <Undo2 className="text-red-500" />
            Reverse
          </Button>
        </>
      ) : null}

      {pending ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setPending(null)}
          title={dialog[pending].title}
          description={dialog[pending].description}
          confirmLabel={dialog[pending].confirmLabel}
          variant="danger"
          requireReason={dialog[pending].requireReason}
          reasonLabel="Why?"
          onConfirm={async (reason) => {
            if (pending === 'delete') {
              const result = await deleteStockTransferAction(id);
              if (!result.ok) throw new Error(result.error);
              toast.success(`${label} deleted.`);
              router.push('/inventory/transfers');
              return;
            }
            if (pending === 'cancel') {
              const result = await advanceStockTransferAction(id, 'CANCELLED', reason);
              if (!result.ok) throw new Error(result.error);
              toast.success(`${label} cancelled; the reserved stock is free again.`);
              setPending(null);
              router.refresh();
              return;
            }
            if (pending === 'reverse') {
              const result = await reverseStockTransferAction(id, reason);
              if (!result.ok) throw new Error(result.error);
              toast.success(`${label} reversed; the stock is back where it came from.`);
              setPending(null);
              router.refresh();
              return;
            }
            const result = await correctStockTransferAction(id, reason);
            if (!result.ok) throw new Error(result.error);
            toast.success(`${label} moved back. Change the new draft and receive it again.`);
            router.push(`/inventory/transfers/${result.data.id}/edit`);
          }}
        />
      ) : null}
    </div>
  );
}
