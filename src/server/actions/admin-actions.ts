'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma, transaction } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { PERMISSIONS, ALL_PERMISSIONS, SYSTEM_ROLES } from '@/lib/constants';
import { ConflictError, NotFoundError, BusinessRuleError } from '@/lib/errors';
import { hashPassword } from '@/lib/auth/password';
import { destroyAllSessionsForUser } from '@/lib/auth/session';
import { isPinTaken, setPin, validatePinFormat, PIN_TAKEN_MESSAGE } from '@/lib/auth/pin';
import { getUserAccess, setUserOverrides, setUserScope } from '@/lib/services/user-access';
import { overridesFor } from '@/lib/user-access';
import { PIN_ONLY_EMAIL_DOMAIN } from '@/lib/pin-accounts';
import { randomBytes } from 'node:crypto';
import { writeAudit } from '@/lib/services/audit';
import { provisionCompany } from '@/lib/services/chart-of-accounts';
import { setSetting } from '@/lib/services/settings';
import { getRoleMenu, setRoleMenu } from '@/lib/services/role-menu';
import { setClosedUntil } from '@/lib/services/period';
import { formDataToObject, fieldErrors, requiredText, optionalText } from '@/lib/validation/common';
import { fail, type ActionResult } from '@/server/actions/action-utils';
import type { MasterFormState } from '@/server/actions/master-actions';

/**
 * Administration: users, roles, companies and settings.
 *
 * Two rules run through all of it. A user's company access and role set are
 * only ever changed by someone holding `users.manage`, and every change is
 * audited — an access grant is a financial control, not a preference.
 */

const userSchema = z.object({
  name: requiredText('Name', 120),
  /** Four digits. Required for a new user; blank on edit keeps the current PIN. */
  pin: z.string().trim().optional(),
  confirmPin: z.string().trim().optional(),
  isActive: z.coerce.boolean().default(true),
  isSuperAdmin: z.coerce.boolean().default(false),
  roleIds: z.union([z.string(), z.array(z.string())]).optional(),
  companyIds: z.union([z.string(), z.array(z.string())]).optional(),
  defaultCompanyId: optionalText(60),
  /** An agent signing in for himself: his agent record, which narrows what he sees to his own. */
  agentId: optionalText(60),
  warehouseIds: z.union([z.string(), z.array(z.string())]).optional(),
});

/** The PIN typed twice: both the same, four digits, not an obvious one, and nobody else's. */
async function checkNewPin(pin: string | undefined, confirmPin: string | undefined, userId: string | null): Promise<string> {
  const value = (pin ?? '').trim();
  if (value !== (confirmPin ?? '').trim()) throw new BusinessRuleError('The two PINs do not match.');
  const problem = validatePinFormat(value);
  if (problem) throw new BusinessRuleError(problem);
  if (await isPinTaken(value, userId)) throw new ConflictError(PIN_TAKEN_MESSAGE);
  return value;
}

/** The agent and warehouses must belong to the companies this person can open. */
async function checkScope(agentId: string | null, warehouseIds: string[], companyIds: string[], isSuperAdmin: boolean) {
  const companyFilter = isSuperAdmin ? {} : { companyId: { in: companyIds } };
  if (agentId) {
    const agent = await prisma.agent.findFirst({ where: { id: agentId, ...companyFilter }, select: { id: true } });
    if (!agent) throw new BusinessRuleError('That agent is not in a company this user can open.');
  }
  if (warehouseIds.length) {
    const found = await prisma.warehouse.count({ where: { id: { in: warehouseIds }, ...companyFilter } });
    if (found !== warehouseIds.length) throw new BusinessRuleError('A chosen warehouse is not in a company this user can open.');
  }
}

const roleSchema = z.object({
  code: requiredText('Role code', 40).transform((v) => v.toUpperCase().replace(/\s+/g, '_')),
  name: requiredText('Role name', 80),
  description: optionalText(300),
  permissions: z.union([z.string(), z.array(z.string())]).optional(),
});

