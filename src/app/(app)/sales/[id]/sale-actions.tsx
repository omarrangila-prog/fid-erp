'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { CheckCircle2, Trash2, Pencil, Banknote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { postSalesInvoiceAction, deleteSalesInvoiceAction } from '@/server/actions/trading-actions';

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
  const [confirm, setConfirm] = React.useState<'post' | null>(null);
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

  const canCancel =
    status === 'DRAFT'
      ? canDelete
      : status === 'POSTED'
        ? canDelete || canReverse
        : status === 'REVERSED'
          ? canDelete || canReverse
          : false;

  return (
    <>
      {status === 'DRAFT' || status === 'POSTED' ? (
        canEdit ? (
          <Button variant="outline" asChild>
            <Link href={`/sales/${id}/edit`}>
              <Pencil />
              Edit Invoice
            </Link>
          </Button>
        ) : null
      ) : null}

      {status === 'DRAFT' && canApprove ? (
        <Button variant="accent" onClick={() => setConfirm('post')} loading={busy}>
          <CheckCircle2 />
          Post invoice
        </Button>
      ) : null}

      {canCancel ? (
        <InvoiceDeleteButton
          id={id}
          status={status}
          disabled={busy}
          onDeleted={() => {
            toast.success(
              status === 'POSTED'
                ? 'Invoice cancelled and removed. Stock, customer balance and the ledger have been reversed.'
                : status === 'REVERSED'
                  ? 'Cancelled invoice removed from the list. Journals and stock history are unchanged.'
                  : 'Invoice deleted.',
            );
            router.push('/sales');
          }}
        />
      ) : null}

      {status === 'POSTED' && canReceipt && outstanding ? (
        <Button asChild>
          <Link href={`/finance/receipts/new?invoice=${id}`}>
            <Banknote />
            Record payment
          </Link>
        </Button>
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
    </>
  );
}

/**
 * Delete on every invoice. Drafts are removed. Posted invoices are reversed
 * and then taken off the sales list. Already-cancelled invoices are removed
 * from the list; journals and stock history stay.
 */
export function InvoiceDeleteButton({
  id,
  status,
  disabled,
  onDeleted,
}: {
  id: string;
  status: string;
  disabled?: boolean;
  onDeleted?: (result: { status: 'DELETED' | 'REVERSED' }) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const posted = status === 'POSTED';
  const reversed = status === 'REVERSED';

  return (
    <>
      <Button
        type="button"
        variant={posted || reversed ? 'outline' : 'ghost'}
        size="sm"
        disabled={disabled || busy}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <Trash2 />
        Delete invoice
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={
          posted
            ? 'Delete this posted invoice?'
            : reversed
              ? 'Remove this cancelled invoice?'
              : 'Delete this draft?'
        }
        description={
          posted
            ? 'Stock returns to the warehouse it left, the customer balance is reversed, and a contra journal is written so the ledger stays in balance. The cancelled document is then removed from Sales. Journals stay in the books.'
            : reversed
              ? 'Removes this cancelled invoice from Sales. Journals, stock movements and reversing entries stay in the books — they are not deleted.'
              : 'The stock this draft was holding is released back to the warehouse.'
        }
        confirmLabel={reversed ? 'Remove from list' : posted ? 'Delete invoice' : 'Delete draft'}
        variant="danger"
        requireReason={posted}
        reasonLabel="Why is this invoice being deleted?"
        onConfirm={async (reason) => {
          setBusy(true);
          try {
            const result = await deleteSalesInvoiceAction(id, posted ? reason : undefined);
            if (!result.ok) {
              throw new Error(result.error ?? 'The invoice could not be deleted.');
            }
            if (onDeleted) onDeleted(result.data);
            else {
              toast.success(
                reversed
                  ? 'Cancelled invoice removed from the list.'
                  : result.data.status === 'DELETED'
                    ? 'Invoice deleted.'
                    : 'Invoice cancelled.',
              );
              router.push('/sales');
              router.refresh();
            }
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
