/**
 * A memo in a table cell.
 *
 * Long memos are cut to one line so the table stays readable; the whole memo
 * is in the tooltip and in the row's detail. A note the system adds — "Collected
 * by RADOUAN" — sits under it in smaller type rather than being mixed into
 * what the person typed.
 */
export function MemoCell({
  memo,
  note,
  width = 'max-w-56',
}: {
  memo: string | null | undefined;
  note?: string | null;
  width?: string;
}) {
  const text = memo?.trim();
  if (!text && !note) return <span className="text-xs text-ink-subtle">—</span>;
  return (
    <span className={`block ${width}`} title={[text, note].filter(Boolean).join('\n')}>
      {text ? <span className="block truncate text-xs text-ink">{text}</span> : null}
      {note ? <span className="block truncate text-[11px] text-ink-subtle">{note}</span> : null}
    </span>
  );
}