const companySchema = z.object({
  code: requiredText('Company code', 20),
  name: requiredText('Company name', 160),
  legalName: optionalText(200),
  country: requiredText('Country', 100),
  localCurrency: z.string().trim().toUpperCase().length(3),
  timezone: requiredText('Timezone', 60),
  docPrefix: requiredText('Document prefix', 20),
  address: optionalText(400),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function invalid(error: unknown): MasterFormState {
  if (error instanceof z.ZodError) {
    return { ok: false, error: 'Please correct the highlighted fields.', errors: fieldErrors(error) };
  }
  const response = fail(error);
  return { ok: false, error: response.ok ? 'The action could not be completed.' : response.error };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function saveUserAction(
  id: string | null,
  _prev: MasterFormState,
  formData: FormData,
): Promise<MasterFormState> {
  try {
    const admin = await requirePermission(PERMISSIONS.USERS_MANAGE);
    const input = userSchema.parse(formDataToObject(formData));

    const roleIds = toArray(input.roleIds);
    const companyIds = toArray(input.companyIds);
    const warehouseIds = toArray(input.warehouseIds);
    const agentId = input.agentId || null;

    if (roleIds.length === 0) {
      throw new BusinessRuleError('Assign a role, otherwise the user can do nothing.');
    }
    if (!input.isSuperAdmin && companyIds.length === 0) {
      throw new BusinessRuleError('Assign at least one company, or make the user a Super Admin.');
    }

    // Only a Super Admin can mint another Super Admin.
    if (input.isSuperAdmin && !admin.isSuperAdmin) {
      throw new BusinessRuleError('Only a Super Admin can grant Super Admin access.');
    }
    await checkScope(agentId, warehouseIds, companyIds, input.isSuperAdmin);
    const scope = { agentId, warehouseIds };

    if (id) {
      const existing = await prisma.user.findUnique({ where: { id }, include: { roles: true, companies: true } });
      if (!existing) throw new NotFoundError('User');

      // A user must never be able to lock themselves out of administration.
      if (existing.id === admin.id && !input.isActive) {
        throw new BusinessRuleError('You cannot disable your own account.');
      }
      const newPin = input.pin ? await checkNewPin(input.pin, input.confirmPin, id) : null;

      await prisma.user.update({
        where: { id },
        data: {
          name: input.name,
          isActive: input.isActive,
          isSuperAdmin: input.isSuperAdmin,
          defaultCompanyId: input.defaultCompanyId || companyIds[0] || null,
        },
      });
      await prisma.userRole.deleteMany({ where: { userId: id } });
      await prisma.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: id, roleId })) });
      await prisma.userCompany.deleteMany({ where: { userId: id } });
      if (companyIds.length > 0) {
        await prisma.userCompany.createMany({ data: companyIds.map((companyId) => ({ userId: id, companyId })) });
      }
      const before = await getUserAccess(id);
      await setUserScope(id, scope);
      if (newPin) await setPin(id, newPin);

      // A new PIN, or access taken away, must not leave a live session.
      if (newPin || !input.isActive) await destroyAllSessionsForUser(id);

      await transaction(async (tx) => {
        await writeAudit(tx, {
          companyId: admin.activeCompany.id,
          userId: admin.id,
          action: 'USER_UPDATED',
          entityType: 'User',
          entityId: id,
          before: { name: existing.name, isActive: existing.isActive, roles: existing.roles.map((r) => r.roleId), scope: before.scope },
          after: { name: input.name, isActive: input.isActive, roles: roleIds, companies: companyIds, scope },
        });
        if (existing.isActive !== input.isActive) {
          await writeAudit(tx, {
            companyId: admin.activeCompany.id,
            userId: admin.id,
            action: input.isActive ? 'USER_ENABLED' : 'USER_DISABLED',
            entityType: 'User',
            entityId: id,
          });
        }
        // Never the PIN itself: only that it was changed, and by whom.
        if (newPin) {
          await writeAudit(tx, { companyId: admin.activeCompany.id, userId: admin.id, action: 'PIN_RESET', entityType: 'User', entityId: id });
        }
      });

      revalidatePath('/admin/users');
      revalidatePath(`/admin/users/${id}`);
      return { ok: true, id, message: newPin ? 'User saved. The new PIN works from now; the old one no longer does.' : 'User saved.' };
    }

    const pin = await checkNewPin(input.pin, input.confirmPin, null);

    // Sign-in is by PIN. The record still needs a unique email and a password
    // hash: an internal address that can never receive mail, and a random
    // password nobody knows, so neither can ever be used to sign in.
    const created = await prisma.user.create({
      data: {
        email: `${randomBytes(9).toString('hex')}@${PIN_ONLY_EMAIL_DOMAIN}`,
        name: input.name,
        passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
        isActive: input.isActive,
        isSuperAdmin: input.isSuperAdmin,
        defaultCompanyId: input.defaultCompanyId || companyIds[0] || null,
        roles: { create: roleIds.map((roleId) => ({ roleId })) },
        companies: { create: companyIds.map((companyId) => ({ companyId })) },
      },
    });
    await setPin(created.id, pin);
    await setUserScope(created.id, scope);

    await transaction((tx) =>
      writeAudit(tx, {
        companyId: admin.activeCompany.id,
        userId: admin.id,
        action: 'USER_CREATED',
        entityType: 'User',
        entityId: created.id,
        after: { name: input.name, roles: roleIds, companies: companyIds, scope, pinSet: true },
      }),
    );

    revalidatePath('/admin/users');
    return { ok: true, id: created.id, message: 'User created. They sign in with the PIN you set.' };
  } catch (error) {
    return invalid(error);
  }
}

