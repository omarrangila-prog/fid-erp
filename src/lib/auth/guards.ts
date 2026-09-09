import 'server-only';
import { redirect } from 'next/navigation';
import { getCurrentUser, requireUser, type SessionUser } from '@/lib/auth/session';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import type { PermissionCode } from '@/lib/constants';

/**
 * Server-side authorisation. Every service entry point and every route handler
 * goes through these helpers — hiding a button in the UI is a convenience, not
 * a control.
 */

export function can(user: SessionUser, permission: PermissionCode): boolean {
  return user.isSuperAdmin || user.permissions.has(permission);
}

export function canAny(user: SessionUser, permissions: PermissionCode[]): boolean {
  return user.isSuperAdmin || permissions.some((p) => user.permissions.has(p));
}

export function canAll(user: SessionUser, permissions: PermissionCode[]): boolean {
  return user.isSuperAdmin || permissions.every((p) => user.permissions.has(p));
}

/** Loads the session and asserts a single permission. */
export async function requirePermission(permission: PermissionCode): Promise<SessionUser> {
  const user = await requireUser();
  if (!can(user, permission)) {
    throw new ForbiddenError(`You do not have the "${permission}" permission.`);
  }
  return user;
}

export async function requireAnyPermission(permissions: PermissionCode[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!canAny(user, permissions)) {
    throw new ForbiddenError('You do not have permission to view this page.');
  }
  return user;
}

export function assertPermission(user: SessionUser, permission: PermissionCode): void {
  if (!can(user, permission)) {
    throw new ForbiddenError(`You do not have the "${permission}" permission.`);
  }
}

/**
 * Company isolation. Server code must never trust a companyId supplied by the
 * client; it either uses `user.activeCompany.id` or validates the supplied one
 * against the user's assignments through this guard.
 */
export function assertCompanyAccess(user: SessionUser, companyId: string): void {
  if (!user.companies.some((c) => c.id === companyId)) {
    // Deliberately a 404: a user must not be able to probe which company ids exist.
    throw new NotFoundError('Company');
  }
}

/**
 * Guards a record fetched by id. Returns the record when it belongs to the
 * active company, otherwise raises a not-found so cross-company ids are
 * indistinguishable from ids that do not exist.
 */
export function assertRecordInCompany<T extends { companyId: string }>(
  record: T | null | undefined,
  companyId: string,
  entityName: string,
): T {
  if (!record || record.companyId !== companyId) {
    throw new NotFoundError(entityName);
  }
  return record;
}

/**
 * Convenience for pages: returns the session plus the active company id, having
 * already asserted the permission.
 */
export async function requireCompanyContext(
  permission: PermissionCode,
): Promise<{ user: SessionUser; companyId: string }> {
  const user = await requirePermission(permission);
  return { user, companyId: user.activeCompany.id };
}

/**
 * Page-level access guard.
 *
 * Server actions and services *throw* when permission is missing — that is the
 * right behaviour for an API. A page render should not: a user who follows a
 * stale link deserves an explanation, not a crash. So this redirects instead,
 * to the sign-in screen when there is no session and to the not-authorised
 * screen when the permission is missing.
 *
 * The check itself is identical; only the failure mode differs.
 */
export async function requirePageAccess(permission: PermissionCode): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!can(user, permission)) redirect(`/unauthorized?permission=${encodeURIComponent(permission)}`);
  return user;
}

/** As `requirePageAccess`, but satisfied by any one of several permissions. */
export async function requirePageAccessAny(permissions: PermissionCode[]): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!canAny(user, permissions)) redirect(`/unauthorized?permission=${encodeURIComponent(permissions[0])}`);
  return user;
}
