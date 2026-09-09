import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS, type BadgeTone } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatDateTime, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { AuditClient, type AuditRow } from '@/app/(app)/admin/audit/audit-client';
import { ServerPagination } from '@/components/shared/server-pagination';

export const metadata: Metadata = { title: 'Audit Log' };
export const dynamic = 'force-dynamic';

/** Reversals and deletions are the entries an auditor looks for first. */
function toneFor(action: string): BadgeTone {
  if (action.includes('REVERSED') || action.includes('DELETED') || action.includes('BOUNCED')) return 'danger';
  if (action.includes('POSTED') || action.includes('APPROVED') || action.includes('CLEARED')) return 'success';
  if (action.includes('CREATED')) return 'info';
  if (action.includes('LOGIN') || action.includes('LOGOUT')) return 'neutral';
  return 'warning';
}

const PAGE_SIZE = 100;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requirePageAccess(PERMISSIONS.AUDIT_VIEW);

  // The trail is append-only and never pruned, so it pages in the database.
  const requested = Number((await searchParams).page ?? '1');
  const page = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) - 1 : 0;
  const total = await prisma.auditLog.count({ where: { companyId: user.activeCompany.id } });

  const logs = await prisma.auditLog.findMany({
    where: { companyId: user.activeCompany.id },
    orderBy: { createdAt: 'desc' },
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
    include: { user: { select: { name: true, email: true } } },
  });

  const rows: AuditRow[] = logs.map((log) => ({
    id: log.id,
    when: formatDateTime(log.createdAt),
    whenSort: log.createdAt.getTime(),
    user: log.user?.name ?? 'System',
    action: log.action,
    actionLabel: titleCase(log.action),
    tone: toneFor(log.action),
    entityType: log.entityType,
    entityId: log.entityId,
    before: log.before ? JSON.stringify(log.before, null, 2) : null,
    after: log.after ? JSON.stringify(log.after, null, 2) : null,
    ipAddress: log.ipAddress,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Log"
        description="Who did what, and when. Postings, reversals, stock adjustments, status changes and access changes are all recorded."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Audit Log' }]}
        meta={<span className="text-xs text-ink-subtle">{total.toLocaleString()} entries recorded for {user.activeCompany.name}.</span>}
      />
      <AuditClient rows={rows} />

      <ServerPagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/admin/audit" />
    </div>
  );
}
