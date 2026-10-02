'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getShipmentDeletePreview, deleteShipment, DELETE_REASONS, type DeletePreview } from '@/lib/services/shipment-delete';
import { fail, ok, type ActionResult } from '@/server/actions/action-utils';

/**
 * Delete Shipment, from wherever it is pressed: the loading sheet, the
 * purchase order list and page, the shipment page, Quick Update. One service
 * behind all of them. Deleting reverses the order, so it needs the
 * purchases.reverse permission; reversing unpaid costs along with it needs
 * expenses.post as well. Both are checked here, on the server.
 */

export async function getShipmentDeletePreviewAction(contractId: string): Promise<ActionResult<DeletePreview>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_REVERSE);
    return ok(await getShipmentDeletePreview(user.activeCompany.id, contractId, { canReverseCosts: can(user, PERMISSIONS.EXPENSES_POST) }));
  } catch (error) {
    return fail(error);
  }
}

const schema = z.object({
  contractId: z.string().trim().min(1),
  mode: z.enum(['keep-order', 'delete-order']),
  reason: z.enum(DELETE_REASONS),
  memo: z.string().trim().max(300).optional(),
});

export async function deleteShipmentAction(payload: string): Promise<ActionResult<{ draftId: string | null; undone: string[] }>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_REVERSE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new Error('The request could not be read. Please try again.');
    }
    const input = schema.parse(parsed);
    const result = await deleteShipment({
      companyId: user.activeCompany.id,
      userId: user.id,
      contractId: input.contractId,
      mode: input.mode,
      reason: input.reason,
      memo: input.memo || null,
      canReverseCosts: can(user, PERMISSIONS.EXPENSES_POST),
    });

    // Every screen that showed the shipment, its stock or its money.
    for (const path of [
      '/loading',
      '/shipments',
      '/purchases',
      `/purchases/${input.contractId}`,
      '/goods-receipts',
      '/inventory',
      '/inventory/batches',
      '/inventory/movements',
      '/inventory/transfers',
      '/finance/expenses',
      '/finance/unpaid-expenses',
      '/ledgers/vendors',
      '/profitability',
      '/reports',
      '/dashboard',
    ]) {
      revalidatePath(path);
    }
    if (result.draftId) revalidatePath(`/purchases/${result.draftId}`);
    return ok({ draftId: result.draftId, undone: result.undone });
  } catch (error) {
    if (error instanceof z.ZodError) return { ok: false, error: 'Choose why this shipment is being deleted.', code: 'VALIDATION' };
    return fail(error);
  }
}
