import 'server-only';
import { cache } from 'react';
import { randomBytes, createHash } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { UnauthenticatedError } from '@/lib/errors';
import { ALL_PERMISSIONS, type PermissionCode } from '@/lib/constants';
import { applyOverrides, parseOverrides, parseScope, permissionsKey, scopeKey, type UserScope } from '@/lib/user-access';

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'fid_session';
const TTL_HOURS = Number(process.env.SESSION_TTL_HOURS ?? 12);

/**
 * Sessions are server-side records. The cookie carries only a random opaque
 * token; the database stores its SHA-256 digest, so a leaked database dump
 * cannot be replayed as a live session.
 */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type SessionCompany = {
  id: string;
  code: string;
  name: string;
  country: string;
  localCurrency: string;
  baseCurrency: string;
  timezone: string;
};

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  permissions: Set<PermissionCode>;
  roleNames: string[];
  /** In the order they were given, for the role's own menu. */
  roleIds: string[];
  /**
   * Whose data this person sees, when narrowed: an agent signing in for
   * himself sees his own agent's ledger, customers, invoices and collections,
   * and only the warehouses listed. Empty means no narrowing.
   */
  scope: UserScope;
  companies: SessionCompany[];
  activeCompany: SessionCompany;
};

export async function createSession(userId: string, activeCompanyId: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3_600_000);

  const requestHeaders = await headers();

  await prisma.session.create({
    data: {
      token: digest(token),
      userId,
      activeCompanyId,
      expiresAt,
      ipAddress: requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: requestHeaders.get('user-agent')?.slice(0, 500) ?? null,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });

  return token;
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { token: digest(token) } });
  }
  cookieStore.delete(COOKIE_NAME);
}

/** Deletes every session for a user — used when a password changes. */
export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/**
 * Loads the current user with resolved permissions and company access.
 * Returns null when there is no valid session.
 */
async function loadCurrentUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const tokenDigest = digest(token);
  const [session, extras] = await Promise.all([
    prisma.session.findUnique({
      where: { token: tokenDigest },
      include: {
        user: {
          include: {
            roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
            companies: { include: { company: true } },
          },
        },
      },
    }),
    // This person's own permission changes and data scope, fetched alongside
    // the session by its token rather than after it: one round trip, not two.
    prisma.$queryRaw<Array<{ key: string; value: string }>>`
      SELECT a."key", a."value"
      FROM application_settings a
      JOIN sessions s ON a."key" IN ('user_permissions:' || s."userId", 'user_scope:' || s."userId")
      WHERE s."token" = ${tokenDigest} AND a."companyId" IS NULL`,
  ]);

  if (!session || session.expiresAt < new Date() || !session.user.isActive) {
    return null;
  }

  const user = session.user;

  const rolePermissions = new Set<PermissionCode>();
  for (const userRole of user.roles) {
    for (const rp of userRole.role.permissions) {
      rolePermissions.add(rp.permission.code as PermissionCode);
    }
  }
  // Role first, then what the owner changed for this one person.
  const permissions = applyOverrides(
    rolePermissions,
    parseOverrides(extras.find((e) => e.key === permissionsKey(user.id))?.value),
    KNOWN_PERMISSIONS,
  );
  const scope = parseScope(extras.find((e) => e.key === scopeKey(user.id))?.value);

  // A Super Admin reaches every company; everyone else only their assignments.
  const companyRows = user.isSuperAdmin
    ? await prisma.company.findMany({ where: { status: 'ACTIVE' }, orderBy: { name: 'asc' } })
    : user.companies.map((uc) => uc.company).filter((c) => c.status === 'ACTIVE');

  const companies: SessionCompany[] = companyRows
    .map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      country: c.country,
      localCurrency: c.localCurrency,
      baseCurrency: c.baseCurrency,
      timezone: c.timezone,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (companies.length === 0) return null;

  const activeCompany =
    companies.find((c) => c.id === session.activeCompanyId) ??
    companies.find((c) => c.id === user.defaultCompanyId) ??
    companies[0];

  // Keep the stored session in step when the active company was stale.
  if (session.activeCompanyId !== activeCompany.id) {
    await prisma.session.update({
      where: { id: session.id },
      data: { activeCompanyId: activeCompany.id, lastSeenAt: new Date() },
    });
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isSuperAdmin: user.isSuperAdmin,
    permissions,
    roleNames: user.roles.map((r) => r.role.name),
    roleIds: user.roles.map((r) => r.role.id),
    scope,
    companies,
    activeCompany,
  };
}

/**
 * The session, resolved once per request.
 *
 * Every page resolves it twice — the layout renders the sidebar and topbar
 * from it, then the page's own permission guard asks again — and each
 * resolution is a round trip to a database on the other side of the world.
 * `cache` is React's per-request memo: the second and later calls within one
 * render return the first result rather than issuing the query again. It is
 * scoped to a single request, so one user's session can never be handed to
 * another, and it is not a cache in the sense of surviving a request: a
 * permission change still takes effect on the very next page load.
 */
export const getCurrentUser = cache(loadCurrentUser);

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

/** Switches the active company after verifying the user may reach it. */
export async function switchActiveCompany(companyId: string): Promise<void> {
  const user = await requireUser();
  if (!user.companies.some((c) => c.id === companyId)) {
    throw new UnauthenticatedError('You do not have access to that company.');
  }
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) throw new UnauthenticatedError();
  await prisma.session.updateMany({
    where: { token: digest(token) },
    data: { activeCompanyId: companyId },
  });
}

/** Removes expired sessions. Safe to call opportunistically. */
export async function pruneExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
