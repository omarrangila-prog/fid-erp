'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { CheckCircle2, Trash2, Pencil, PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DeleteShipmentButton } from '@/components/shipments/delete-shipment-button';
import { ConfirmDialog } from '@/components/ui/confirm';
import {
  postPurchaseContractAction,
  deletePurchaseContractAction,
} from '@/server/actions/trading-actions';

export function PurchaseActions({
  id,
  status,
  canApprove,
  canEdit,
  canDelete,
  canReverse,
  canReceive,
  fullyReceived,
  onReceive,
  reference,
}: {
  id: string;
  /** The order's reference, for the delete window's title. */
  reference?: string;
  status: string;
  canApprove: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReverse: boolean;
  canReceive: boolean;
  fullyReceived: boolean;
  /** Some coffee is already in stock. Kept for the callers; editing no longer depends on it. */
  anyReceived?: boolean;
  onReceive: () => void;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState<'approve' | 'delete' | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setBusy(true);
    try {
      const result = await fn();
      if (result.ok) {
        toast.success(success);
        router.refresh();
      } else {
        toast.error(result.error ?? 'The action could not be completed.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {status === 'DRAFT' ? (
        <>
          {canEdit ? (
            <Button variant="outline" asChild>
              <Link href={`/purchases/${id}/edit`}>
                <Pencil />
                Edit
              </Link>
            </Button>
          ) : null}
          {canDelete ? (
            <Button variant="ghost" onClick={() => setConfirm('delete')} disabled={busy}>
              <Trash2 />
              Delete
            </Button>
          ) : null}
          {canApprove ? (
            <Button variant="accent" onClick={() => setConfirm('approve')} loading={busy}>
              <CheckCircle2 />
              Approve &amp; post
            </Button>
          ) : null}
        </>
      ) : null}

      {status === 'POSTED' ? (
        <>
          {/*
            Every field of an approved order can be corrected where it stands,
            received or not; the edit page keeps the coffee and kilograms of a
            received container as the warehouse counted them. It moves the
            books, so it is for the people who may approve an order.
          */}
          {canEdit && canApprove ? (
            <Button variant="outline" asChild>
              <Link href={`/purchases/${id}/edit`}>
                <Pencil />
                Edit
              </Link>
            </Button>
          ) : null}
          {canReverse ? (
            // The same Delete Shipment window as everywhere else: it undoes the
            // receipts and costs it must, and here it offers to delete the order too.
            <DeleteShipmentButton contractId={id} label={reference ?? 'this order'} defaultMode="delete-order" after="/purchases">
              Delete
            </DeleteShipmentButton>
          ) : null}
          {canReceive && !fullyReceived ? (
            <Button onClick={onReceive}>
              <PackagePlus />
              Receive goods
            </Button>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={confirm === 'approve'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Approve and post this contract?"
        description="This creates the supplier payable, opens the job and creates the lots, batches and containers. The coffee is recorded as in transit — it will not be in a warehouse until you receive it."
        confirmLabel="Approve and post"
        variant="accent"
        onConfirm={() => run(() => postPurchaseContractAction(id), 'Contract approved and posted.')}
      />

      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Delete this draft?"
        description="Draft contracts have no ledger impact, so this removes it entirely."
        confirmLabel="Delete draft"
        variant="danger"
        onConfirm={async () => {
          await run(() => deletePurchaseContractAction(id), 'Draft deleted.');
          router.push('/purchases');
        }}
      />
    </>
  );
}
