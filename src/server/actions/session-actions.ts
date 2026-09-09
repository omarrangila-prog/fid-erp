'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { hashPassword, verifyPassword, validatePasswordStrength } from '@/lib/auth/password';
import { checkLoginAllowed, recordFailedLogin, clearLoginAttempts } from '@/lib/auth/rate-limit';
import { verifyPin } from '@/lib/auth/pin';
import {
  createSession,
  destroySession,
  destroyAllSessionsForUser,
  switchActiveCompany,
  requireUser,
  pruneExpiredSessions,
} from '@/lib/auth/session';
import { recordAudit } from '@/lib/services/audit';
import { globalSearch, type SearchResult } from '@/lib/services/search';
import { run, type ActionResult } from '@/server/actions/action-utils';

/**
 * Sign-in.
 *
 * The failure message is identical for an unknown email, a wrong password and a
 * disabled account, so the form cannot be used to enumerate valid users. A
 * password verification is performed even when the user does not exist, to keep
 * the response time flat.
 */
const GENERIC_LOGIN_FAILURE = 'Those credentials are not correct.';
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$3s4uPKPFYqPfLYUCfvGdmVJ2JXPMzKZjXqRZgHm7dJ0';

export async function loginAction(
  _prev: ActionResult<{ redirectTo: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ redirectTo: string }>> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { ok: false, error: 'Enter your email address and password.', code: 'VALIDATION_ERROR' };
  }

  // Throttle before touching the database, so a flood costs nothing to refuse.
  const address = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const verdict = checkLoginAllowed(email, address);
  if (!verdict.allowed) {
    const minutes = Math.ceil(verdict.retryAfterSeconds / 60);
    return {
      ok: false,
      error: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      code: 'RATE_LIMITED',
    };
  }

  const user = await prisma.user.findUnique({
    where: { email },
    include: { companies: true },
  });

  const passwordOk = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, password);

  if (!user || !passwordOk || !user.isActive) {
    recordFailedLogin(email, address);
    return { ok: false, error: GENERIC_LOGIN_FAILURE, code: 'UNAUTHENTICATED' };
  }

  clearLoginAttempts(email, address);

  const companyCount = user.isSuperAdmin
    ? await prisma.company.count({ where: { status: 'ACTIVE' } })
    : user.companies.length;

  if (companyCount === 0) {
    return {
      ok: false,
      error: 'Your account is not assigned to any company. Ask an administrator to grant you access.',
      code: 'FORBIDDEN',
    };
  }

  const activeCompanyId =
    user.defaultCompanyId ??
    (user.isSuperAdmin
      ? (await prisma.company.findFirst({ where: { status: 'ACTIVE' }, orderBy: { name: 'asc' } }))?.id ?? null
      : user.companies[0]?.companyId ?? null);

  await createSession(user.id, activeCompanyId);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const requestHeaders = await headers();
  await recordAudit({
    companyId: activeCompanyId,
    userId: user.id,
    action: 'USER_LOGIN',
    entityType: 'User',
    entityId: user.id,
    ipAddress: requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: requestHeaders.get('user-agent')?.slice(0, 500) ?? null,
  });

  // Opportunistic housekeeping; a failure here must not block the login.
  pruneExpiredSessions().catch(() => undefined);

  // Staff belong to one company and go straight in. Anyone with access to both
  // sets of books chooses first, so it is never ambiguous which company they
  // are about to post into.
  return { ok: true, data: { redirectTo: companyCount > 1 ? '/select-company' : '/dashboard' } };
}

export async function logoutAction(): Promise<void> {
  const user = await requireUser().catch(() => null);
  if (user) {
    await recordAudit({
      companyId: user.activeCompany.id,
      userId: user.id,
      action: 'USER_LOGOUT',
      entityType: 'User',
      entityId: user.id,
    });
  }
  await destroySession();
  redirect('/login');
}

