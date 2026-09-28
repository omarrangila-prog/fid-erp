import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/services/audit';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/lib/errors';
import type { Tx } from '@/lib/db';
import {
  CLIENT_SHARE_EVENTS,
  MAX_SNAPSHOT_BYTES,
  SHARE_ENTITY,
  SHARE_EVENTS,
  SHARE_EXPIRY,
  SHARE_METHOD_LABEL,
  isShareReportKey,
  shareMetaSchema,
  shareReportLabel,
  shareReportParty,
  shareSnapshotSchema,
  type ShareEvent,
  type ShareExpiry,
  type ShareMeta,
  type ShareSnapshot,
} from '@/lib/share/model';

/**
 * Secure report links and the record of every share.
 *
 * A link is a random token nobody can guess, handed out once. Only its hash
 * is stored, so the settings table itself cannot be read back into working
 * links. It opens one read-only copy of one report — no sign-in, no menu, no
 * other data — until it expires or somebody revokes it; revoking also deletes
 * the copy.
 *
 * The share log is the audit table, under its own entity type, and holds only
 * what was shared: which report, for whom, which dates and filters, how many
 * rows, how, and what happened. The report itself is never written into the
 * log.
 */

type Actor = { id: string; name: string; roleNames: string[]; isSuperAdmin: boolean; canManageUsers: boolean; isDeveloper: boolean };
type Client = { ip?: string | null; userAgent?: string | null };

const LINK_PREFIX = 'report_share:';
const DATA_PREFIX = 'report_share_data:';

export type ShareLinkMeta = {
  shareId: string;
  report: string;
  title: string;
  subject?: string;
  period?: string;
  rows: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByName: string | null;
  views: number;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
};

export function newShareId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(16);
  return `shr_${[...bytes].map((b) => alphabet[b % alphabet.length]).join('')}`;
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function expiryDate(expiry: ShareExpiry, from = new Date()): Date | null {
  if (expiry === 'never') return null;
  return new Date(from.getTime() + Number(expiry) * 24 * 60 * 60 * 1000);
}

/** Only the owner or an administrator may make a link that never expires. */
export function mayChooseNeverExpire(actor: Pick<Actor, 'isSuperAdmin' | 'canManageUsers'>): boolean {
  return actor.isSuperAdmin || actor.canManageUsers;
}

