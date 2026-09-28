import { prisma } from '@/lib/db';
import {
  parseOverrides,
  parseScope,
  permissionsKey,
  scopeKey,
  type PermissionOverrides,
  type UserScope,
} from '@/lib/user-access';

/**
 * Reading and writing one person's permission changes and data scope.
 * Stored as global settings (no company): a person is the same person in
 * both companies, and an agent id only ever matches in its own company.
 */

async function write(key: string, value: string | null): Promise<void> {
  const existing = await prisma.applicationSetting.findFirst({ where: { companyId: null, key }, select: { id: true } });
  if (value === null) {
    if (existing) await prisma.applicationSetting.delete({ where: { id: existing.id } });
    return;
  }
  if (existing) await prisma.applicationSetting.update({ where: { id: existing.id }, data: { value } });
  else await prisma.applicationSetting.create({ data: { companyId: null, key, value } });
}

export async function getUserAccess(userId: string): Promise<{ overrides: PermissionOverrides; scope: UserScope }> {
  const rows = await prisma.applicationSetting.findMany({
    where: { companyId: null, key: { in: [permissionsKey(userId), scopeKey(userId)] } },
  });
  return {
    overrides: parseOverrides(rows.find((r) => r.key === permissionsKey(userId))?.value),
    scope: parseScope(rows.find((r) => r.key === scopeKey(userId))?.value),
  };
}

export async function setUserOverrides(userId: string, overrides: PermissionOverrides): Promise<void> {
  const empty = overrides.grant.length === 0 && overrides.revoke.length === 0;
  await write(permissionsKey(userId), empty ? null : JSON.stringify(overrides));
}

export async function setUserScope(userId: string, scope: UserScope): Promise<void> {
  const empty = !scope.agentId && scope.warehouseIds.length === 0;
  await write(scopeKey(userId), empty ? null : JSON.stringify(scope));
}