export async function switchCompanyAction(companyId: string): Promise<ActionResult<undefined>> {
  return run(async () => {
    const before = await requireUser();
    await switchActiveCompany(companyId);
    await recordAudit({
      companyId,
      userId: before.id,
      action: 'COMPANY_SWITCHED',
      entityType: 'Company',
      entityId: companyId,
      before: { companyId: before.activeCompany.id },
      after: { companyId },
    });
    return undefined;
  }, ['/']);
}

export async function searchAction(query: string): Promise<SearchResult[]> {
  const user = await requireUser().catch(() => null);
  if (!user) return [];
  return globalSearch({
    companyId: user.activeCompany.id,
    query,
    permissions: user.permissions,
    isSuperAdmin: user.isSuperAdmin,
  });
}

export async function changePasswordAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return run(async () => {
    const user = await requireUser();
    const currentPassword = String(formData.get('currentPassword') ?? '');
    const newPassword = String(formData.get('newPassword') ?? '');
    const confirmPassword = String(formData.get('confirmPassword') ?? '');

    const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await verifyPassword(record.passwordHash, currentPassword))) {
      throw new Error('Your current password is not correct.');
    }
    if (newPassword !== confirmPassword) {
      throw new Error('The new passwords do not match.');
    }
    const weakness = validatePasswordStrength(newPassword);
    if (weakness) throw new Error(weakness);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword) },
    });

    // Changing a password invalidates every other session for that user.
    await destroyAllSessionsForUser(user.id);

    await recordAudit({
      companyId: user.activeCompany.id,
      userId: user.id,
      action: 'PASSWORD_CHANGED',
      entityType: 'User',
      entityId: user.id,
    });

    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Quick PIN sign-in
// ---------------------------------------------------------------------------

/**
 * Signs in with a four-digit PIN against one named account.
 *
 * The account is chosen on screen first, so a PIN can only ever open the person
 * it belongs to — it cannot collide into somebody else's permissions. Failures
 * are counted per user by `verifyPin` and per address here, and every outcome
 * is written to the audit trail.
 */
export async function pinLoginAction(
  userId: string,
  pin: string,
): Promise<ActionResult<{ redirectTo: string }>> {
  const address = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  const verdict = checkLoginAllowed(`pin:${userId}`, address);
  if (!verdict.allowed) {
    const minutes = Math.ceil(verdict.retryAfterSeconds / 60);
    return {
      ok: false,
      error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or sign in with a password.`,
      code: 'RATE_LIMITED',
    };
  }

  const result = await verifyPin(userId, pin);

  if (!result.ok) {
    recordFailedLogin(`pin:${userId}`, address);
    if (result.reason === 'LOCKED') {
      await recordAudit({ userId, action: 'PIN_LOCKED', entityType: 'User', entityId: userId });
      return {
        ok: false,
        error: `Too many wrong PINs. This PIN is locked for ${result.retryAfterMinutes ?? 15} minutes — you can still sign in with a password.`,
        code: 'PIN_LOCKED',
      };
    }
    return { ok: false, error: 'That PIN is not correct.', code: 'UNAUTHENTICATED' };
  }

  clearLoginAttempts(`pin:${userId}`, address);

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: result.userId },
    include: { companies: true },
  });

  const companyCount = user.isSuperAdmin
    ? await prisma.company.count({ where: { status: 'ACTIVE' } })
    : user.companies.length;
  if (companyCount === 0) {
    return {
      ok: false,
      error: 'Your account is not assigned to any company. Ask an administrator to grant you access.',
      code: 'FORBIDDEN',
    };
  }

  const activeCompanyId =
    user.defaultCompanyId ??
    (user.isSuperAdmin
      ? (await prisma.company.findFirst({ where: { status: 'ACTIVE' }, orderBy: { name: 'asc' } }))?.id ?? null
      : user.companies[0]?.companyId ?? null);

  await createSession(user.id, activeCompanyId);
  await recordAudit({ userId: user.id, action: 'PIN_LOGIN', entityType: 'User', entityId: user.id });

  return {
    ok: true,
    data: { redirectTo: companyCount > 1 && !user.defaultCompanyId ? '/select-company' : '/dashboard' },
  };
}