function statusOf(meta: ShareLinkMeta, now = new Date()): 'active' | 'expired' | 'revoked' {
  if (meta.revokedAt) return 'revoked';
  if (meta.expiresAt && new Date(meta.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

async function audit(tx: Tx, companyId: string, userId: string | null, event: ShareEvent, shareId: string, after: object, client?: Client) {
  await writeAudit(tx, {
    companyId,
    userId,
    action: event,
    entityType: SHARE_ENTITY,
    entityId: shareId,
    after,
    ipAddress: client?.ip ?? null,
    userAgent: client?.userAgent?.slice(0, 300) ?? null,
  });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export async function createShareLink(params: {
  actor: Actor;
  companyId: string;
  meta: ShareMeta;
  snapshot: ShareSnapshot;
  expiry: ShareExpiry;
  client?: Client;
}): Promise<{ token: string; shareId: string; expiresAt: string | null }> {
  const meta = shareMetaSchema.parse(params.meta);
  if (!isShareReportKey(meta.report)) throw new BusinessRuleError('This report cannot be shared.');
  const snapshot = shareSnapshotSchema.parse(params.snapshot);
  const value = JSON.stringify(snapshot);
  if (Buffer.byteLength(value, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new BusinessRuleError('This report is too large for a link. Narrow the dates or filters, or share it as a PDF.');
  }
  if (!SHARE_EXPIRY.includes(params.expiry)) throw new BusinessRuleError('Choose when the link expires.');
  if (params.expiry === 'never' && !mayChooseNeverExpire(params.actor)) {
    throw new ForbiddenError('Only the owner or an administrator can make a link that never expires.');
  }

  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = expiryDate(params.expiry, now)?.toISOString() ?? null;
  const link: ShareLinkMeta = {
    shareId: meta.shareId,
    report: meta.report,
    title: snapshot.title,
    subject: snapshot.subject,
    period: snapshot.period,
    rows: meta.rows,
    createdBy: params.actor.id,
    createdByName: params.actor.name,
    createdAt: now.toISOString(),
    expiresAt,
    revokedAt: null,
    revokedByName: null,
    views: 0,
    firstViewedAt: null,
    lastViewedAt: null,
  };

  await prisma.$transaction(async (tx) => {
    const taken = await tx.applicationSetting.findFirst({
      where: { companyId: params.companyId, key: `${DATA_PREFIX}${meta.shareId}` },
      select: { id: true },
    });
    if (taken) throw new BusinessRuleError('This share already has a link. Start the share again.');
    await tx.applicationSetting.create({ data: { companyId: params.companyId, key: `${LINK_PREFIX}${hashShareToken(token)}`, value: JSON.stringify(link) } });
    await tx.applicationSetting.create({ data: { companyId: params.companyId, key: `${DATA_PREFIX}${meta.shareId}`, value } });
    await audit(tx, params.companyId, params.actor.id, 'SHARE_LINK_GENERATED', meta.shareId, { status: SHARE_EVENTS.SHARE_LINK_GENERATED, expiresAt, expiry: params.expiry }, params.client);
  });

  return { token, shareId: meta.shareId, expiresAt };
}

export type ResolvedShare =
  | { status: 'active'; link: ShareLinkMeta; snapshot: ShareSnapshot }
  | { status: 'expired' | 'revoked' | 'missing' };

/**
 * What a recipient sees. A real view is counted and recorded; a link-preview
 * robot (WhatsApp fetches the page to draw its preview) is told nothing and
 * counts for nothing.
 */
export async function openShareLink(token: string, options: { countView: boolean; client?: Client }): Promise<ResolvedShare> {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(token)) return { status: 'missing' };
  const row = await prisma.applicationSetting.findFirst({
    where: { key: `${LINK_PREFIX}${hashShareToken(token)}` },
    select: { id: true, companyId: true, value: true },
  });
  const link = row ? parse<ShareLinkMeta>(row.value) : null;
  if (!row || !row.companyId || !link) return { status: 'missing' };

  const status = statusOf(link);
  if (status !== 'active') {
    if (options.countView) {
      await prisma.$transaction(async (tx) => {
        // An expired copy is not kept once somebody has tried it.
        await tx.applicationSetting.deleteMany({ where: { companyId: row.companyId, key: `${DATA_PREFIX}${link.shareId}` } });
        if (status === 'expired') await audit(tx, row.companyId!, null, 'SHARE_LINK_EXPIRED_VIEW', link.shareId, { status: SHARE_EVENTS.SHARE_LINK_EXPIRED_VIEW }, options.client);
      });
    }
    return { status };
  }

  const data = await prisma.applicationSetting.findFirst({
    where: { companyId: row.companyId, key: `${DATA_PREFIX}${link.shareId}` },
    select: { value: true },
  });
  const parsed = data ? shareSnapshotSchema.safeParse(parse(data.value)) : null;
  if (!parsed?.success) return { status: 'missing' };

  if (!options.countView) return { status: 'active', link, snapshot: parsed.data };

  const at = new Date().toISOString();
  const next: ShareLinkMeta = { ...link, views: link.views + 1, firstViewedAt: link.firstViewedAt ?? at, lastViewedAt: at };
  await prisma.$transaction(async (tx) => {
    await tx.applicationSetting.update({ where: { id: row.id }, data: { value: JSON.stringify(next) } });
    await audit(tx, row.companyId!, null, 'SHARE_LINK_VIEWED', link.shareId, { status: SHARE_EVENTS.SHARE_LINK_VIEWED, views: next.views }, options.client);
  });
  return { status: 'active', link: next, snapshot: parsed.data };
}

export async function listShareLinks(companyId: string): Promise<Array<ShareLinkMeta & { status: 'active' | 'expired' | 'revoked' }>> {
  const rows = await prisma.applicationSetting.findMany({
    where: { companyId, key: { startsWith: LINK_PREFIX } },
    select: { value: true },
  });
  return rows
    .map((r) => parse<ShareLinkMeta>(r.value))
    .filter((m): m is ShareLinkMeta => Boolean(m))
    .map((m) => ({ ...m, status: statusOf(m) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The owner, an administrator, the developer, or whoever made the link. */
export function mayRevoke(actor: Actor, link: Pick<ShareLinkMeta, 'createdBy'>): boolean {
  return actor.isSuperAdmin || actor.canManageUsers || actor.isDeveloper || actor.id === link.createdBy;
}

export async function revokeShareLink(params: { actor: Actor; companyId: string; shareId: string; client?: Client }): Promise<void> {
  if (!/^shr_[a-z0-9]{12,32}$/.test(params.shareId)) throw new NotFoundError('Shared link');
  await prisma.$transaction(async (tx) => {
    const rows = await tx.applicationSetting.findMany({
      where: { companyId: params.companyId, key: { startsWith: LINK_PREFIX }, value: { contains: `"shareId":"${params.shareId}"` } },
      select: { id: true, value: true },
    });
    const row = rows.find((r) => parse<ShareLinkMeta>(r.value)?.shareId === params.shareId);
    const link = row ? parse<ShareLinkMeta>(row.value) : null;
    if (!row || !link) throw new NotFoundError('Shared link');
    if (!mayRevoke(params.actor, link)) throw new ForbiddenError('Only the owner, an administrator or the person who shared it can revoke this link.');
    if (link.revokedAt) return;
    const next: ShareLinkMeta = { ...link, revokedAt: new Date().toISOString(), revokedByName: params.actor.name };
    await tx.applicationSetting.update({ where: { id: row.id }, data: { value: JSON.stringify(next) } });
    await tx.applicationSetting.deleteMany({ where: { companyId: params.companyId, key: `${DATA_PREFIX}${link.shareId}` } });
    await audit(tx, params.companyId, params.actor.id, 'SHARE_LINK_REVOKED', link.shareId, { status: SHARE_EVENTS.SHARE_LINK_REVOKED }, params.client);
  });
}

// ---------------------------------------------------------------------------
// The share log
// ---------------------------------------------------------------------------

/** What the browser reports: that a share began, and what it did next. */
export async function logShareEvents(params: {
  actor: Actor;
  companyId: string;
  meta: ShareMeta;
  events: ShareEvent[];
  client?: Client;
}): Promise<void> {
  const meta = shareMetaSchema.parse(params.meta);
  if (!isShareReportKey(meta.report)) throw new BusinessRuleError('This report cannot be shared.');
  const events = params.events.filter((e): e is (typeof CLIENT_SHARE_EVENTS)[number] => (CLIENT_SHARE_EVENTS as readonly string[]).includes(e));
  if (events.length === 0) return;

  await prisma.$transaction(async (tx) => {
    for (const event of events) {
      const after =
        event === 'SHARE_INITIATED'
          ? {
              status: SHARE_EVENTS.SHARE_INITIATED,
              ...meta,
              reportLabel: shareReportLabel(meta.report),
              party: shareReportParty(meta.report),
              userName: params.actor.name,
              roles: params.actor.isSuperAdmin ? ['Owner', ...params.actor.roleNames] : params.actor.roleNames,
            }
          : { status: SHARE_EVENTS[event], format: meta.format, method: meta.method };
      await audit(tx, params.companyId, params.actor.id, event, meta.shareId, after, params.client);
    }
  });
}

export type ShareActivityRow = {
  shareId: string;
  at: string;
  userId: string | null;
  userName: string;
  roles: string[];
  report: string;
  reportLabel: string;
  party: string | null;
  title: string;
  subject: string | null;
  period: string | null;
  filters: string[];
  scope: string;
  rows: number;
  format: string;
  method: string;
  statuses: string[];
  link: (ShareLinkMeta & { status: 'active' | 'expired' | 'revoked' }) | null;
};

export type ShareActivityFilter = {
  from?: Date;
  to?: Date;
  userId?: string;
  role?: string;
  report?: string;
  format?: string;
  party?: string;
  q?: string;
};

type InitiatedAfter = Partial<ShareMeta> & { userName?: string; roles?: string[]; reportLabel?: string; party?: string | null };

export async function getShareActivity(companyId: string, filter: ShareActivityFilter = {}) {
  const logs = await prisma.auditLog.findMany({
    where: {
      companyId,
      entityType: SHARE_ENTITY,
      ...(filter.from || filter.to ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 20_000,
    select: { action: true, entityId: true, userId: true, after: true, createdAt: true, user: { select: { name: true } } },
  });
  const links = new Map((await listShareLinks(companyId)).map((l) => [l.shareId, l]));

  const byShare = new Map<string, ShareActivityRow>();
  for (const log of logs) {
    const after = (log.after ?? {}) as InitiatedAfter & { status?: string };
    let row = byShare.get(log.entityId);
    if (!row) {
      row = {
        shareId: log.entityId,
        at: log.createdAt.toISOString(),
        userId: log.userId,
        userName: log.user?.name ?? 'Unknown',
        roles: [],
        report: '',
        reportLabel: '',
        party: null,
        title: '',
        subject: null,
        period: null,
        filters: [],
        scope: '',
        rows: 0,
        format: '',
        method: '',
        statuses: [],
        link: links.get(log.entityId) ?? null,
      };
      byShare.set(log.entityId, row);
    }
    if (log.action === 'SHARE_INITIATED') {
      row.at = log.createdAt.toISOString();
      row.userId = log.userId;
      row.userName = after.userName ?? log.user?.name ?? 'Unknown';
      row.roles = after.roles ?? [];
      row.report = after.report ?? '';
      row.reportLabel = after.reportLabel ?? shareReportLabel(after.report ?? '');
      row.party = after.party ?? null;
      row.title = after.title ?? '';
      row.subject = after.subject ?? null;
      row.period = after.period ?? null;
      row.filters = after.filters ?? [];
      row.scope = after.scope ?? '';
      row.rows = after.rows ?? 0;
      row.format = after.format ?? '';
      row.method = after.method ? (SHARE_METHOD_LABEL[after.method] ?? after.method) : '';
    }
    // Views are counted on the link; the log keeps one line per view but the list says it once.
    if (log.action === 'SHARE_LINK_VIEWED') continue;
    const label = after.status ?? SHARE_EVENTS[log.action as ShareEvent] ?? log.action;
    if (!row.statuses.includes(label)) row.statuses.push(label);
  }

  const q = filter.q?.trim().toLowerCase();
  const rows = [...byShare.values()]
    // A link view or revocation whose share began before the dates chosen is not a share of this period.
    .filter((r) => r.report)
    .filter((r) => !filter.userId || r.userId === filter.userId)
    .filter((r) => !filter.role || r.roles.includes(filter.role))
    .filter((r) => !filter.report || r.report === filter.report)
    .filter((r) => !filter.format || r.format === filter.format)
    .filter((r) => !filter.party || r.party === filter.party)
    .filter(
      (r) =>
        !q ||
        [r.userName, r.reportLabel, r.title, r.subject, r.period, r.scope, ...r.filters, ...r.roles]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q),
    )
    .sort((a, b) => b.at.localeCompare(a.at));

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const top = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return best ? { name: best[0], count: best[1] } : null;
  };

  return {
    rows,
    summary: {
      today: rows.filter((r) => new Date(r.at) >= startOfDay).length,
      month: rows.filter((r) => new Date(r.at) >= startOfMonth).length,
      pdf: rows.filter((r) => r.format === 'PDF').length,
      link: rows.filter((r) => r.format === 'LINK').length,
      topReport: top(rows.map((r) => r.reportLabel)),
      topUser: top(rows.map((r) => r.userName)),
    },
    users: [...new Map(rows.filter((r) => r.userId).map((r) => [r.userId!, r.userName])).entries()].map(([id, name]) => ({ id, name })),
    roles: [...new Set(rows.flatMap((r) => r.roles))].sort(),
    reports: [...new Map(rows.map((r) => [r.report, r.reportLabel])).entries()].map(([key, label]) => ({ key, label })),
  };
}
