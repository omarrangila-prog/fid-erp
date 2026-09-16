'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { CheckCircle2, Trash2, Pencil, Banknote, MoreHorizontal } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { postSalesInvoiceAction, deleteSalesInvoiceAction } from '@/server/actions/trading-actions';

export function canCancelSalesInvoice(
  status: string,
  perms: { canDelete: boolean; canReverse: boolean; canEdit?: boolean; canApprove?: boolean },
): boolean {
  if (status === 'DRAFT') return perms.canDelete || Boolean(perms.canEdit);
  if (status === 'POSTED' || status === 'REVERSED') {
    return perms.canDelete || perms.canReverse || Boolean(perms.canApprove);
  }
  return false;
}

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

  const canCancel = canCancelSalesInvoice(status, { canDelete, canReverse, canEdit, canApprove });

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
 * Actions menu on each sales row: Edit and Delete invoice.
 * The table is wide; this keeps delete on a single dropdown that stays in view.
 */
export function InvoiceActionsMenu({
  id,
  status,
  canEdit,
  canDelete,
  canReverse,
  canApprove,
}: {
  id: string;
  status: string;
  canEdit: boolean;
  canDelete: boolean;
  canReverse: boolean;
  canApprove?: boolean;
}) {
  const router = useRouter();
  const showEdit = canEdit && (status === 'DRAFT' || status === 'POSTED');
  const canCancel = canCancelSalesInvoice(status, { canDelete, canReverse, canEdit, canApprove });
  if (!showEdit && !canCancel) return null;

  return (
    <div
      className="flex justify-end"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Invoice actions"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <MoreHorizontal />
            Actions
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            data-fid-pop
            align="end"
            sideOffset={4}
            className="animate-in-soft z-50 min-w-48 rounded-lg border border-line bg-surface p-1 shadow-lg"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {showEdit ? (
              <DropdownMenu.Item asChild>
                <Link
                  href={`/sales/${id}/edit`}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none hover:bg-forest-50 data-[highlighted]:bg-forest-50"
                >
                  <Pencil className="size-4" />
                  Edit invoice
                </Link>
              </DropdownMenu.Item>
            ) : null}
            {canCancel ? <InvoiceDeleteButton id={id} status={status} appearance="menu" /> : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
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
  appearance = 'button',
  onDeleted,
}: {
  id: string;
  status: string;
  disabled?: boolean;
  appearance?: 'button' | 'menu';
  onDeleted?: (result: { status: 'DELETED' | 'REVERSED' }) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const posted = status === 'POSTED';
  const reversed = status === 'REVERSED';

  function openConfirm(event?: React.SyntheticEvent) {
    event?.preventDefault();
    event?.stopPropagation();
    setOpen(true);
  }

  const dialog = (
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
  );

  if (appearance === 'menu') {
    return (
      <>
        <DropdownMenu.Item
          disabled={disabled || busy}
          className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-red-700 outline-none hover:bg-red-50 data-[highlighted]:bg-red-50 data-[disabled]:opacity-50"
          onSelect={(event) => {
            event.preventDefault();
            openConfirm();
          }}
        >
          <Trash2 className="size-4" />
          Delete invoice
        </DropdownMenu.Item>
        {dialog}
      </>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled || busy}
        className="border-red-200 text-red-700 hover:border-red-300 hover:bg-red-50 hover:text-red-800"
        onClick={openConfirm}
      >
        <Trash2 />
        Delete invoice
      </Button>
      {dialog}
    </>
  );
}
