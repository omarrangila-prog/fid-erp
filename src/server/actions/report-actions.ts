'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { saveReport, removeSavedReport, type SavedReport } from '@/lib/services/saved-reports';
import { fail, ok, type ActionResult } from '@/server/actions/action-utils';

/** Keep the report open on screen, under a name, for next time. */
export async function saveReportViewAction(input: { name: string; href: string }): Promise<ActionResult<SavedReport>> {
  try {
    const user = await requireUser();
    const saved = await saveReport({ companyId: user.activeCompany.id, userId: user.id, name: input.name, href: input.href });
    revalidatePath('/reports');
    return ok(saved, `Saved as “${saved.name}”. Find it under My custom reports.`);
  } catch (error) {
    return fail(error);
  }
}

export async function removeSavedReportAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requireUser();
    await removeSavedReport({ companyId: user.activeCompany.id, userId: user.id, id });
    revalidatePath('/reports');
    return ok(undefined, 'Removed.');
  } catch (error) {
    return fail(error);
  }
}
