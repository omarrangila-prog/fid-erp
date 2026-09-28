import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext } from '../helpers';
import {
  createShareLink,
  getShareActivity,
  hashShareToken,
  listShareLinks,
  logShareEvents,
  openShareLink,
  revokeShareLink,
} from '@/lib/services/report-share';
import { isDeveloper } from '@/lib/auth/developer';
import { SHARE_ENTITY, SHARE_EVENTS, type ShareMeta, type ShareSnapshot } from '@/lib/share/model';

/**
 * Sharing a report: the secure link opens one read-only copy until it
 * expires or is revoked, only its hash is kept, views are counted by the
 * server, and the share log holds what was shared — never the report, and
 * never a claim that anything was "sent".
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
const MARK = 'RADOUAN-ROW-7731';

const owner = () => ({ id: ctx.admin.id, name: 'Test Admin', roleNames: [], isSuperAdmin: true, canManageUsers: true, isDeveloper: false });
const staff = (id: string) => ({ id, name: 'Staff', roleNames: ['Data Entry'], isSuperAdmin: false, canManageUsers: false, isDeveloper: false });

let seq = 0;
function meta(over: Partial<ShareMeta> = {}): ShareMeta {
  seq += 1;
  return {
    shareId: `shr_test${String(seq).padStart(8, '0')}`,
    report: 'agent-ledger',
    title: 'Agent Ledger',
    subject: 'RADOUAN MOHAMMED',
    period: '01 Sep 2026 – 30 Sep 2026',
    filters: ['Commission'],
    scope: 'Current filtered report',
    rows: 1,
    columns: ['Date', 'Memo', 'Debit', 'Credit', 'Balance'],
    format: 'LINK',
    method: 'WHATSAPP',
    page: '/agents/x?from=2026-09-01',
    ...over,
  };
}

const snapshot: ShareSnapshot = {
  v: 1,
  company: 'FID Trading International SARL',
  title: 'Agent Ledger',
  subject: 'RADOUAN MOHAMMED',
  period: '01 Sep 2026 – 30 Sep 2026',
  filters: ['Commission'],
  scope: 'Current filtered report',
  facts: [{ label: 'Closing balance', value: 'MAD 118,572.30 Dr' }],
  sections: [
    {
      columns: [{ label: 'Date' }, { label: 'Memo' }, { label: 'Debit', numeric: true }, { label: 'Credit', numeric: true }, { label: 'Balance', numeric: true }],
      rows: [{ cells: [{ text: '02 Sep 2026' }, { text: MARK }, { text: 'MAD 500.00' }, { text: '—' }, { text: 'MAD 500.00 Dr' }] }],
    },
  ],
  generatedAt: new Date().toISOString(),
  generatedBy: 'Test Admin',
};

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
}, 300_000);

describe('a secure report link', () => {
  it('keeps only the hash of its token, opens the copy, and counts real views only', async () => {
    const m = meta();
    const link = await createShareLink({ actor: owner(), companyId: ctx.morocco.id, meta: m, snapshot, expiry: '7' });
    expect(link.token.length).toBeGreaterThanOrEqual(40);

    const stored = await prisma.applicationSetting.findMany({ where: { companyId: ctx.morocco.id, key: { startsWith: 'report_share' } } });
    expect(stored.some((s) => s.key.includes(link.token) || s.value.includes(link.token))).toBe(false);
    expect(stored.some((s) => s.key === `report_share:${hashShareToken(link.token)}`)).toBe(true);

    const preview = await openShareLink(link.token, { countView: false });
    expect(preview.status).toBe('active');

    const first = await openShareLink(link.token, { countView: true });
    const second = await openShareLink(link.token, { countView: true });
    expect(first.status).toBe('active');
    if (second.status !== 'active') throw new Error('expected an open link');
    expect(second.snapshot.sections[0].rows[0].cells[1].text).toBe(MARK);
    expect(second.link.views).toBe(2);
    expect(second.link.firstViewedAt).toBeTruthy();
    expect(second.link.lastViewedAt).toBeTruthy();
    expect(second.link.expiresAt).toBeTruthy();
  });

  it('answers "missing" to a token nobody issued', async () => {
    expect((await openShareLink('x'.repeat(43), { countView: true })).status).toBe('missing');
    expect((await openShareLink('../../etc', { countView: true })).status).toBe('missing');
  });

  it('expires, and the copy is deleted once somebody tries it', async () => {
    const m = meta();
    const link = await createShareLink({ actor: owner(), companyId: ctx.morocco.id, meta: m, snapshot, expiry: '1' });
    const row = (await prisma.applicationSetting.findFirstOrThrow({ where: { key: `report_share:${hashShareToken(link.token)}` } }));
    const value = JSON.parse(row.value);
    await prisma.applicationSetting.update({ where: { id: row.id }, data: { value: JSON.stringify({ ...value, expiresAt: new Date(Date.now() - 1000).toISOString() }) } });

    expect((await openShareLink(link.token, { countView: true })).status).toBe('expired');
    expect(await prisma.applicationSetting.count({ where: { key: `report_share_data:${m.shareId}` } })).toBe(0);
  });

  it('never expires only when the owner or an administrator says so', async () => {
    await expect(
      createShareLink({ actor: staff(ctx.admin.id), companyId: ctx.morocco.id, meta: meta(), snapshot, expiry: 'never' }),
    ).rejects.toThrow(/owner or an administrator/);
    const link = await createShareLink({ actor: owner(), companyId: ctx.morocco.id, meta: meta(), snapshot, expiry: 'never' });
    const open = await openShareLink(link.token, { countView: false });
    if (open.status !== 'active') throw new Error('expected an open link');
    expect(open.link.expiresAt).toBeNull();
  });

  it('is revoked by the owner, not by another member of staff, and then opens to nothing', async () => {
    const m = meta();
    const link = await createShareLink({ actor: owner(), companyId: ctx.morocco.id, meta: m, snapshot, expiry: '30' });
    await expect(revokeShareLink({ actor: staff('someone-else'), companyId: ctx.morocco.id, shareId: m.shareId })).rejects.toThrow(/revoke/);
    await revokeShareLink({ actor: owner(), companyId: ctx.morocco.id, shareId: m.shareId });
    expect((await openShareLink(link.token, { countView: true })).status).toBe('revoked');
    expect(await prisma.applicationSetting.count({ where: { key: `report_share_data:${m.shareId}` } })).toBe(0);
  });

  it('refuses a report too large for a link', async () => {
    const big: ShareSnapshot = {
      ...snapshot,
      sections: Array.from({ length: 2 }, () => ({
        columns: snapshot.sections[0].columns,
        rows: Array.from({ length: 5_000 }, () => ({ cells: Array.from({ length: 5 }, () => ({ text: 'x'.repeat(300) })) })),
      })),
    };
    await expect(createShareLink({ actor: owner(), companyId: ctx.morocco.id, meta: meta(), snapshot: big, expiry: '1' })).rejects.toThrow(/too large/);
  });
});

describe('the share log', () => {
  it('records what the browser did, ignores anything only the server may say, and never says "sent"', async () => {
    const m = meta({ format: 'PDF', method: 'NATIVE_SHARE' });
    await logShareEvents({
      actor: owner(),
      companyId: ctx.morocco.id,
      meta: m,
      events: ['SHARE_INITIATED', 'SHARE_PDF_GENERATED', 'SHARE_SHEET_OPENED', 'SHARE_LINK_VIEWED', 'SHARE_LINK_REVOKED'],
    });
    const rows = await prisma.auditLog.findMany({ where: { entityType: SHARE_ENTITY, entityId: m.shareId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['SHARE_INITIATED', 'SHARE_PDF_GENERATED', 'SHARE_SHEET_OPENED']);
    expect(Object.values(SHARE_EVENTS).join(' ')).not.toMatch(/\bsent\b/i);
  });

  it('holds metadata only — the report itself is never written into it', async () => {
    const all = await prisma.auditLog.findMany({ where: { entityType: SHARE_ENTITY } });
    expect(all.length).toBeGreaterThan(0);
    expect(JSON.stringify(all.map((r) => r.after))).not.toContain(MARK);
  });

  it('groups each share with its statuses and views, and filters by party', async () => {
    const m = meta({ subject: 'RADOUAN MOHAMMED' });
    await logShareEvents({ actor: owner(), companyId: ctx.morocco.id, meta: m, events: ['SHARE_INITIATED'] });
    const link = await createShareLink({ actor: owner(), companyId: ctx.morocco.id, meta: m, snapshot, expiry: '3' });
    await openShareLink(link.token, { countView: true });

    const { rows, summary } = await getShareActivity(ctx.morocco.id, { q: 'radouan' });
    const row = rows.find((r) => r.shareId === m.shareId);
    expect(row).toBeTruthy();
    expect(row!.statuses).toEqual(expect.arrayContaining(['Share initiated', 'Link generated']));
    expect(row!.statuses).not.toContain('Link opened');
    expect(row!.link?.views).toBe(1);
    expect(row!.party).toBe('Agent');
    expect(summary.today).toBeGreaterThan(0);
    expect((await getShareActivity(ctx.morocco.id, { party: 'Customer' })).rows.find((r) => r.shareId === m.shareId)).toBeUndefined();
  });

  it('keeps each company to itself', async () => {
    expect((await getShareActivity(ctx.dubai.id)).rows).toHaveLength(0);
    expect(await listShareLinks(ctx.dubai.id)).toHaveLength(0);
    expect((await listShareLinks(ctx.morocco.id)).length).toBeGreaterThan(0);
  });
});

describe('the developer', () => {
  it('is whoever the server names, by id or email, and nobody when it names nobody', () => {
    const before = process.env.DEVELOPER_USERS;
    try {
      delete process.env.DEVELOPER_USERS;
      expect(isDeveloper({ id: 'u1', email: 'dev@example.com' })).toBe(false);
      process.env.DEVELOPER_USERS = 'someone@else.com, Dev@Example.com';
      expect(isDeveloper({ id: 'u1', email: 'dev@example.com' })).toBe(true);
      process.env.DEVELOPER_USERS = 'u2';
      expect(isDeveloper({ id: 'u2', email: 'x@y.z' })).toBe(true);
      expect(isDeveloper({ id: 'u1', email: 'dev@example.com' })).toBe(false);
    } finally {
      if (before === undefined) delete process.env.DEVELOPER_USERS;
      else process.env.DEVELOPER_USERS = before;
    }
  });
});
