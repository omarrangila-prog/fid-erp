import { prisma } from '@/lib/db';
import { normaliseTablePrefs, type TablePrefs } from '@/lib/table-prefs';

/**
 * Report and list layouts, kept per user in the settings table — the same
 * place the ledger layouts live — so a layout follows the person to any
 * browser. The key is built here from the signed-in user's id; nobody can
 * read or write another person's.
 */
const keyOf = (userId: string, table: string) => `table-prefs:${userId}:${table}`;

export async function getTablePrefs(userId: string, table: string): Promise<TablePrefs | null> {
  const row = await prisma.applicationSetting.findFirst({ where: { companyId: null, key: keyOf(userId, table) }, select: { value: true } });
  if (!row) return null;
  try {
    return normaliseTablePrefs(JSON.parse(row.value));
  } catch {
    return null;
  }
}

export async function setTablePrefs(userId: string, table: string, prefs: TablePrefs | null): Promise<void> {
  const key = keyOf(userId, table);
  const existing = await prisma.applicationSetting.findFirst({ where: { companyId: null, key }, select: { id: true } });
  if (prefs === null) {
    if (existing) await prisma.applicationSetting.delete({ where: { id: existing.id } });
    return;
  }
  const value = JSON.stringify(normaliseTablePrefs(prefs));
  if (existing) await prisma.applicationSetting.update({ where: { id: existing.id }, data: { value } });
  else await prisma.applicationSetting.create({ data: { companyId: null, key, value } });
}
