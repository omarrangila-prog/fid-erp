import type { Tx } from '@/lib/db';
import { prisma } from '@/lib/db';
import { SETTING_KEYS, DEFAULT_ETA_ALERT_DAYS } from '@/lib/constants';

/**
 * Company-scoped settings with a global fallback. A company row overrides the
 * global row of the same key; if neither exists the coded default applies.
 */

const DEFAULTS: Record<string, string> = {
  [SETTING_KEYS.ALLOW_NEGATIVE_STOCK]: 'false',
  [SETTING_KEYS.ETA_ALERT_DAYS]: DEFAULT_ETA_ALERT_DAYS.join(','),
  [SETTING_KEYS.DEFAULT_PAYMENT_TERM_DAYS]: '30',
};

export async function getSetting(client: Tx, companyId: string | null, key: string): Promise<string> {
  const rows = await client.applicationSetting.findMany({
    where: { key, OR: [{ companyId }, { companyId: null }] },
  });
  const scoped = rows.find((r) => r.companyId === companyId);
  const global = rows.find((r) => r.companyId === null);
  return scoped?.value ?? global?.value ?? DEFAULTS[key] ?? '';
}

export async function getBooleanSetting(client: Tx, companyId: string | null, key: string): Promise<boolean> {
  return (await getSetting(client, companyId, key)).toLowerCase() === 'true';
}

export async function getNumberSetting(client: Tx, companyId: string | null, key: string, fallback: number): Promise<number> {
  const raw = await getSetting(client, companyId, key);
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function getEtaAlertDays(client: Tx, companyId: string): Promise<number[]> {
  const raw = await getSetting(client, companyId, SETTING_KEYS.ETA_ALERT_DAYS);
  const parsed = raw
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : DEFAULT_ETA_ALERT_DAYS;
}

export async function setSetting(companyId: string | null, key: string, value: string): Promise<void> {
  const existing = await prisma.applicationSetting.findFirst({ where: { companyId, key } });
  if (existing) {
    await prisma.applicationSetting.update({ where: { id: existing.id }, data: { value } });
  } else {
    await prisma.applicationSetting.create({ data: { companyId, key, value } });
  }
}

export async function getAllSettings(companyId: string | null) {
  const rows = await prisma.applicationSetting.findMany({
    where: { OR: [{ companyId }, { companyId: null }] },
    orderBy: { key: 'asc' },
  });
  const merged = new Map<string, { key: string; value: string; scope: 'company' | 'global' | 'default' }>();
  for (const [key, value] of Object.entries(DEFAULTS)) merged.set(key, { key, value, scope: 'default' });
  for (const row of rows.filter((r) => r.companyId === null)) {
    merged.set(row.key, { key: row.key, value: row.value, scope: 'global' });
  }
  for (const row of rows.filter((r) => r.companyId === companyId)) {
    merged.set(row.key, { key: row.key, value: row.value, scope: 'company' });
  }
  return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export { SETTING_KEYS };
