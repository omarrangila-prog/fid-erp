import 'server-only';
import { prisma } from '@/lib/db';
import { organizationCount } from '@/lib/org-count';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import { isDeveloper } from '@/lib/auth/developer';
import type { SessionUser } from '@/lib/auth/session';

/**
 * Who may see and change whom.
 *
 * The tenancy tree is Organization → Company. Companies are scoped by
 * `companyId` on every row; people and custom roles are scoped by
 * `organizationId`. An administrator — however powerful inside their own
 * organization — is confined to it: a record from another organization is
 * reported as "not found", never as "forbidden", so its existence cannot even
 * be probed.
 *
 * The platform operator (named in DEVELOPER_USERS) manages organizations from
 * `/platform` and is deliberately given no way through this file to read an
 * organization's people or figures.
 */

/** Prisma filter for "people in my organization". */
export const peopleOf = (admin: Pick<SessionUser, 'organizationId'>) => ({ organizationId: admin.organizationId ?? null });

/** Prisma filter for "companies in my organization". */
export const companiesOf = (admin: Pick<SessionUser, 'organizationId'>) => ({ organizationId: admin.organizationId ?? null });

/** Prisma filter for "roles I may see": the shared system roles and my organization's own. */
export const rolesVisibleTo = (admin: Pick<SessionUser, 'organizationId'>) => ({
  OR: [{ organizationId: null }, ...(admin.organizationId ? [{ organizationId: admin.organizationId }] : [])],
});

/** The person must be in the administrator's organization. */
export async function assertManagesUser(admin: Pick<SessionUser, 'organizationId'>, userId: string): Promise<void> {
  const found = await prisma.user.findFirst({ where: { id: userId, ...peopleOf(admin) }, select: { id: true } });
  if (!found) throw new NotFoundError('User');
}

/** Every company id must belong to the administrator's organization. */
export async function assertCompaniesInOrg(admin: Pick<SessionUser, 'organizationId'>, companyIds: string[]): Promise<void> {
  if (companyIds.length === 0) return;
  const unique = [...new Set(companyIds)];
  const count = await prisma.company.count({ where: { id: { in: unique }, ...companiesOf(admin) } });
  if (count !== unique.length) throw new NotFoundError('Company');
}

/** Every role id must be one the administrator may hand out. */
export async function assertRolesUsable(admin: Pick<SessionUser, 'organizationId'>, roleIds: string[]): Promise<void> {
  if (roleIds.length === 0) return;
  const unique = [...new Set(roleIds)];
  const count = await prisma.role.count({ where: { id: { in: unique }, ...rolesVisibleTo(admin) } });
  if (count !== unique.length) throw new NotFoundError('Role');
}

/**
 * A deployment with one customer (FID's) lets its owner tune the standard
 * roles, exactly as before. Once there are several customers a standard role
 * is shared by all of them, so only the platform operator may change it; a
 * customer copies it into a role of their own instead.
 */
export async function isSingleTenantDeployment(): Promise<boolean> {
  return (await organizationCount()) <= 1;
}

/**
 * Whole-database tools (the pg_dump backup) are only for a deployment that
 * holds one customer, or for the platform operator. A customer of a shared
 * deployment gets their own data out through the exports instead.
 */
export async function wholeDatabaseToolsAllowed(user: Pick<SessionUser, 'id' | 'email'>): Promise<boolean> {
  return isDeveloper(user) || (await isSingleTenantDeployment());
}

/** May this administrator change this role's permissions, name or menu? */
export async function canEditRole(
  admin: Pick<SessionUser, 'id' | 'email' | 'organizationId'>,
  role: { organizationId: string | null; isSystem: boolean },
): Promise<boolean> {
  if (role.organizationId) return role.organizationId === (admin.organizationId ?? null);
  if (isDeveloper(admin)) return true;
  return isSingleTenantDeployment();
}

export async function assertCanEditRole(
  admin: Pick<SessionUser, 'id' | 'email' | 'organizationId'>,
  roleId: string,
): Promise<{ id: string; code: string; organizationId: string | null; isSystem: boolean }> {
  const role = await prisma.role.findFirst({
    where: { id: roleId, ...rolesVisibleTo(admin) },
    select: { id: true, code: true, organizationId: true, isSystem: true },
  });
  if (!role) throw new NotFoundError('Role');
  if (!(await canEditRole(admin, role))) {
    throw new ForbiddenError('This is a standard role shared by every customer. Make your own role instead and give it the permissions you want.');
  }
  return role;
}
