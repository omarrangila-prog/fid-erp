'use server';

import { headers, cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { hashPassword, verifyPassword, validatePasswordStrength } from '@/lib/auth/password';
import { checkLoginAllowed, recordFailedLogin, clearLoginAttempts } from '@/lib/auth/rate-limit';
import { identifyByPin } from '@/lib/auth/pin';
import { customerScopeWhere, invoiceScopeWhere, isScoped, receiptScopeWhere, warehouseScope } from '@/lib/auth/scope';
import { checkPinThrottle, recordPinFailure } from '@/lib/auth/pin-throttle';
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
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { BusinessRuleError } from '@/lib/errors';

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

  // Everyone signs in with a PIN. The password route stays only as the
  // owner's way back in — if every PIN were locked, or on a new installation.
  if (!user || !passwordOk || !user.isActive || !user.isSuperAdmin) {
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
  /*
   * Signing in belongs to the person, not to a company.
   *
   * Filing it under whichever company the session happened to open left the
   * other company's access view empty, so a security review looking at Dubai
   * could not see that anyone had signed in at all. Recorded without a
   * company, it shows on every company's access view, which is what "no
   * sign-in is hidden" has to mean.
   */
  await recordAudit({
    companyId: null,
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

/**
 * Signs out. The browser then loads the PIN screen afresh (not a client-side
 * navigation), so nothing of the previous person's pages stays in memory.
 */
export async function logoutAction(): Promise<void> {
  const user = await requireUser().catch(() => null);
  if (user) {
    await recordAudit({
      companyId: null,
      userId: user.id,
      action: 'USER_LOGOUT',
      entityType: 'User',
      entityId: user.id,
    });
  }
  await destroySession();
}

/**
 * Switch which company's books are open.
 *
 * The revalidation is `('/', 'layout')` and not `('/')`, which is the whole
 * point of this function working. A path revalidation clears one page; a
 * layout revalidation clears every route beneath it. With only the first, the
 * session moved to Morocco while the client router cache went on serving the
 * Dubai pages it had already prefetched — the new purchase form still listed
 * Dubai's suppliers and still said "Local rate (AED per USD)". Choosing one of
 * those suppliers and saving produced "Supplier was not found.", because by
 * then the server was quite correctly looking in Morocco.
 *
 * Nothing leaked in the dangerous direction: the server refused the write. But
 * a user was being shown one company's data while working in another, which is
 * the thing this system is not allowed to do.
 */
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

    // Every cached route below the root belongs to the company being left.
    revalidatePath('/', 'layout');
    return undefined;
  });
}

/**
 * The company chooser, as a form. A plain form submits even before the page's
 * scripts have loaded, so tapping a company on a slow connection always does
 * something; the button used to wait for the scripts and ignore an early tap.
 */
export async function chooseCompanyFormAction(_previous: { error: string } | null, formData: FormData): Promise<{ error: string } | null> {
  const result = await switchCompanyAction(String(formData.get('companyId') ?? ''));
  if (!result.ok) return { error: result.error };
  redirect('/dashboard');
}

export async function searchAction(query: string): Promise<SearchResult[]> {
  const user = await requireUser().catch(() => null);
  if (!user) return [];
  return globalSearch({
    companyId: user.activeCompany.id,
    query,
    permissions: user.permissions,
    isSuperAdmin: user.isSuperAdmin,
    scope: isScoped(user)
      ? {
          customers: customerScopeWhere(user),
          invoices: invoiceScopeWhere(user),
          receipts: receiptScopeWhere(user),
          warehouseLimited: warehouseScope(user) !== null,
        }
      : undefined,
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
      throw new BusinessRuleError('Your current password is not correct.');
    }
    if (newPassword !== confirmPassword) {
      throw new BusinessRuleError('The new passwords do not match.');
    }
    const weakness = validatePasswordStrength(newPassword);
    if (weakness) throw new BusinessRuleError(weakness);

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
// PIN sign-in
// ---------------------------------------------------------------------------

const DEVICE_COOKIE = 'fid_device';
const INCORRECT_PIN = 'Incorrect PIN';

/** A long-lived random id for this browser, so failed PINs can be counted per device. */
async function deviceId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(DEVICE_COOKIE)?.value;
  if (existing && /^[\w-]{16,64}$/.test(existing)) return existing;
  const id = randomBytes(18).toString('base64url');
  store.set(DEVICE_COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}

/**
 * Signs in with the PIN alone: the PIN says who you are.
 *
 * A wrong PIN is answered "Incorrect PIN" and nothing else — not whose it
 * might have been, not whether anyone has it. Guessing is throttled per
 * device, per address and overall (`pin-throttle.ts`), and every attempt, good
 * or bad, is in the audit trail with where it came from.
 */
export async function pinLoginAction(pin: string): Promise<ActionResult<{ redirectTo: string }>> {
  const requestHeaders = await headers();
  const source = {
    address: requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() || requestHeaders.get('x-real-ip') || null,
    device: await deviceId(),
    userAgent: requestHeaders.get('user-agent'),
  };

  const verdict = await checkPinThrottle(source);
  if (verdict.blocked) {
    await recordPinFailure(source, 'BLOCKED');
    return {
      ok: false,
      error: `Too many incorrect PINs. Try again in ${verdict.retryAfterMinutes} minute${verdict.retryAfterMinutes === 1 ? '' : 's'}.`,
      code: 'RATE_LIMITED',
    };
  }

  const identity = await identifyByPin(String(pin ?? ''));
  if (!identity.ok) {
    await recordPinFailure(source, identity.reason === 'AMBIGUOUS' ? 'SHARED_PIN' : 'WRONG_PIN');
    return identity.reason === 'AMBIGUOUS'
      ? { ok: false, error: 'This PIN cannot be used to sign in. Ask the owner to set you a new PIN.', code: 'UNAUTHENTICATED' }
      : { ok: false, error: INCORRECT_PIN, code: 'UNAUTHENTICATED' };
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: identity.userId },
    include: { companies: true },
  });

  const companyCount = user.isSuperAdmin
    ? await prisma.company.count({ where: { status: 'ACTIVE' } })
    : user.companies.length;
  if (companyCount === 0) {
    return {
      ok: false,
      error: 'Your account is not assigned to any company. Ask the owner to give you access.',
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
  await recordAudit({
    companyId: null,
    userId: user.id,
    action: 'PIN_LOGIN',
    entityType: 'User',
    entityId: user.id,
    ipAddress: source.address,
    userAgent: source.userAgent?.slice(0, 500) ?? null,
  });
  pruneExpiredSessions().catch(() => undefined);

  return {
    ok: true,
    data: { redirectTo: companyCount > 1 ? '/select-company' : '/dashboard' },
  };
}
