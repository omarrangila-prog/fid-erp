'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { CheckCircle2, Undo2, Trash2, Pencil, Banknote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import {
  postSalesInvoiceAction,
  reverseSalesInvoiceAction,
  deleteSalesInvoiceAction,
} from '@/server/actions/trading-actions';

export function SaleActions({
  id,
  status,
  outstanding,
  canApprove,
  canEdit,
  canDelete,
  canReverse,
  canReceipt,
}: {
  id: string;
  status: string;
  outstanding: boolean;
  canApprove: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReverse: boolean;
  canReceipt: boolean;
}) {
  const router = useRouter();
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
          {canEdit ? (
            <Button variant="outline" asChild>
              <Link href={`/sales/${id}/edit`}>
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
            <Button variant="accent" onClick={() => setConfirm('post')} loading={busy}>
              <CheckCircle2 />
              Post invoice
            </Button>
          ) : null}
        </>
      ) : null}

      {status === 'POSTED' ? (
        <>
          {canReverse ? (
            <Button variant="outline" onClick={() => setConfirm('reverse')} disabled={busy}>
              <Undo2 />
              Reverse
            </Button>
          ) : null}
          {canReceipt && outstanding ? (
            <Button asChild>
              <Link href={`/finance/receipts/new?invoice=${id}`}>
                <Banknote />
                Record payment
              </Link>
            </Button>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={confirm === 'post'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Post this invoice?"
        description="Stock is relieved from the named batch and warehouse, cost of goods sold is recorded at the batch's landed cost, and the customer receivable is raised. All of it happens together or not at all."
        confirmLabel="Post invoice"
        variant="accent"
        onConfirm={() => run(() => postSalesInvoiceAction(id), 'Invoice posted.')}
      />

      <ConfirmDialog
        open={confirm === 'reverse'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Reverse this invoice?"
        description="The stock goes back to the warehouse it came from and a contra journal entry is written. This is refused if a receipt has been allocated to the invoice."
        confirmLabel="Reverse invoice"
        variant="danger"
        requireReason
        reasonLabel="Why is this being reversed?"
        onConfirm={(reason) => run(() => reverseSalesInvoiceAction(id, reason), 'Invoice reversed.')}
      />

      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Delete this draft?"
        description="The stock this draft was holding is released back to the warehouse."
        confirmLabel="Delete draft"
        variant="danger"
        onConfirm={async () => {
          await run(() => deleteSalesInvoiceAction(id), 'Draft deleted.');
          router.push('/sales');
        }}
      />
    </>
  );
}
