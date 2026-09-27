/**
 * A pre-formatted amount with its equivalent underneath — the list-table form
 * of DualAmount, for rows built on the server. The same look: the
 * transaction's own currency strong, the equivalent small and muted.
 */
export function DualText({
  primary,
  equivalent,
  className,
}: {
  primary: string;
  equivalent?: { text: string; title: string } | null;
  className?: string;
}) {
  return (
    <span className={className}>
      <span className="tnum block font-medium">{primary}</span>
      {equivalent ? (
        <span className="tnum block text-[11px] font-normal text-ink-subtle" title={equivalent.title}>
          {equivalent.text}
        </span>
      ) : null}
    </span>
  );
}
