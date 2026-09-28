'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireUser, type SessionUser } from '@/lib/auth/session';
import { can, canAny } from '@/lib/auth/guards';
import { isDeveloper } from '@/lib/auth/developer';
import { PERMISSIONS } from '@/lib/constants';
import { BusinessRuleError, ForbiddenError } from '@/lib/errors';
import { createShareLink, logShareEvents, revokeShareLink } from '@/lib/services/report-share';
import {
  SHARE_EXPIRY,
  isShareReportKey,
  shareReportPermissions,
  type ShareEvent,
  type ShareExpiry,
  type ShareMeta,
  type ShareSnapshot,
} from '@/lib/share/model';
import { fail, ok, type ActionResult } from '@/server/actions/action-utils';

function actorOf(user: SessionUser) {
  return {
    id: user.id,
    name: user.name,
    roleNames: user.roleNames,
    isSuperAdmin: user.isSuperAdmin,
    canManageUsers: can(user, PERMISSIONS.USERS_MANAGE),
    isDeveloper: isDeveloper(user),
  };
}

async function client() {
  const h = await headers();
  return {
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
  };
}

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!host) throw new BusinessRuleError('The link could not be made: the address of this site is unknown.');
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Whoever can see this kind of report may share it; the server checks, not the button. */
function assertMayShare(user: SessionUser, report: string) {
  if (!isShareReportKey(report)) throw new BusinessRuleError('This report cannot be shared.');
  if (!canAny(user, shareReportPermissions(report))) throw new ForbiddenError('You cannot share this report.');
}

export async function logShareEventsAction(meta: ShareMeta, events: ShareEvent[]): Promise<ActionResult<undefined>> {
  try {
    const user = await requireUser();
    assertMayShare(user, meta.report);
    await logShareEvents({ actor: actorOf(user), companyId: user.activeCompany.id, meta, events, client: await client() });
    return ok(undefined);
  } catch (error) {
    return fail(error);
  }
}

export async function createShareLinkAction(
  meta: ShareMeta,
  snapshot: ShareSnapshot,
  expiry: ShareExpiry,
): Promise<ActionResult<{ url: string; expiresAt: string | null }>> {
  try {
    const user = await requireUser();
    assertMayShare(user, meta.report);
    if (!SHARE_EXPIRY.includes(expiry)) throw new BusinessRuleError('Choose when the link expires.');
    const at = await client();
    // The share is logged as begun even when the link then fails, so the log shows the attempt.
    await logShareEvents({ actor: actorOf(user), companyId: user.activeCompany.id, meta, events: ['SHARE_INITIATED'], client: at });
    const link = await createShareLink({
      actor: actorOf(user),
      companyId: user.activeCompany.id,
      meta,
      snapshot: { ...snapshot, company: user.activeCompany.name, generatedBy: user.name },
      expiry,
      client: at,
    });
    return ok({ url: `${await origin()}/s/${link.token}`, expiresAt: link.expiresAt });
  } catch (error) {
    return fail(error);
  }
}

export async function revokeShareLinkAction(shareId: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requireUser();
    await revokeShareLink({ actor: actorOf(user), companyId: user.activeCompany.id, shareId, client: await client() });
    revalidatePath('/admin/shared-links');
    revalidatePath('/admin/share-activity');
    return ok(undefined, 'Link revoked. It no longer opens.');
  } catch (error) {
    return fail(error);
  }
}
