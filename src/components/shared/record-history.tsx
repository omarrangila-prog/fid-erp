import { prisma } from '@/lib/db';
import { formatDateTime } from '@/lib/format';

/**
 * Who did what to this document, and when.
 *
 * With several people entering on their own PINs, the owner needs to see who
 * raised a document, who last changed it and who posted it. Read from the
 * audit trail every document already writes, so it covers what happened
 * before this line existed as well.
 */
export async function RecordHistory({ entityType, entityId }: { entityType: string; entityId: string }) {
  const events = await prisma.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'asc' },
    select: { action: true, createdAt: true, user: { select: { name: true } } },
  });
  const find = (pattern: RegExp, which: 'first' | 'last') => {
    const matches = events.filter((e) => pattern.test(e.action));
    return which === 'first' ? matches[0] : matches[matches.length - 1];
  };
  const steps = [
    ['Created', find(/_CREATED$/, 'first')],
    ['Last edited', find(/_(UPDATED|EDITED|CORRECTED)$/, 'last')],
    ['Posted', find(/_POSTED$/, 'last')],
    // Said the way the client says it everywhere: a posted document is deleted, never "reversed".
    ['Deleted', find(/_(REVERSED|CANCELLED|DELETED)$/, 'last')],
  ] as const;
  const shown = steps.filter(([, event]) => event);
  if (shown.length === 0) return null;

  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted" data-testid="record-history" data-print="hide">
      {shown.map(([label, event]) => (
        <span key={label}>
          {label} by <span className="font-medium text-ink">{event!.user?.name ?? 'the system'}</span> ·{' '}
          {formatDateTime(event!.createdAt)}
        </span>
      ))}
    </p>
  );
}
