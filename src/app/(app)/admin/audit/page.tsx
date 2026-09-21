import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS, type BadgeTone } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatDateTime, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { AuditClient, type AuditRow } from '@/app/(app)/admin/audit/audit-client';
import { ServerPagination } from '@/components/shared/server-pagination';
import { cn } from '@/lib/utils';

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

/**
 * Sign-ins bury everything else.
 *
 * Every sign-in is recorded, correctly — an audit trail that omitted them
 * would be no use to a security review. But they outnumber everything else by
 * an order of magnitude: a demo company had 448 entries and the whole of the
 * first page was `User Login`. Someone opening this page to find out who
 * reversed an invoice was reading a list of sign-ins.
 *
 * So the entries stay and the page gains a filter. "Everything" remains the
 * default, because an audit log that hides records by default is not one; one
 * click separates what people did to the books from who came and went.
 */
/*
 * Access events: who came in, and which set of books they opened.
 *
 * Switching company is the same kind of event as signing in — it says where
 * somebody was, not what they changed — and it happens often enough that
 * leaving it among the document changes filled page one with it, which is the
 * very thing this split exists to prevent.
 */
const ACCESS_ACTIONS = ['USER_LOGIN', 'USER_LOGOUT', 'PIN_LOGIN', 'PIN_LOCKED', 'COMPANY_SWITCHED'];

const VIEWS = [
  { key: 'all', label: 'Everything' },
  { key: 'documents', label: 'Documents & changes' },
  { key: 'access', label: 'Sign-ins & access' },
] as const;

type ViewKey = (typeof VIEWS)[number]['key'];

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; view?: string }>;
}) {
  const user = await requirePageAccess(PERMISSIONS.AUDIT_VIEW);

  // The trail is append-only and never pruned, so it pages in the database.
  const query = await searchParams;
  const requested = Number(query.page ?? '1');
  const page = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) - 1 : 0;
  const view: ViewKey = VIEWS.some((v) => v.key === query.view) ? (query.view as ViewKey) : 'all';

  /*
   * Company data stays with its company; access events belong to the person
   * and are recorded without one, so they appear here whichever company is
   * open. Nothing financial is company-less, so this cannot leak one
   * company's figures into the other's trail.
   */
  const where = {
    ...(view === 'access'
      ? { OR: [{ companyId: user.activeCompany.id }, { companyId: null }], action: { in: ACCESS_ACTIONS as never } }
      : view === 'documents'
        ? { companyId: user.activeCompany.id, action: { notIn: ACCESS_ACTIONS as never } }
        : { OR: [{ companyId: user.activeCompany.id }, { companyId: null }] }),
  };

  const total = await prisma.auditLog.count({ where });

  const logs = await prisma.auditLog.findMany({
    where,
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
    // The stored action is never rewritten — it is the record. What is shown
    // uses the word the rest of the application uses, so an administrator
    // reading the log sees the same event they performed.
    actionLabel: titleCase(log.action.replace(/_REVERSED$/, '_DELETED').replace(/^REVERSAL_/, 'DELETION_')),
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
        description="Who did what, and when. Postings, deletions, stock adjustments, status changes and access changes are all recorded."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Audit Log' }]}
        meta={<span className="text-xs text-ink-subtle">{total.toLocaleString()} {view === 'all' ? 'entries' : 'matching entries'} for {user.activeCompany.name}.</span>}
      />
      <div className="inline-flex rounded-lg border border-line-strong p-0.5">
        {VIEWS.map((option) => (
          <Link
            key={option.key}
            href={option.key === 'all' ? '/admin/audit' : `/admin/audit?view=${option.key}`}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              view === option.key ? 'bg-forest-800 text-white' : 'text-ink-muted hover:text-ink',
            )}
          >
            {option.label}
          </Link>
        ))}
      </div>

      <AuditClient rows={rows} />

      <ServerPagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/admin/audit"
        params={{ view: view === 'all' ? undefined : view }}
      />
    </div>
  );
}
