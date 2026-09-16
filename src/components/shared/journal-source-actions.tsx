import Link from 'next/link';
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

  return (
    <div className="flex flex-wrap justify-end gap-x-2 gap-y-1 text-xs">
      <Link href={view} className="font-medium text-forest-800 hover:text-gold-700">
        View source
      </Link>
      {edit && edit !== view ? (
        <Link href={edit} className="text-ink-muted hover:text-gold-700">
          Edit source
        </Link>
      ) : null}
    </div>
  );
}
