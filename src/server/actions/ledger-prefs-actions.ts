'use server';

import { requireUser } from '@/lib/auth/session';
import { LEDGER_REPORT_KEYS, normaliseLedgerPrefs, type LedgerPrefs, type LedgerReportKey } from '@/lib/ledger-columns';
import { setLedgerPrefs } from '@/lib/services/ledger-prefs';
import { fail, type ActionResult } from '@/server/actions/action-utils';
import { BusinessRuleError } from '@/lib/errors';

/** Saves how this person wants one ledger laid out — or, with null, puts it back to the default. */
export async function saveLedgerPrefsAction(report: LedgerReportKey, prefs: LedgerPrefs | null): Promise<ActionResult<undefined>> {
  try {
    const user = await requireUser();
    if (!LEDGER_REPORT_KEYS.includes(report)) throw new BusinessRuleError('Unknown ledger.');
    await setLedgerPrefs(user.id, report, prefs === null ? null : normaliseLedgerPrefs(prefs));
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}
