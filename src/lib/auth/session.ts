import 'server-only';
import { randomBytes, createHash } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { UnauthenticatedError } from '@/lib/errors';
import type { PermissionCode } from '@/lib/constants';

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
export async function getCurrentUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { token: digest(token) },
    include: {
      user: {
        include: {
          roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
          companies: { include: { company: true } },
        },
      },
    },
  });

  if (!session || session.expiresAt < new Date() || !session.user.isActive) {
    return null;
  }

  const user = session.user;

  const permissions = new Set<PermissionCode>();
  for (const userRole of user.roles) {
    for (const rp of userRole.role.permissions) {
      permissions.add(rp.permission.code as PermissionCode);
    }
  }

  // A Super Admin reaches every company; everyone else only their assignments.
  const companyRows = user.isSuperAdmin
    ? await prisma.company.findMany({ where: { status: 'ACTIVE' }, orderBy: { name: 'asc' } })
    : user.companies.map((uc) => uc.company).filter((c) => c.status === 'ACTIVE');

  const companies: SessionCompany[] = companyRows
    .map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
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
    companies,
    activeCompany,
  };
}

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
