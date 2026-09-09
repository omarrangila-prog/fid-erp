'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CheckCircle2, Undo2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import {
  postReceiptAction, reverseReceiptAction, deleteReceiptAction,
  postPaymentAction, reversePaymentAction, deletePaymentAction,
  postExpenseAction, reverseExpenseAction, deleteExpenseAction,
} from '@/server/actions/finance-actions';

/**
 * Post / reverse / delete for the three cash-cycle vouchers.
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
      'A contra journal entry is written and any invoices this receipt settled become outstanding again. Nothing is deleted.',
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
      'A contra journal entry is written and any contracts this payment settled become outstanding again.',
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
      'Any landed cost this expense added is unwound from the batches, and a contra journal entry is written.',
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
          <Undo2 />
          Reverse
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
        title={`Reverse this ${config.label}?`}
        description={config.reverseDescription}
        confirmLabel={`Reverse ${config.label}`}
        variant="danger"
        requireReason
        reasonLabel="Why is this being reversed?"
        onConfirm={(reason) => run(() => config.reverse(id, reason), 'Reversed.')}
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
