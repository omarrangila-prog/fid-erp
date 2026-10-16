'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { isDeveloper } from '@/lib/auth/developer';
import { ForbiddenError } from '@/lib/errors';
import { COUNTRIES } from '@/lib/countries';
import { isTemplateKey } from '@/lib/templates';
import { PLANS } from '@/lib/entitlements';
import { createTenant, resetOwnerPassword, setOrganizationPlan, setOrganizationStatus } from '@/lib/services/tenant';
import { tenantHealth } from '@/lib/services/platform';
import { fail, run, type ActionResult } from '@/server/actions/action-utils';

/**
 * The platform operator's console. Named in DEVELOPER_USERS on the server —
 * not a permission anyone can grant from inside an organization.
 */
async function operator() {
  const user = await requireUser();
  if (!isDeveloper(user)) throw new ForbiddenError('This area is for the platform operator.');
  return user;
}

const createSchema = z.object({
  organizationName: z.string().trim().min(2).max(160),
  companyName: z.string().trim().min(2).max(160),
  country: z.string().refine((c) => COUNTRIES.some((x) => x.name === c), 'Choose a country from the list.'),
  industryTemplate: z.string().refine(isTemplateKey, 'Choose an industry preset.'),
  plan: z.string().refine((p) => p in PLANS, 'Choose a plan.'),
  ownerName: z.string().trim().min(2).max(120),
  ownerEmail: z.string().trim().toLowerCase().email(),
});

export async function createTenantAction(input: z.input<typeof createSchema>): Promise<ActionResult<{ companyCode: string; email: string; password: string }>> {
  return run(async () => {
    const op = await operator();
    const data = createSchema.parse(input);
    const created = await createTenant({
      organizationName: data.organizationName,
      plan: data.plan,
      company: { name: data.companyName, country: data.country, industryTemplate: data.industryTemplate },
      owner: { name: data.ownerName, email: data.ownerEmail },
      actorUserId: op.id,
    });
    revalidatePath('/platform');
    return { companyCode: created.companyCode, email: data.ownerEmail, password: created.temporaryPassword! };
  });
}

export async function setTenantStatusAction(organizationId: string, active: boolean): Promise<ActionResult<undefined>> {
  return run(async () => {
    const op = await operator();
    await setOrganizationStatus({ organizationId, active, actorUserId: op.id });
    revalidatePath('/platform');
    return undefined;
  });
}

export async function setTenantPlanAction(organizationId: string, plan: string): Promise<ActionResult<undefined>> {
  return run(async () => {
    const op = await operator();
    await setOrganizationPlan({ organizationId, plan, actorUserId: op.id });
    revalidatePath('/platform');
    return undefined;
  });
}

export async function resetTenantOwnerAction(organizationId: string): Promise<ActionResult<{ email: string; password: string }>> {
  return run(async () => {
    const op = await operator();
    return resetOwnerPassword({ organizationId, actorUserId: op.id });
  });
}

export async function tenantHealthAction(organizationId: string): Promise<ActionResult<Array<{ code: string; passed: number; total: number }>>> {
  try {
    await operator();
    return { ok: true, data: await tenantHealth(organizationId) };
  } catch (error) {
    return fail(error);
  }
}
