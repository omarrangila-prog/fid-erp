import { prisma } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';

/**
 * Custom reports: a report with its period, columns, comparison and filters
 * saved under a name of the user's choosing, so it opens the same way next
 * time without setting everything again.
 *
 * A saved report is nothing more than the report's address — its path and
 * query string — kept per user, per company. That keeps it honest: the
 * figures are always calculated fresh when it is opened, and a Morocco user's
 * saved view can never surface Dubai data because it is opened under the
 * company they are signed into.
 *
 * They live in the application settings table under a per-user key, which
 * needs no new table and follows the person across devices.
 */

export type SavedReport = {
  id: string;
  name: string;
  /** Relative path and query, e.g. `/reports/profit-loss?columns=month`. */
  href: string;
  createdAt: string;
};

const MAX_SAVED = 50;
const settingKey = (userId: string) => `reports.saved.${userId}`;

function parse(raw: string | undefined | null): SavedReport[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (r): r is SavedReport =>
        typeof r === 'object' && r !== null && typeof (r as SavedReport).id === 'string' && typeof (r as SavedReport).href === 'string',
    );
  } catch {
    return [];
  }
}

/** Only an address inside this application is ever saved or followed. */
export function assertReportHref(href: string) {
  if (!href.startsWith('/') || href.startsWith('//') || href.includes('://') || href.length > 1000) {
    throw new BusinessRuleError('That is not a report address in this application.');
  }
}

export async function listSavedReports(companyId: string, userId: string): Promise<SavedReport[]> {
  const row = await prisma.applicationSetting.findFirst({ where: { companyId, key: settingKey(userId) } });
  return parse(row?.value);
}

async function write(companyId: string, userId: string, list: SavedReport[]) {
  const key = settingKey(userId);
  const value = JSON.stringify(list);
  const existing = await prisma.applicationSetting.findFirst({ where: { companyId, key } });
  if (existing) await prisma.applicationSetting.update({ where: { id: existing.id }, data: { value } });
  else await prisma.applicationSetting.create({ data: { companyId, key, value } });
}

export async function saveReport(params: { companyId: string; userId: string; name: string; href: string }): Promise<SavedReport> {
  const name = params.name.trim();
  if (name.length === 0) throw new BusinessRuleError('Give the report a name.');
  if (name.length > 80) throw new BusinessRuleError('Keep the name under 80 characters.');
  assertReportHref(params.href);

  const list = await listSavedReports(params.companyId, params.userId);
  if (list.length >= MAX_SAVED) throw new BusinessRuleError(`You already have ${MAX_SAVED} saved reports. Remove one first.`);

  // Saving under a name already used replaces that view rather than adding a twin.
  const kept = list.filter((r) => r.name.toLowerCase() !== name.toLowerCase());
  const saved: SavedReport = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name,
    href: params.href,
    createdAt: new Date().toISOString(),
  };
  await write(params.companyId, params.userId, [saved, ...kept]);
  return saved;
}

export async function removeSavedReport(params: { companyId: string; userId: string; id: string }) {
  const list = await listSavedReports(params.companyId, params.userId);
  if (!list.some((r) => r.id === params.id)) throw new NotFoundError('Saved report');
  await write(params.companyId, params.userId, list.filter((r) => r.id !== params.id));
}
