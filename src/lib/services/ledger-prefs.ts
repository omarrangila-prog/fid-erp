import { prisma } from '@/lib/db';
import { ledgerPrefsKey, normaliseLedgerPrefs, type LedgerColumnKey, type LedgerPrefs, type LedgerReportKey } from '@/lib/ledger-columns';

/** One person's layout for one ledger, or the default. Kept in the settings table, per user and per ledger. */
export async function getLedgerPrefs(
  userId: string,
  report: LedgerReportKey,
  available?: readonly LedgerColumnKey[],
): Promise<LedgerPrefs> {
  const row = await prisma.applicationSetting.findFirst({
    where: { companyId: null, key: ledgerPrefsKey(userId, report) },
    select: { value: true },
  });
  let parsed: unknown = null;
  try {
    parsed = row ? JSON.parse(row.value) : null;
  } catch {
    parsed = null;
  }
  return { ...normaliseLedgerPrefs(parsed, available), saved: Boolean(row) };
}

export async function setLedgerPrefs(userId: string, report: LedgerReportKey, prefs: LedgerPrefs | null): Promise<void> {
  const key = ledgerPrefsKey(userId, report);
  const existing = await prisma.applicationSetting.findFirst({ where: { companyId: null, key }, select: { id: true } });
  if (prefs === null) {
    if (existing) await prisma.applicationSetting.delete({ where: { id: existing.id } });
    return;
  }
  const value = JSON.stringify(normaliseLedgerPrefs(prefs));
  if (existing) await prisma.applicationSetting.update({ where: { id: existing.id }, data: { value } });
  else await prisma.applicationSetting.create({ data: { companyId: null, key, value } });
}
