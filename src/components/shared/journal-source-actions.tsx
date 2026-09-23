'use client';

import { RowActions } from '@/components/shared/row-actions';
import { journalSourceEditHref, journalSourceHref } from '@/lib/journal-source';
import { deletePostedEntryAction } from '@/server/actions/finance-actions';

/** View / Edit / Delete for a derived ledger, cash-book or GL row. */
export function JournalSourceActions({
  sourceType,
  sourceId,
  entryNumber,
  journalEntryId,
  canDelete = false,
  isReversal = false,
}: {
  sourceType: string;
  sourceId?: string | null;
  entryNumber?: string;
  /** The entry behind this line, so the right one is deleted. */
  journalEntryId?: string | null;
  canDelete?: boolean;
  isReversal?: boolean;
}) {
  const view = journalSourceHref(sourceType, sourceId ?? '', { entryNumber });
  const edit = sourceId ? journalSourceEditHref(sourceType, sourceId) : null;
  if (!view) return <span className="text-ink-subtle">—</span>;

  /*
   * A ledger line is derived: it exists because a document was posted, and it
   * is never edited on its own — that would put the ledger out of step with
   * the document it came from. So Edit goes to the source: the invoice, the
   * cost, the journal voucher.
   *
   * Delete stays here, because it is the same act wherever it is asked for —
   * the entry is mirrored and disappears from every ledger and total — and
   * because a line somebody is looking at is exactly where they realise it
   * should not be there. A reversal is not deletable: undoing it would put
   * back what it took out.
   */
  return (
    <RowActions
      inline={1}
      actions={[
        { label: 'View source', href: view, icon: 'view' as const },
        { label: 'Edit source', href: edit ?? view, icon: 'edit' as const, show: Boolean(edit && edit !== view) },
      ]}
      destructive={
        canDelete && journalEntryId && !isReversal
          ? {
              status: 'POSTED',
              noun: 'entry',
              description:
                'The entry is mirrored, and both it and the reversal stay in the journal so the correction can be traced. It disappears from this ledger and from every report and total.',
              run: (reason) => deletePostedEntryAction(journalEntryId, reason ?? ''),
            }
          : undefined
      }
    />
  );
}
