'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { restateInventorySplit } from '@/lib/services/inventory-split';
import { fail, type ActionResult } from '@/server/actions/action-utils';

/** Restates the stock / cost-of-sales split now, for someone allowed to post to the ledger. */
export async function restateInventorySplitAction(): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const result = await restateInventorySplit({ companyId: user.activeCompany.id, userId: user.id, trigger: 'a restatement requested from the Consistency page' });
    revalidatePath('/admin/consistency');
    revalidatePath('/reports/profit-loss');
    revalidatePath('/reports/balance-sheet');
    if (result.posted) return { ok: true, data: undefined, message: `Restated: ${result.split.difference.toFixed(2)} moved between cost of sales and stock.` };
    return { ok: true, data: undefined, message: result.reason === 'in step' ? 'Already in step — nothing to restate.' : `Not restated: ${result.reason}.` };
  } catch (error) {
    return fail(error);
  }
}