/** Sets a new PIN. The old one stops working at once, and the user is signed out everywhere. */
export async function setUserPinAction(userId: string, pin: string, confirmPin: string): Promise<ActionResult<undefined>> {
  try {
    const admin = await requirePermission(PERMISSIONS.USERS_MANAGE);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundError('User');
    const value = await checkNewPin(pin, confirmPin, userId);
    await setPin(userId, value);
    if (userId !== admin.id) await destroyAllSessionsForUser(userId);
    await transaction((tx) =>
      writeAudit(tx, { companyId: admin.activeCompany.id, userId: admin.id, action: 'PIN_RESET', entityType: 'User', entityId: userId }),
    );
    revalidatePath('/admin/users');
    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/** Disable or enable an account. A disabled account cannot sign in, and is signed out now. */
export async function setUserActiveAction(userId: string, active: boolean): Promise<ActionResult<undefined>> {
  try {
    const admin = await requirePermission(PERMISSIONS.USERS_MANAGE);
    if (userId === admin.id && !active) throw new BusinessRuleError('You cannot disable your own account.');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true, isSuperAdmin: true } });
    if (!user) throw new NotFoundError('User');
    if (user.isSuperAdmin && !admin.isSuperAdmin) throw new BusinessRuleError('Only a Super Admin can change a Super Admin.');
    await prisma.user.update({ where: { id: userId }, data: { isActive: active } });
    if (!active) await destroyAllSessionsForUser(userId);
    await transaction((tx) =>
      writeAudit(tx, {
        companyId: admin.activeCompany.id,
        userId: admin.id,
        action: active ? 'USER_ENABLED' : 'USER_DISABLED',
        entityType: 'User',
        entityId: userId,
        before: { isActive: user.isActive },
        after: { isActive: active },
      }),
    );
    revalidatePath('/admin/users');
    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/**
 * One person's permissions, ticked on their own page: their role's, with the
 * owner's changes for them alone. Stored as the difference from the role, so
 * changing the role later still carries through everything not overridden.
 * Takes effect on their next page — no new PIN, no new account.
 */
export async function saveUserPermissionsAction(userId: string, codes: string[]): Promise<ActionResult<undefined>> {
  try {
    const admin = await requirePermission(PERMISSIONS.USERS_MANAGE);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isSuperAdmin: true, roles: { select: { role: { select: { permissions: { select: { permission: { select: { code: true } } } } } } } } },
    });
    if (!user) throw new NotFoundError('User');
    if (user.isSuperAdmin) throw new BusinessRuleError('A Super Admin has every permission; there is nothing to tick.');
    const wanted = [...new Set(codes)].filter((code) => ALL_PERMISSIONS.includes(code as never));
    if (userId === admin.id && !admin.isSuperAdmin && !wanted.includes(PERMISSIONS.USERS_MANAGE)) {
      throw new BusinessRuleError('Removing "Manage users" from yourself would lock you out of this screen.');
    }
    const role = user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.code));
    const before = await getUserAccess(userId);
    const overrides = overridesFor(role, wanted);
    await setUserOverrides(userId, overrides);
    await transaction((tx) =>
      writeAudit(tx, {
        companyId: admin.activeCompany.id,
        userId: admin.id,
        action: 'USER_PERMISSIONS_UPDATED',
        entityType: 'User',
        entityId: userId,
        before: before.overrides,
        after: overrides,
      }),
    );
    revalidatePath(`/admin/users/${userId}`);
    revalidatePath('/', 'layout');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function saveRoleAction(
  id: string | null,
  _prev: MasterFormState,
  formData: FormData,
): Promise<MasterFormState> {
  try {
    const admin = await requirePermission(PERMISSIONS.ROLES_MANAGE);
    const input = roleSchema.parse(formDataToObject(formData));
    const codes = toArray(input.permissions).filter((code) => ALL_PERMISSIONS.includes(code as never));

    const duplicate = await prisma.role.findFirst({
      where: { code: input.code, ...(id ? { NOT: { id } } : {}) },
      select: { id: true },
    });
    if (duplicate) throw new ConflictError(`Role code "${input.code}" already exists.`);

    const permissions = await prisma.permission.findMany({ where: { code: { in: codes } }, select: { id: true } });

    const role = id
      ? await prisma.role.update({
          where: { id },
          data: { code: input.code, name: input.name, description: input.description },
        })
      : await prisma.role.create({
          data: { code: input.code, name: input.name, description: input.description, isSystem: false },
        });

    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });

    await transaction((tx) =>
      writeAudit(tx, {
        companyId: admin.activeCompany.id,
        userId: admin.id,
        action: id ? 'ROLE_UPDATED' : 'ROLE_CREATED',
        entityType: 'Role',
        entityId: role.id,
        after: { code: input.code, permissions: permissions.length },
      }),
    );

    revalidatePath('/admin/roles');
    return { ok: true, id: role.id, message: 'Role saved.' };
  } catch (error) {
    return invalid(error);
  }
}

