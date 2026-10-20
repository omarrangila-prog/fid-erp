'use server';

import { requireUser } from '@/lib/auth/session';
import { isTablePrefsKey, type TablePrefs } from '@/lib/table-prefs';
import { getTablePrefs, setTablePrefs } from '@/lib/services/table-prefs';
import { fail, type ActionResult } from '@/server/actions/action-utils';
import { BusinessRuleError } from '@/lib/errors';

/** This person's saved layout for one table, or null for the table's own. */
export async function getTablePrefsAction(table: string): Promise<ActionResult<TablePrefs | null>> {
  try {
    const user = await requireUser();
    if (!isTablePrefsKey(table)) throw new BusinessRuleError('Unknown table.');
    return { ok: true, data: await getTablePrefs(user.id, table) };
  } catch (error) {
    return fail(error);
  }
}

/** Saves this person's layout for one table — or, with null, puts it back to the default. */
export async function saveTablePrefsAction(table: string, prefs: TablePrefs | null): Promise<ActionResult<undefined>> {
  try {
    const user = await requireUser();
    if (!isTablePrefsKey(table)) throw new BusinessRuleError('Unknown table.');
    await setTablePrefs(user.id, table, prefs);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}
