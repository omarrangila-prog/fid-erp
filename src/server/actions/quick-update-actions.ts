'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { quickUpdateSchema } from '@/lib/validation/trading';
import { applyQuickUpdate, getContainerHistory, getOrderQuickUpdate } from '@/lib/services/quick-update';
import { fail, ok, type ActionResult } from '@/server/actions/action-utils';

/**
 * Quick Update from the loading sheet and the purchase order list.
 *
 * Every action checks its permission here, on the server: seeing the panel
 * needs shipments.view, changing a container needs shipments.update, and
 * receiving goods stays with the goods-receipt action and its own permission.
 * A button that is hidden is a convenience; this is the rule.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export type QuickContainer = {
  shipmentId: string;
  ordinal: number;
  shipmentsOnOrder: number;
  containerNumbers: string[];
  containers: number;
  status: string;
  documentStatus: string;
  documentNote: { status: string; notes: string | null; changedBy: string; changedAt: string } | null;
  etaIso: string | null;
  ataIso: string | null;
  loadingIso: string | null;
  shippingLineId: string | null;
  shippingLine: string | null;
  bookingNumber: string | null;
  billOfLading: string | null;
  portOfLoading: string | null;
  portOfDischarge: string | null;
  orderedKg: string;
  receivedKg: string;
  warehouseNames: string;
  lines: Array<{
    batchId: string;
    itemName: string;
    lotNumber: string;
    batchNumber: string;
    containerNumber: string | null;
    orderedKg: string;
    receivedKg: string;
    bagWeightKg: string;
    traceabilityPending: boolean;
  }>;
};

export type QuickOrder = {
  contract: { id: string; reference: string; number: string; supplier: string; approved: boolean };
  containers: QuickContainer[];
  shippingLines: Array<{ id: string; name: string }>;
  ports: string[];
  warehouses: Array<{ id: string; name: string; code: string }>;
  defaultWarehouseId: string | null;
  canUpdate: boolean;
  canReceive: boolean;
  /** Deleting the shipment reverses its purchase order, so it needs that permission. */
  canDelete: boolean;
  /** Taking one container off the order changes what the supplier is owed: the add/correct-container permission. */
  canRemove: boolean;
};

/** The order's containers, as the loading sheet reads them. */
export async function getQuickUpdateAction(contractId: string): Promise<ActionResult<QuickOrder>> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_VIEW);
    const order = await getOrderQuickUpdate(user.activeCompany.id, contractId);
    return ok({
      contract: order.contract,
      containers: order.containers.map((row) => ({
        shipmentId: row.shipmentId,
        ordinal: row.shipmentOrdinal,
        shipmentsOnOrder: row.shipmentsOnOrder,
        containerNumbers: row.containerNumbers,
        containers: row.containers,
        status: row.status,
        documentStatus: row.documentStatus,
        documentNote: row.documentNote
          ? { ...row.documentNote, changedAt: row.documentNote.changedAt.toISOString() }
          : null,
        etaIso: iso(row.etaDate),
        ataIso: iso(row.ataDate),
        loadingIso: iso(row.loadingDate),
        shippingLineId: row.shippingLineId,
        shippingLine: row.shippingLine,
        bookingNumber: row.bookingNumber,
        billOfLading: row.billOfLading,
        portOfLoading: row.portOfLoading,
        portOfDischarge: row.portOfDischarge,
        orderedKg: row.quantityKg.toString(),
        receivedKg: row.receivedKg.toString(),
        warehouseNames: row.warehouseNames,
        lines: row.lines.map((line) => ({
          batchId: line.batchId,
          itemName: line.itemName,
          lotNumber: line.lotNumber,
          batchNumber: line.batchNumber,
          containerNumber: line.containerNumber,
          orderedKg: line.quantityKg.toString(),
          receivedKg: line.receivedKg.toString(),
          bagWeightKg: line.bagWeightKg.toString(),
          traceabilityPending: line.traceabilityPending,
        })),
      })),
      shippingLines: order.shippingLines,
      ports: order.ports,
      warehouses: order.warehouses,
      defaultWarehouseId: order.defaultWarehouseId,
      canUpdate: can(user, PERMISSIONS.SHIPMENTS_UPDATE),
      canReceive: can(user, PERMISSIONS.PURCHASES_APPROVE),
      canDelete: can(user, PERMISSIONS.PURCHASES_REVERSE) && order.contract.approved,
      canRemove: can(user, PERMISSIONS.PURCHASES_APPROVE) && order.contract.approved,
    });
  } catch (error) {
    return fail(error);
  }
}

export type QuickUpdateOutcome = Array<{ shipmentId: string; ok: boolean; skipped?: boolean; message: string }>;

/** One change to the ticked containers — one, or all of them. */
export async function quickUpdateContainersAction(payload: string): Promise<ActionResult<QuickUpdateOutcome>> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new Error('The update could not be read. Please try again.');
    }
    const input = quickUpdateSchema.parse(parsed);
    const results = await applyQuickUpdate({
      companyId: user.activeCompany.id,
      userId: user.id,
      contractId: input.contractId,
      shipmentIds: input.shipmentIds,
      change: input.change,
    });

    // Every screen that shows these containers reads them fresh.
    revalidatePath('/loading');
    revalidatePath('/purchases');
    revalidatePath(`/purchases/${input.contractId}`);
    revalidatePath('/shipments');
    for (const id of input.shipmentIds) revalidatePath(`/shipments/${id}`);
    revalidatePath('/dashboard');
    return ok(results);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error: error.issues[0]?.message ?? 'Please check the fields.', code: 'VALIDATION' };
    }
    return fail(error);
  }
}

export type ContainerHistoryRow = { at: string; by: string; what: string; from: string | null; to: string | null; notes: string | null };

/** Who changed what on one container, and when. */
export async function getContainerHistoryAction(shipmentId: string): Promise<ActionResult<ContainerHistoryRow[]>> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_VIEW);
    const rows = await getContainerHistory(user.activeCompany.id, shipmentId);
    return ok(rows.map((row) => ({ ...row, at: row.at.toISOString() })));
  } catch (error) {
    return fail(error);
  }
}
