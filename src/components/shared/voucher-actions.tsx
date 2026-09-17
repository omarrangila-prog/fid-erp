'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CheckCircle2, Trash2, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { HandCoins } from 'lucide-react';
import { RowActions, viewAction, editAction } from '@/components/shared/row-actions';
import {
  postReceiptAction, reverseReceiptAction, deleteReceiptAction,
  postPaymentAction, reversePaymentAction, deletePaymentAction,
  postExpenseAction, reverseExpenseAction, deleteExpenseAction,
} from '@/server/actions/finance-actions';

/**
 * Post / delete for the three cash-cycle vouchers.
 *
 * They share one component because they share one lifecycle: a draft has no
 * ledger impact and can be deleted; a posted voucher is corrected by reversal,
 * never by editing, and the reason is recorded.
 */

type Kind = 'receipt' | 'payment' | 'expense';

const ACTIONS: Record<
  Kind,
  {
    post: (id: string) => Promise<{ ok: boolean; error?: string }>;
    reverse: (id: string, reason: string) => Promise<{ ok: boolean; error?: string }>;
    remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
    listPath: string;
    label: string;
    postDescription: string;
    reverseDescription: string;
  }
> = {
  receipt: {
    post: postReceiptAction,
    reverse: reverseReceiptAction,
    remove: deleteReceiptAction,
    listPath: '/finance/receipts',
    label: 'receipt',
    postDescription:
      "The customer's ledger is credited in their own currency, the account the money landed in is increased by exactly what arrived, and the rate used is recorded on the voucher.",
    reverseDescription:
      'The money is taken back out of the account it landed in, and any invoices this receipt settled become outstanding again. The receipt disappears from every list and total.',
  },
  payment: {
    post: postPaymentAction,
    reverse: reversePaymentAction,
    remove: deletePaymentAction,
    listPath: '/finance/payments',
    label: 'payment',
    postDescription:
      "The supplier's payable is reduced in their own currency and the account the money left is decreased by exactly what was paid.",
    reverseDescription:
      'The money is put back in the account it left, and anything this payment settled becomes outstanding again. The payment disappears from every list and total.',
  },
  expense: {
    post: postExpenseAction,
    reverse: reverseExpenseAction,
    remove: deleteExpenseAction,
    listPath: '/finance/expenses',
    label: 'expense',
    postDescription:
      'A direct shipment cost is capitalised into the landed cost of the coffee — raising the value of stock still on hand and truing up the share already sold into cost of goods sold. A period cost goes straight to the profit and loss.',
    reverseDescription:
      'Any landed cost this expense added is taken back off the batches, and the cost is removed from the books. The expense disappears from every list and total.',
  },
};

export function VoucherActions({
  kind,
  id,
  status,
  canPost,
  canDelete,
}: {
  kind: Kind;
  id: string;
  status: string;
  canPost: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const config = ACTIONS[kind];
  const [confirm, setConfirm] = React.useState<'post' | 'reverse' | 'delete' | null>(null);
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
          {canDelete ? (
            <Button variant="ghost" onClick={() => setConfirm('delete')} disabled={busy}>
              <Trash2 />
              Delete
            </Button>
          ) : null}
          {canPost ? (
            <Button variant="accent" onClick={() => setConfirm('post')} loading={busy}>
              <CheckCircle2 />
              Post {config.label}
            </Button>
          ) : null}
        </>
      ) : null}

      {status === 'POSTED' && canPost ? (
        <Button variant="outline" onClick={() => setConfirm('reverse')} disabled={busy}>
          <Trash2 />
          Delete
        </Button>
      ) : null}

      <ConfirmDialog
        open={confirm === 'post'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Post this ${config.label}?`}
        description={config.postDescription}
        confirmLabel={`Post ${config.label}`}
        variant="accent"
        onConfirm={() => run(() => config.post(id), `${config.label[0].toUpperCase()}${config.label.slice(1)} posted.`)}
      />

      <ConfirmDialog
        open={confirm === 'reverse'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Delete this ${config.label}?`}
        description={config.reverseDescription}
        confirmLabel="Yes, delete"
        variant="danger"
        requireReason
        reasonLabel="Why is this being deleted?"
        onConfirm={(reason) => run(() => config.reverse(id, reason), 'Deleted.')}
      />

      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Delete this draft?"
        description="Drafts have no ledger impact, so this removes it entirely."
        confirmLabel="Delete draft"
        variant="danger"
        onConfirm={async () => {
          await run(() => config.remove(id), 'Draft deleted.');
          router.push(config.listPath);
        }}
      />
    </>
  );
}

/** Compact View / Edit / Delete-or-Reverse on a list row. */
export function VoucherRowActions({
  kind,
  id,
  status,
  canPost,
  canDelete,
  needsPayment = false,
}: {
  kind: Kind;
  id: string;
  status: string;
  canPost: boolean;
  canDelete: boolean;
  /** Only a cost with something still owing offers a way to pay it. */
  needsPayment?: boolean;
}) {
  const config = ACTIONS[kind];
  const viewPath = `${config.listPath}/${id}`;
  // A cost can be corrected whether or not it has been posted: posting is
  // undone and rewritten under the same number. Only a deleted one is closed.
  const editPath = kind === 'expense' && status !== 'CANCELLED' && status !== 'REVERSED' ? `${viewPath}/edit` : null;

  /*
   * Rendered through the shared row-action pattern, so a voucher row looks
   * and behaves like every other row in the application: the same actions in
   * the same place, the rest behind one menu, and Cancel asking the same
   * question in the same words.
   */
  return (
    <RowActions
      actions={[
        viewAction(viewPath),
        ...(editPath ? [editAction(editPath)] : []),
        ...(kind === 'expense' && status === 'POSTED' && needsPayment
          ? [{ label: 'Pay this cost', href: `/finance/payments/new?expense=${id}`, icon: HandCoins }]
          : []),
        // A new voucher pre-filled from this one, for the charge that comes
        // round every month. The original is never touched.
        ...(kind === 'expense' && status !== 'CANCELLED'
          ? [{ label: 'Clone', href: `${viewPath}/clone`, icon: Copy }]
          : []),
      ]}
      destructive={{
        status,
        noun: config.label,
        show: status === 'DRAFT' ? canDelete : status === 'POSTED' && canPost,
        description: config.reverseDescription,
        run: (reason) =>
          status === 'DRAFT' ? config.remove(id) : config.reverse(id, reason ?? ''),
      }}
    />
  );
}
