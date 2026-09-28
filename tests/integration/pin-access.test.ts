import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext } from '../helpers';
import { hashPassword } from '@/lib/auth/password';
import { identifyByPin, isPinTaken, setPin, PIN_TAKEN_MESSAGE } from '@/lib/auth/pin';
import { checkPinThrottle, recordPinFailure, PIN_FAILURES_PER_SOURCE } from '@/lib/auth/pin-throttle';
import { applyOverrides, overridesFor, parseOverrides } from '@/lib/user-access';
import { getUserAccess, setUserOverrides, setUserScope } from '@/lib/services/user-access';
import { customerScopeWhere, invoiceScopeWhere, receiptScopeWhere, warehouseScope, agentScope } from '@/lib/auth/scope';
import { assertPermission } from '@/lib/auth/guards';
import { ALL_PERMISSIONS, PERMISSIONS, SYSTEM_ROLES, type PermissionCode } from '@/lib/constants';
import type { SessionUser } from '@/lib/auth/session';

/**
 * PIN-only sign-in and what a person may then do.
 *
 * The PIN alone identifies the person, so it must belong to one person only;
 * it is stored as a hash and checked against each account; guessing is
 * throttled per device from the audit trail. Permissions are the role's with
 * the owner's changes for that person; an agent's data is narrowed to his own.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let alice: string;
let bob: string;

async function user(name: string, pin: string | null, isActive = true) {
  const created = await prisma.user.create({
    data: {
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@test.local`,
      name,
      passwordHash: await hashPassword('Unused-Password-123'),
      isActive,
      pinHash: pin ? await hashPassword(pin) : null,
    },
  });
  return created.id;
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  alice = await user('Alice Pin', '4455');
  bob = await user('Bob Pin', '6633');
}, 300_000);

describe('the PIN says who you are', () => {
  it('finds the one person a PIN belongs to, and nobody for a wrong PIN', async () => {
    expect(await identifyByPin('4455')).toEqual({ ok: true, userId: alice });
    expect(await identifyByPin('6633')).toEqual({ ok: true, userId: bob });
    expect(await identifyByPin('7788')).toEqual({ ok: false, reason: 'INVALID' });
    expect(await identifyByPin('44')).toEqual({ ok: false, reason: 'INVALID' });
  }, 60_000);

  it('never stores the PIN itself', async () => {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: alice }, select: { pinHash: true } });
    expect(row.pinHash).not.toContain('4455');
    expect(row.pinHash).toMatch(/^\$argon2id\$/);
  });

  it('refuses a PIN someone else already has — disabled accounts included', async () => {
    expect(await isPinTaken('4455', bob)).toBe(true);
    expect(await isPinTaken('4455', alice)).toBe(false);
    await expect(setPin(bob, '4455')).rejects.toThrow(PIN_TAKEN_MESSAGE);
    const dormant = await user('Dormant Pin', '2468', false);
    await expect(setPin(bob, '2468')).rejects.toThrow(PIN_TAKEN_MESSAGE);
    // A disabled account's PIN signs nobody in.
    expect(await identifyByPin('2468')).toEqual({ ok: false, reason: 'INVALID' });
    await prisma.user.delete({ where: { id: dormant } });
  }, 60_000);

  it('a changed PIN works at once, and the old one stops working', async () => {
    await setPin(alice, '5577');
    expect(await identifyByPin('5577')).toEqual({ ok: true, userId: alice });
    expect(await identifyByPin('4455')).toEqual({ ok: false, reason: 'INVALID' });
  }, 60_000);

  it('two active accounts with one PIN (left from before PINs were unique) sign in neither', async () => {
    const twin = await user('Twin Pin', '5577');
    const result = await identifyByPin('5577');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('AMBIGUOUS');
    await prisma.user.delete({ where: { id: twin } });
  }, 60_000);
});

describe('guessing is slow', () => {
  it(`blocks a device after ${PIN_FAILURES_PER_SOURCE} wrong PINs, and says nothing about whose PIN is whose`, async () => {
    const source = { address: '203.0.113.9', device: `device-${Date.now()}`, userAgent: 'test' };
    expect(await checkPinThrottle(source)).toEqual({ blocked: false });
    for (let i = 0; i < PIN_FAILURES_PER_SOURCE; i += 1) await recordPinFailure(source, 'WRONG_PIN');
    const verdict = await checkPinThrottle(source);
    expect(verdict.blocked).toBe(true);
    // Another device from the same address is blocked too; another address and device is not.
    expect((await checkPinThrottle({ ...source, device: 'other-device-000001' })).blocked).toBe(true);
    expect((await checkPinThrottle({ address: '198.51.100.7', device: 'fresh-device-000001', userAgent: null })).blocked).toBe(false);
    // Each failure is on the audit trail with where it came from.
    const logged = await prisma.auditLog.count({ where: { action: 'PIN_LOGIN_FAILED', entityId: source.device, ipAddress: source.address } });
    expect(logged).toBe(PIN_FAILURES_PER_SOURCE);
  }, 60_000);
});

describe('permissions: the role, with the owner’s changes for one person', () => {
  const agentRole = SYSTEM_ROLES.find((r) => r.code === 'AGENT')!;
  const known = new Set<string>(ALL_PERMISSIONS);

  it('the Agent role: invoices view, create, edit — no delete, no accounting, no settings', () => {
    const perms = new Set(agentRole.permissions);
    for (const p of [PERMISSIONS.SALES_VIEW, PERMISSIONS.SALES_CREATE, PERMISSIONS.SALES_EDIT, PERMISSIONS.CUSTOMERS_CREATE, PERMISSIONS.RECEIPTS_CREATE, PERMISSIONS.AGENTS_VIEW]) {
      expect(perms.has(p), p).toBe(true);
    }
    for (const p of [PERMISSIONS.SALES_DELETE, PERMISSIONS.ACCOUNTING_VIEW, PERMISSIONS.SETTINGS_MANAGE, PERMISSIONS.USERS_MANAGE, PERMISSIONS.REPORTS_VIEW, PERMISSIONS.PROFITS_VIEW]) {
      expect(perms.has(p), p).toBe(false);
    }
  });

  it('a tick for one person adds to the role, an untick takes away, and both are kept as the difference', async () => {
    const wanted = [...agentRole.permissions.filter((p) => p !== PERMISSIONS.SALES_EDIT), PERMISSIONS.SALES_DELETE];
    const overrides = overridesFor(agentRole.permissions, wanted);
    expect(overrides).toEqual({ grant: [PERMISSIONS.SALES_DELETE], revoke: [PERMISSIONS.SALES_EDIT] });
    await setUserOverrides(bob, overrides);
    const stored = (await getUserAccess(bob)).overrides;
    const effective = applyOverrides(agentRole.permissions, stored, known);
    expect(effective.has(PERMISSIONS.SALES_DELETE)).toBe(true);
    expect(effective.has(PERMISSIONS.SALES_EDIT)).toBe(false);
    // Nothing unknown can be granted by a tampered setting.
    expect(applyOverrides([], parseOverrides('{"grant":["everything.forever"]}'), known).size).toBe(0);
    // Back to the role: nothing stored at all.
    await setUserOverrides(bob, overridesFor(agentRole.permissions, agentRole.permissions));
    expect((await getUserAccess(bob)).overrides).toEqual({ grant: [], revoke: [] });
  });

  it('Edit without Delete cannot delete: the server refuses', () => {
    const radouan = session(new Set(agentRole.permissions), { agentId: 'agent-1', warehouseIds: [] });
    expect(() => assertPermission(radouan, PERMISSIONS.SALES_DELETE)).toThrow(/permission/);
  });
});

describe('an agent sees his own records only', () => {
  it('narrows customers, invoices and collections to his, and warehouses to those assigned', async () => {
    const radouan = session(new Set(), { agentId: 'agent-1', warehouseIds: ['wh-1'] });
    expect(agentScope(radouan)).toBe('agent-1');
    expect(customerScopeWhere(radouan)).toEqual({ agentId: 'agent-1' });
    expect(invoiceScopeWhere(radouan)).toEqual({ OR: [{ customer: { agentId: 'agent-1' } }, { createdById: radouan.id }] });
    expect(receiptScopeWhere(radouan)).toEqual({ OR: [{ agentId: 'agent-1' }, { customer: { agentId: 'agent-1' } }, { createdById: radouan.id }] });
    expect(warehouseScope(radouan)).toEqual(['wh-1']);

    // An owner, or anyone without an agent linked, is not narrowed.
    const ownerSession = { ...session(new Set(), { agentId: 'agent-1', warehouseIds: ['wh-1'] }), isSuperAdmin: true };
    expect(agentScope(ownerSession)).toBeNull();
    expect(customerScopeWhere(session(new Set(), { agentId: null, warehouseIds: [] }))).toEqual({});

    await setUserScope(alice, { agentId: 'agent-1', warehouseIds: ['wh-1'] });
    expect((await getUserAccess(alice)).scope).toEqual({ agentId: 'agent-1', warehouseIds: ['wh-1'] });
    await setUserScope(alice, { agentId: null, warehouseIds: [] });
    expect(await prisma.applicationSetting.count({ where: { key: `user_scope:${alice}` } })).toBe(0);
  });
});

function session(permissions: Set<PermissionCode>, scope: SessionUser['scope']): SessionUser {
  const company = { id: ctx.morocco.id, code: 'FID-MA', name: 'FID Morocco', country: 'Morocco', localCurrency: 'MAD', baseCurrency: 'USD', timezone: 'Africa/Casablanca' };
  return {
    id: 'radouan-user',
    email: 'r@test.local',
    name: 'RADOUAN MOHAMMED',
    isSuperAdmin: false,
    permissions,
    roleNames: ['Agent'],
    roleIds: [],
    scope,
    companies: [company],
    activeCompany: company,
  };
}
