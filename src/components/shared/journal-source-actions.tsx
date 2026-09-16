import { Eye, Pencil } from 'lucide-react';
import { RowActions } from '@/components/shared/row-actions';
import { journalSourceEditHref, journalSourceHref } from '@/lib/journal-source';

/** View / Edit source for a derived ledger, cash-book or GL row. */
export function JournalSourceActions({
  sourceType,
  sourceId,
  entryNumber,
}: {
  sourceType: string;
  sourceId?: string | null;
  entryNumber?: string;
}) {
  const view = journalSourceHref(sourceType, sourceId ?? '', { entryNumber });
  const edit = sourceId ? journalSourceEditHref(sourceType, sourceId) : null;
  if (!view) return <span className="text-ink-subtle">—</span>;

  /*
   * A ledger line is derived: it exists because a document was posted, and it
   * is never edited on its own — that would put the ledger out of step with
   * the document it came from. So the actions go to the source: the invoice,
   * the expense, the journal voucher. Cancelling is offered there too, where
   * the consequences can be stated properly.
   */
  return (
    <RowActions
      inline={1}
      actions={[
        { label: 'View source', href: view, icon: Eye },
        { label: 'Edit source', href: edit ?? view, icon: Pencil, show: Boolean(edit && edit !== view) },
      ]}
    />
  );
}
