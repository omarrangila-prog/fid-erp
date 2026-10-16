import { prisma } from '@/lib/db';
import { rolesVisibleTo } from '@/lib/auth/tenant';

import { ONBOARDING_KEY } from '@/lib/constants';

export { ONBOARDING_KEY };

/** A company made by the platform starts "pending" until its owner finishes (or skips) the wizard. */
export async function getOnboardingStatus(companyId: string): Promise<'pending' | 'done'> {
  const row = await prisma.applicationSetting.findFirst({ where: { companyId, key: ONBOARDING_KEY } });
  return row?.value === 'pending' ? 'pending' : 'done';
}

/** Roles an owner may give a new teammate: the standard ones and the organization's own, never Super Admin. */
export async function listAssignableRoles(admin: { organizationId?: string | null }) {
  return prisma.role.findMany({
    where: { ...rolesVisibleTo(admin), code: { not: 'SUPER_ADMIN' } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, description: true },
  });
}
