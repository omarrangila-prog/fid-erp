'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma, transaction } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { PERMISSIONS, ALL_PERMISSIONS } from '@/lib/constants';
import { ConflictError, NotFoundError, BusinessRuleError } from '@/lib/errors';
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password';
import { destroyAllSessionsForUser } from '@/lib/auth/session';
import { writeAudit } from '@/lib/services/audit';
import { provisionCompany } from '@/lib/services/chart-of-accounts';
import { setSetting } from '@/lib/services/settings';
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
  email: z.email('Enter a valid email address.').transform((v) => v.toLowerCase()),
  name: requiredText('Name', 120),
  password: z.string().optional(),
  isActive: z.coerce.boolean().default(true),
  isSuperAdmin: z.coerce.boolean().default(false),
  roleIds: z.union([z.string(), z.array(z.string())]).optional(),
  companyIds: z.union([z.string(), z.array(z.string())]).optional(),
  defaultCompanyId: optionalText(60),
});

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

    if (roleIds.length === 0) {
      throw new BusinessRuleError('Assign at least one role, otherwise the user can do nothing.');
    }
    if (!input.isSuperAdmin && companyIds.length === 0) {
      throw new BusinessRuleError('Assign at least one company, or make the user a Super Admin.');
    }

    const duplicate = await prisma.user.findFirst({
      where: { email: input.email, ...(id ? { NOT: { id } } : {}) },
      select: { id: true },
    });
    if (duplicate) throw new ConflictError(`${input.email} is already in use.`);

    // Only a Super Admin can mint another Super Admin.
    if (input.isSuperAdmin && !admin.isSuperAdmin) {
      throw new BusinessRuleError('Only a Super Admin can grant Super Admin access.');
    }

    if (id) {
      const existing = await prisma.user.findUnique({ where: { id }, include: { roles: true, companies: true } });
      if (!existing) throw new NotFoundError('User');

      // A user must never be able to lock themselves out of administration.
      if (existing.id === admin.id && !input.isActive) {
        throw new BusinessRuleError('You cannot deactivate your own account.');
      }

      const data: Record<string, unknown> = {
        email: input.email,
        name: input.name,
        isActive: input.isActive,
        isSuperAdmin: input.isSuperAdmin,
        defaultCompanyId: input.defaultCompanyId || companyIds[0] || null,
      };

      if (input.password) {
        const weakness = validatePasswordStrength(input.password);
        if (weakness) throw new BusinessRuleError(weakness);
        data.passwordHash = await hashPassword(input.password);
      }

      await prisma.user.update({ where: { id }, data });
      await prisma.userRole.deleteMany({ where: { userId: id } });
      await prisma.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: id, roleId })) });
      await prisma.userCompany.deleteMany({ where: { userId: id } });
      if (companyIds.length > 0) {
        await prisma.userCompany.createMany({ data: companyIds.map((companyId) => ({ userId: id, companyId })) });
      }

      // Changing a password or revoking access must not leave a live session.
      if (input.password || !input.isActive) {
        await destroyAllSessionsForUser(id);
      }

      await transaction((tx) =>
        writeAudit(tx, {
          companyId: admin.activeCompany.id,
          userId: admin.id,
          action: 'USER_UPDATED',
          entityType: 'User',
          entityId: id,
          before: { email: existing.email, isActive: existing.isActive, roles: existing.roles.length },
          after: { email: input.email, isActive: input.isActive, roles: roleIds.length, companies: companyIds.length },
        }),
      );

      revalidatePath('/admin/users');
      return { ok: true, id, message: 'User saved.' };
    }

    if (!input.password) throw new BusinessRuleError('Set a password for the new user.');
    const weakness = validatePasswordStrength(input.password);
    if (weakness) throw new BusinessRuleError(weakness);

    const created = await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        isActive: input.isActive,
        isSuperAdmin: input.isSuperAdmin,
        defaultCompanyId: input.defaultCompanyId || companyIds[0] || null,
        roles: { create: roleIds.map((roleId) => ({ roleId })) },
        companies: { create: companyIds.map((companyId) => ({ companyId })) },
      },
    });

    await transaction((tx) =>
      writeAudit(tx, {
        companyId: admin.activeCompany.id,
        userId: admin.id,
        action: 'USER_CREATED',
        entityType: 'User',
        entityId: created.id,
        after: { email: input.email, roles: roleIds.length, companies: companyIds.length },
      }),
    );

    revalidatePath('/admin/users');
    return { ok: true, id: created.id, message: 'User created.' };
  } catch (error) {
    return invalid(error);
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