/**
 * The permission grid's save: the codes ticked for one role, replacing what it
 * had. Checked on the server like every permission — the grid only decides
 * what the role may do; each page and action still asks.
 */
export async function saveRolePermissionsAction(roleId: string, codes: string[]): Promise<ActionResult<undefined>> {
  try {
    const admin = await requirePermission(PERMISSIONS.ROLES_MANAGE);
    const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true, code: true } });
    if (!role) throw new NotFoundError('Role');
    const wanted = [...new Set(codes)].filter((code) => ALL_PERMISSIONS.includes(code as never));
    // Nobody takes away their own way back into this screen.
    if (!admin.isSuperAdmin && !wanted.includes(PERMISSIONS.ROLES_MANAGE) && admin.roleIds.includes(roleId)) {
      throw new BusinessRuleError('This is your own role: removing "Manage roles" would lock you out of this screen.');
    }
    const permissions = await prisma.permission.findMany({ where: { code: { in: wanted } }, select: { id: true, code: true } });
    const before = await prisma.rolePermission.findMany({ where: { roleId }, select: { permission: { select: { code: true } } } });
    await transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.rolePermission.createMany({
        data: permissions.map((p) => ({ roleId, permissionId: p.id })),
        skipDuplicates: true,
      });
      await writeAudit(tx, {
        companyId: admin.activeCompany.id,
        userId: admin.id,
        action: 'ROLE_PERMISSIONS_UPDATED',
        entityType: 'Role',
        entityId: roleId,
        before: { permissions: before.map((b) => b.permission.code).sort() },
        after: { permissions: permissions.map((p) => p.code).sort() },
      });
    });
    revalidatePath('/admin/roles');
    revalidatePath(`/admin/roles/${roleId}`);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Adds any standard role this installation does not have yet — the Agent role
 * when it first appeared, for instance — with its standard permissions.
 * Roles that already exist are left exactly as the owner has set them.
 */
export async function addMissingStandardRolesAction(): Promise<ActionResult<{ added: string[] }>> {
  try {
    const admin = await requirePermission(PERMISSIONS.ROLES_MANAGE);
    const existing = new Set((await prisma.role.findMany({ select: { code: true } })).map((r) => r.code));
    const missing = SYSTEM_ROLES.filter((r) => !existing.has(r.code));
    for (const template of missing) {
      const permissions = await prisma.permission.findMany({ where: { code: { in: template.permissions } }, select: { id: true } });
      await transaction(async (tx) => {
        const role = await tx.role.create({
          data: { code: template.code, name: template.name, description: template.description, isSystem: true },
        });
        await tx.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })), skipDuplicates: true });
        await writeAudit(tx, {
          companyId: admin.activeCompany.id,
          userId: admin.id,
          action: 'ROLE_CREATED',
          entityType: 'Role',
          entityId: role.id,
          after: { code: template.code, permissions: template.permissions.length, from: 'standard template' },
        });
      });
    }
    revalidatePath('/admin/roles');
    revalidatePath('/admin/users');
    return { ok: true, data: { added: missing.map((r) => r.name) } };
  } catch (error) {
    return fail(error);
  }
}

