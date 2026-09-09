import type { Tx } from '@/lib/db';
import { prisma } from '@/lib/db';
import { SETTING_KEYS } from '@/lib/constants';
import { BusinessRuleError } from '@/lib/errors';
import { getSetting, setSetting } from '@/lib/services/settings';

/**
 * Accounting period control.
 *
 * A closed period is one that has been reported on. Letting a back-dated entry
 * land in it silently changes a statement somebody has already acted on, so
 * everything that writes to the ledger is refused for those dates.
 *
 * The check lives in `postJournalEntry` rather than in each document service:
 * that is the single point every posting passes through, so a new document type
 * cannot accidentally be exempt.
 */

/** The last closed date, or null when the books are open. */
export async function getClosedUntil(client: Tx, companyId: string): Promise<Date | null> {
  const raw = await getSetting(client, companyId, SETTING_KEYS.PERIOD_CLOSED_UNTIL);
  if (!raw) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function midnightUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Refuses a posting dated on or before the close date. Called from the posting
 * engine; `entryDate` is the date the entry will carry, not today.
 */
export async function assertPeriodOpen(client: Tx, companyId: string, entryDate: Date): Promise<void> {
  const closedUntil = await getClosedUntil(client, companyId);
  if (!closedUntil) return;

  if (midnightUtc(entryDate).getTime() <= closedUntil.getTime()) {
    const closed = closedUntil.toISOString().slice(0, 10);
    throw new BusinessRuleError(
      `The accounting period up to ${closed} is closed, so nothing can be posted on or before that date. ` +
        'Use a later date, or ask an administrator to reopen the period.',
    );
  }
}

/** Closing sets the date; passing null reopens everything after it. */
export async function setClosedUntil(companyId: string, closedUntil: Date | null): Promise<void> {
  await setSetting(companyId, SETTING_KEYS.PERIOD_CLOSED_UNTIL, closedUntil ? closedUntil.toISOString().slice(0, 10) : '');
}

/** What a period contains, so an administrator can see before they freeze it. */
export async function summarisePeriod(companyId: string, upTo: Date) {
  const where = { companyId, entryDate: { lte: upTo }, status: 'POSTED' as const };
  const [entries, earliest, latest] = await Promise.all([
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.findFirst({ where, orderBy: { entryDate: 'asc' }, select: { entryDate: true } }),
    prisma.journalEntry.findFirst({ where, orderBy: { entryDate: 'desc' }, select: { entryDate: true } }),
  ]);
  return {
    entries,
    earliest: earliest?.entryDate ?? null,
    latest: latest?.entryDate ?? null,
  };
}