/** The pages a role sees first in its menu, in the order the owner chose. */
export async function saveRoleMenuAction(roleId: string, hrefs: string[]): Promise<ActionResult<undefined>> {
  try {
    const admin = await requirePermission(PERMISSIONS.ROLES_MANAGE);
    const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true } });
    if (!role) throw new NotFoundError('Role');
    const before = await getRoleMenu(roleId);
    const after = await setRoleMenu(roleId, hrefs);
    await writeAudit(prisma, {
      companyId: admin.activeCompany.id,
      userId: admin.id,
      action: 'ROLE_MENU_UPDATED',
      entityType: 'Role',
      entityId: roleId,
      before: { pages: before },
      after: { pages: after },
    });
    revalidatePath('/', 'layout');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export async function saveCompanyAction(
  id: string | null,
  _prev: MasterFormState,
  formData: FormData,
): Promise<MasterFormState> {
  try {
    const admin = await requirePermission(PERMISSIONS.COMPANIES_MANAGE);
    const input = companySchema.parse(formDataToObject(formData));

    const duplicate = await prisma.company.findFirst({
      where: { code: input.code, ...(id ? { NOT: { id } } : {}) },
      select: { id: true },
    });
    if (duplicate) throw new ConflictError(`Company code "${input.code}" already exists.`);

    if (id) {
      const existing = await prisma.company.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError('Company');

      // The local currency anchors every historical translation, so it is
      // frozen the moment anything has been posted.
      const hasPostings = await prisma.journalEntry.count({ where: { companyId: id } });
      if (hasPostings > 0 && existing.localCurrency !== input.localCurrency) {
        throw new BusinessRuleError(
          'The local currency cannot be changed once transactions have been posted — it would restate every historical figure.',
        );
      }

      await prisma.company.update({ where: { id }, data: input });

      await transaction((tx) =>
        writeAudit(tx, {
          companyId: admin.activeCompany.id,
          userId: admin.id,
          action: 'COMPANY_UPDATED',
          entityType: 'Company',
          entityId: id,
          before: existing,
          after: input,
        }),
      );

      revalidatePath('/admin/companies');
      return { ok: true, id, message: 'Company saved.' };
    }

    const created = await prisma.company.create({ data: { ...input, baseCurrency: 'USD' } });
    await transaction((tx) => provisionCompany(tx, created.id));

    await transaction((tx) =>
      writeAudit(tx, {
        companyId: admin.activeCompany.id,
        userId: admin.id,
        action: 'COMPANY_CREATED',
        entityType: 'Company',
        entityId: created.id,
        after: input,
      }),
    );

    revalidatePath('/admin/companies');
    return { ok: true, id: created.id, message: 'Company created with its chart of accounts.' };
  } catch (error) {
    return invalid(error);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function saveSettingAction(key: string, value: string): Promise<ActionResult<undefined>> {
  try {
    const admin = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    await setSetting(admin.activeCompany.id, key, value);

    await transaction((tx) =>
      writeAudit(tx, {
        companyId: admin.activeCompany.id,
        userId: admin.id,
        action: 'SETTING_CHANGED',
        entityType: 'ApplicationSetting',
        entityId: key,
        after: { key, value },
      }),
    );

    revalidatePath('/settings');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Accounting period control
// ---------------------------------------------------------------------------

/**
 * Closes the books up to a date, or reopens them when given null.
 *
 * Closing is not a formality: after this, nothing — no invoice, receipt,
 * expense, transfer or journal — can be posted on or before the date, for
 * anybody. Reopening is equally serious and equally audited.
 */
export async function setPeriodCloseAction(closedUntil: string | null): Promise<ActionResult<undefined>> {
  try {
    const admin = await requirePermission(PERMISSIONS.PERIODS_CLOSE);

    let date: Date | null = null;
    if (closedUntil) {
      date = new Date(`${closedUntil}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime())) {
        throw new BusinessRuleError('That is not a valid date.');
      }
      if (date.getTime() > Date.now()) {
        throw new BusinessRuleError('A period cannot be closed into the future.');
      }
    }

    await setClosedUntil(admin.activeCompany.id, date);

    await transaction((tx) =>
      writeAudit(tx, {
        companyId: admin.activeCompany.id,
        userId: admin.id,
        action: date ? 'PERIOD_CLOSED' : 'PERIOD_REOPENED',
        entityType: 'AccountingPeriod',
        entityId: admin.activeCompany.id,
        after: { closedUntil: closedUntil ?? null },
      }),
    );

    revalidatePath('/settings');
    revalidatePath('/reports');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}
