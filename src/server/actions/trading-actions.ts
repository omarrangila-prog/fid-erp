'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission, assertPermission, canAny } from '@/lib/auth/guards';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { PERMISSIONS } from '@/lib/constants';
import { fieldErrors } from '@/lib/validation/common';
import {
  purchaseContractSchema,
  goodsReceiptSchema,
  receiveContainersSchema,
  splitContractLineSchema,
  editContainerSchema,
  addContainerSchema,
  salesInvoiceSchema,
  stockTransferSchema,
  shipmentStatusSchema,
  shipmentDetailsSchema,
  markLoadedSchema,
  documentStatusSchema,
  shipmentContainersSchema,
} from '@/lib/validation/trading';
import {
  createPurchaseContract,
  updatePurchaseContract,
  postPurchaseContract,
  reversePurchaseContract,
  deleteDraftPurchaseContract,
  splitContractLine,
  correctPurchaseContract,
  editContainer,
  addContainerToOrder,
} from '@/lib/services/purchase';
import {
  createGoodsReceipt,
  postGoodsReceipt,
  reverseGoodsReceipt,
  deleteDraftGoodsReceipt,
  receiveContainers,
} from '@/lib/services/goods-receipt';
import {
  createSalesInvoice,
  updateSalesInvoice,
  postSalesInvoice,
  reverseSalesInvoice,
  cancelSalesInvoice,
} from '@/lib/services/sales';
import {
  createStockTransfer,
  updateDraftStockTransfer,
  reverseReceivedStockTransfer,
  correctReceivedStockTransfer,
  approveStockTransfer,
  dispatchStockTransfer,
  receiveStockTransfer,
  cancelStockTransfer,
  deleteDraftStockTransfer,
} from '@/lib/services/stock-transfer';
import {
  changeShipmentStatus,
  changeDocumentStatus,
  updateShipmentDetails,
  markShipmentLoaded,
  updateShipmentEta,
  saveShipmentContainers,
  getEtaHistory,
  markOrderArrived,
  markShipmentArrived,
  undoLoading,
} from '@/lib/services/shipment';
import { fail, ok, type ActionResult } from '@/server/actions/action-utils';

/**
 * Trading actions.
 *
 * These are thin: validate, assert the permission, delegate to the domain
 * service, revalidate. All the business logic — atomic posting, stock checks,
 * accounting — lives in the services, where it is unit-tested.
 */

export type DocFormState =
  | { ok: true; id: string; message: string }
  | { ok: false; error: string; errors?: Record<string, string> }
  | null;

function toState(error: unknown): DocFormState {
  if (error instanceof z.ZodError) {
    return { ok: false, error: 'Please correct the highlighted fields.', errors: fieldErrors(error) };
  }
  const response = fail(error);
  return { ok: false, error: response.ok ? 'The action could not be completed.' : response.error };
}

/** Server actions receive JSON for multi-line documents, which FormData cannot express cleanly. */
function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error('The submitted form could not be read. Please try again.');
  }
}

// ---------------------------------------------------------------------------
// Purchase contracts
// ---------------------------------------------------------------------------

export async function savePurchaseContractAction(id: string | null, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(id ? PERMISSIONS.PURCHASES_EDIT : PERMISSIONS.PURCHASES_CREATE);
    const input = purchaseContractSchema.parse(parseJson(payload));

    const result = id
      ? await updatePurchaseContract(id, { companyId: user.activeCompany.id, ...input }, user.id)
      : await createPurchaseContract({ companyId: user.activeCompany.id, ...input }, user.id);

    revalidatePath('/purchases');
    revalidatePath(`/purchases/${result.id}`);
    return { ok: true, id: result.id, message: id ? 'Contract updated.' : 'Contract created.' };
  } catch (error) {
    return toState(error);
  }
}

export async function postPurchaseContractAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_APPROVE);
    await postPurchaseContract({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidatePath('/purchases');
    revalidatePath(`/purchases/${id}`);
    revalidatePath('/shipments');
    revalidatePath('/dashboard');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function reversePurchaseContractAction(id: string, reason: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_REVERSE);
    await reversePurchaseContract({ id, companyId: user.activeCompany.id, userId: user.id, reason });
    revalidatePath('/purchases');
    revalidatePath(`/purchases/${id}`);
    revalidatePath('/dashboard');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function deletePurchaseContractAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_DELETE);
    await deleteDraftPurchaseContract({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidatePath('/purchases');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Goods receipts
// ---------------------------------------------------------------------------

export async function saveGoodsReceiptAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.INVENTORY_VIEW);
    assertPermission(user, PERMISSIONS.PURCHASES_APPROVE);
    const input = goodsReceiptSchema.parse(parseJson(payload));

    const receipt = await createGoodsReceipt(
      { companyId: user.activeCompany.id, receivedById: user.id, ...input },
      user.id,
    );

    revalidatePath('/goods-receipts');
    revalidatePath(`/purchases/${input.purchaseContractId}`);
    revalidatePath('/loading');
    return { ok: true, id: receipt.id, message: 'Goods receipt created.' };
  } catch (error) {
    return toState(error);
  }
}

export async function postGoodsReceiptAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_APPROVE);
    await postGoodsReceipt({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidatePath('/goods-receipts');
    revalidatePath('/inventory');
    revalidatePath('/dashboard');
    revalidatePath('/loading');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function reverseGoodsReceiptAction(id: string, reason: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_REVERSE);
    await reverseGoodsReceipt({ id, companyId: user.activeCompany.id, userId: user.id, reason });
    revalidatePath('/goods-receipts');
    revalidatePath('/inventory');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteGoodsReceiptAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_DELETE);
    await deleteDraftGoodsReceipt({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidatePath('/goods-receipts');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Sales invoices
// ---------------------------------------------------------------------------

export async function saveSalesInvoiceAction(id: string | null, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(id ? PERMISSIONS.SALES_EDIT : PERMISSIONS.SALES_CREATE);
    const input = salesInvoiceSchema.parse(parseJson(payload));

    const result = id
      ? await updateSalesInvoice(id, { companyId: user.activeCompany.id, ...input }, user.id)
      : await createSalesInvoice({ companyId: user.activeCompany.id, ...input }, user.id);

    revalidatePath('/sales');
    revalidatePath(`/sales/${result.id}`);
    revalidatePath('/inventory');
    revalidatePath('/loading');
    revalidatePath('/finance/receivables');
    revalidatePath('/dashboard');
    return { ok: true, id: result.id, message: id ? 'Invoice updated.' : 'Invoice created.' };
  } catch (error) {
    return toState(error);
  }
}

/**
 * Post an invoice. A cash sale's receipt is raised in the same database
 * transaction as the invoice, so a failure leaves neither a posted sale
 * without settlement nor a receipt without an invoice.
 */
export async function postSalesInvoiceAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.SALES_APPROVE);
    const companyId = user.activeCompany.id;

    // A cash sale's receipt is raised inside postSalesInvoice, in the same
    // transaction, so there is nothing to do here beyond posting.
    await postSalesInvoice({ id, companyId, userId: user.id });

    revalidatePath('/sales');
    revalidatePath(`/sales/${id}`);
    revalidatePath('/inventory');
    revalidatePath('/finance/receivables');
    revalidatePath('/finance/cash-bank');
    revalidatePath('/dashboard');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function reverseSalesInvoiceAction(id: string, reason: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.SALES_REVERSE);
    await reverseSalesInvoice({ id, companyId: user.activeCompany.id, userId: user.id, reason });
    revalidatePath('/sales');
    revalidatePath(`/sales/${id}`);
    revalidatePath('/inventory');
    revalidatePath('/dashboard');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteSalesInvoiceAction(
  id: string,
  reason?: string,
): Promise<ActionResult<{ status: 'DELETED' | 'REVERSED' }>> {
  try {
    const user = await requireUser();
    const companyId = user.activeCompany.id;
    const invoice = await prisma.salesInvoice.findFirst({
      where: { id, companyId },
      select: { status: true },
    });
    if (!invoice) {
      if (!canAny(user, [PERMISSIONS.SALES_DELETE, PERMISSIONS.SALES_EDIT])) {
        assertPermission(user, PERMISSIONS.SALES_DELETE);
      }
    } else if (invoice.status === 'DRAFT') {
      if (!canAny(user, [PERMISSIONS.SALES_DELETE, PERMISSIONS.SALES_EDIT])) {
        assertPermission(user, PERMISSIONS.SALES_DELETE);
      }
    } else if (invoice.status === 'POSTED' || invoice.status === 'REVERSED') {
      if (!canAny(user, [PERMISSIONS.SALES_DELETE, PERMISSIONS.SALES_REVERSE, PERMISSIONS.SALES_APPROVE])) {
        assertPermission(user, PERMISSIONS.SALES_REVERSE);
      }
    } else {
      assertPermission(user, PERMISSIONS.SALES_DELETE);
    }

    const result = await cancelSalesInvoice({
      id,
      companyId,
      userId: user.id,
      reason,
    });
    revalidatePath('/sales');
    revalidatePath(`/sales/${id}`);
    revalidatePath('/inventory');
    revalidatePath('/finance/receivables');
    revalidatePath('/ledgers/customers');
    revalidatePath('/dashboard');
    return { ok: true, data: result };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

export async function changeShipmentStatusAction(shipmentId: string, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    const input = shipmentStatusSchema.parse(parseJson(payload));

    await changeShipmentStatus({ shipmentId, companyId: user.activeCompany.id, userId: user.id, ...input });

    revalidatePath('/shipments');
    revalidatePath(`/shipments/${shipmentId}`);
    revalidatePath('/loading');
    revalidatePath('/dashboard');
    return { ok: true, id: shipmentId, message: 'Shipment status updated.' };
  } catch (error) {
    return toState(error);
  }
}

export async function updateShipmentDetailsAction(shipmentId: string, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    const input = shipmentDetailsSchema.parse(parseJson(payload));

    await updateShipmentDetails({ shipmentId, companyId: user.activeCompany.id, userId: user.id, ...input });

    revalidatePath('/shipments');
    revalidatePath(`/shipments/${shipmentId}`);
    revalidatePath('/loading');
    return { ok: true, id: shipmentId, message: 'Shipment updated.' };
  } catch (error) {
    return toState(error);
  }
}

/**
 * Mark a consignment loaded, with the shipping information that makes it so.
 *
 * One action rather than a status change followed by four separate edits: the
 * information all arrives together when the supplier ships, and asking for it
 * in one place is the difference between the loading sheet being current and
 * being a week behind.
 */
export async function markShipmentLoadedAction(shipmentId: string, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    const input = markLoadedSchema.parse(parseJson(payload));

    await markShipmentLoaded(
      {
        companyId: user.activeCompany.id,
        shipmentId,
        loadingDate: input.loadingDate,
        etaDate: input.etaDate,
        shippingLineId: input.shippingLineId,
        bookingNumber: input.bookingNumber,
        billOfLading: input.billOfLading,
        containerNumbers: input.containerNumbers?.filter((n): n is string => Boolean(n)),
        vesselName: input.vesselName,
        voyageNumber: input.voyageNumber,
        portOfLoading: input.portOfLoading,
        portOfDischarge: input.portOfDischarge,
        notes: input.notes,
      },
      user.id,
    );

    revalidatePath('/shipments');
    revalidatePath(`/shipments/${shipmentId}`);
    revalidatePath('/loading');
    return { ok: true, id: shipmentId, message: 'Marked as loaded.' };
  } catch (error) {
    return toState(error);
  }
}

/**
 * Change an ETA, from wherever the user happens to be looking.
 *
 * Chiefly the loading sheet: a shipping line moves dates every few days and
 * staff update a dozen consignments at a time, which is not a thing to do one
 * page load at a time.
 */
export async function updateShipmentEtaAction(shipmentId: string, etaDate: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    const parsed = etaDate ? new Date(`${etaDate}T00:00:00.000Z`) : null;
    if (etaDate && Number.isNaN(parsed?.getTime())) {
      return { ok: false, error: 'That is not a date the system can read.' };
    }

    await updateShipmentEta(
      { companyId: user.activeCompany.id, shipmentId, etaDate: parsed },
      user.id,
    );

    revalidatePath('/loading');
    revalidatePath('/shipments');
    revalidatePath(`/shipments/${shipmentId}`);
    return { ok: true, id: shipmentId, message: 'ETA updated.' };
  } catch (error) {
    return toState(error);
  }
}

/** The ETA dialog shows every previous date, who changed it, and when. */
export async function getShipmentEtaHistoryAction(shipmentId: string): Promise<
  | { ok: true; rows: Array<{ changedAt: string; changedBy: string; from: string | null; to: string | null }> }
  | { ok: false; error: string }
> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_VIEW);
    const rows = await getEtaHistory(user.activeCompany.id, shipmentId);
    return {
      ok: true,
      rows: rows.map((row) => ({
        changedAt: row.changedAt.toISOString(),
        changedBy: row.changedBy,
        from: row.from,
        to: row.to,
      })),
    };
  } catch (error) {
    const failed = fail(error);
    return { ok: false, error: failed.ok ? 'The ETA history could not be read.' : failed.error };
  }
}

/**
 * Mark every shipment on an order arrived at once.
 *
 * For the day the whole order lands together. Shipments that already arrived
 * are left alone, so pressing it twice is harmless.
 */
export async function markOrderArrivedAction(
  contractId: string,
  ataDate: string,
): Promise<ActionResult<{ marked: number; total: number }>> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    const parsed = new Date(`${ataDate}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      return fail('That is not a date the system can read.');
    }

    const result = await markOrderArrived({
      companyId: user.activeCompany.id,
      contractId,
      userId: user.id,
      ataDate: parsed,
    });

    revalidatePath('/loading');
    revalidatePath('/shipments');
    revalidatePath('/purchases');
    revalidatePath(`/purchases/${contractId}`);
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

/** Reverse an approved order and open an editable draft copy of it. */
export async function correctPurchaseContractAction(id: string, reason: string): Promise<ActionResult<{ draftId: string }>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_REVERSE);
    assertPermission(user, PERMISSIONS.PURCHASES_CREATE);
    const draft = await correctPurchaseContract({
      id,
      companyId: user.activeCompany.id,
      userId: user.id,
      reason: reason.trim() || 'Corrected and re-entered',
    });
    revalidatePath('/purchases');
    revalidatePath(`/purchases/${id}`);
    revalidatePath('/loading');
    revalidatePath('/dashboard');
    return ok({ draftId: draft.id });
  } catch (error) {
    return fail(error);
  }
}

/** Back from Loaded to Pending loading, so the loading details can be fixed. */
export async function undoLoadingAction(shipmentId: string, reason: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    const result = await undoLoading({ companyId: user.activeCompany.id, shipmentId, userId: user.id, reason });
    revalidatePath('/loading');
    revalidatePath('/shipments');
    revalidatePath(`/shipments/${shipmentId}`);
    revalidatePath('/purchases');
    revalidatePath(`/purchases/${result.contractId}`);
    return { ok: true, id: shipmentId, message: 'Back to pending loading. Correct the details and mark it loaded again.' };
  } catch (error) {
    return toState(error);
  }
}

/** One more container on an approved order, with the supplier owed its value. */
export async function addContainerAction(payload: string): Promise<ActionResult<{ lineNumber: number }>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_APPROVE);
    const input = addContainerSchema.parse(parseJson(payload));
    const result = await addContainerToOrder({
      companyId: user.activeCompany.id,
      contractId: input.purchaseContractId,
      userId: user.id,
      itemId: input.itemId,
      quantityKg: input.quantityKg,
      unitPriceKg: input.unitPriceKg,
      bags: input.bags,
      containerNumber: input.containerNumber,
      lotNumber: input.lotNumber,
      batchNumber: input.batchNumber,
      reason: input.reason,
    });
    revalidatePath('/loading');
    revalidatePath('/shipments');
    revalidatePath('/purchases');
    revalidatePath(`/purchases/${input.purchaseContractId}`);
    return ok({ lineNumber: result.lineNumber });
  } catch (error) {
    return fail(error);
  }
}

/** Correct one unreceived container: kilograms, bags, container, lot, batch. */
export async function editContainerAction(payload: string): Promise<ActionResult<{ contractId: string }>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_APPROVE);
    const input = editContainerSchema.parse(parseJson(payload));
    const result = await editContainer({ companyId: user.activeCompany.id, userId: user.id, ...input });
    revalidatePath('/loading');
    revalidatePath('/shipments');
    revalidatePath(`/shipments/${input.shipmentId}`);
    revalidatePath('/purchases');
    revalidatePath(`/purchases/${result.contractId}`);
    return ok({ contractId: result.contractId });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Divide one ordered line into containers after approval. The books do not
 * move; the containers get their own rows so each can arrive and be received
 * on its own.
 */
export async function splitContractLineAction(payload: string): Promise<ActionResult<{ containers: number }>> {
  try {
    const user = await requirePermission(PERMISSIONS.PURCHASES_APPROVE);
    const input = splitContractLineSchema.parse(parseJson(payload));
    const created = await splitContractLine({
      companyId: user.activeCompany.id,
      contractId: input.purchaseContractId,
      lineId: input.lineId,
      userId: user.id,
      parts: input.parts,
    });
    revalidatePath('/loading');
    revalidatePath('/shipments');
    revalidatePath('/purchases');
    revalidatePath(`/purchases/${input.purchaseContractId}`);
    return ok({ containers: created.length });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Receive the ticked containers, each into its own warehouse, in one go.
 * Created and posted together: a receipt that is not posted has brought no
 * coffee into stock, and the person at the gate pressed one button.
 */
export async function receiveContainersAction(
  payload: string,
): Promise<ActionResult<{ receipts: Array<{ id: string; grnNumber: string }> }>> {
  try {
    // The same permission the existing receive-and-post path requires.
    const user = await requirePermission(PERMISSIONS.PURCHASES_APPROVE);
    const input = receiveContainersSchema.parse(parseJson(payload));

    const receipts = await receiveContainers({
      companyId: user.activeCompany.id,
      purchaseContractId: input.purchaseContractId,
      // dateString has already turned it into a UTC midnight Date.
      receiptDate: input.receiptDate,
      receivedById: user.id,
      reference: input.reference,
      notes: input.notes,
      lines: input.lines,
    });

    revalidatePath('/goods-receipts');
    revalidatePath('/inventory');
    revalidatePath('/inventory/batches');
    revalidatePath('/loading');
    revalidatePath('/purchases');
    revalidatePath(`/purchases/${input.purchaseContractId}`);
    return ok({ receipts: receipts.map((r) => ({ id: r.id, grnNumber: r.grnNumber })) });
  } catch (error) {
    return fail(error);
  }
}

/**
 * One container arrived, from its row on the order. Steps through Loaded if
 * nobody marked it, like "mark all arrived" does; touches nothing else.
 */
export async function markContainerArrivedAction(shipmentId: string, ataDate: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    const parsed = new Date(`${ataDate}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: 'That is not a date the system can read.' };
    }
    const contract = await prisma.shipment.findFirst({
      where: { id: shipmentId, companyId: user.activeCompany.id },
      select: { purchaseContractId: true },
    });
    await markShipmentArrived({ companyId: user.activeCompany.id, shipmentId, userId: user.id, ataDate: parsed });

    revalidatePath('/loading');
    revalidatePath('/shipments');
    revalidatePath(`/shipments/${shipmentId}`);
    revalidatePath('/purchases');
    if (contract) revalidatePath(`/purchases/${contract.purchaseContractId}`);
    return { ok: true, id: shipmentId, message: 'Marked arrived.' };
  } catch (error) {
    return toState(error);
  }
}

/** Mark a consignment arrived. One date, because that is the whole event. */
export async function markShipmentArrivedAction(shipmentId: string, ataDate: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    const parsed = new Date(`${ataDate}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: 'That is not a date the system can read.' };
    }

    await changeShipmentStatus({
      shipmentId,
      companyId: user.activeCompany.id,
      userId: user.id,
      toStatus: 'ARRIVED',
      ataDate: parsed,
    });

    revalidatePath('/loading');
    revalidatePath('/shipments');
    revalidatePath(`/shipments/${shipmentId}`);
    return { ok: true, id: shipmentId, message: 'Marked arrived.' };
  } catch (error) {
    return toState(error);
  }
}

export async function changeDocumentStatusAction(shipmentId: string, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    const input = documentStatusSchema.parse(parseJson(payload));

    await changeDocumentStatus({ shipmentId, companyId: user.activeCompany.id, userId: user.id, ...input });

    revalidatePath('/shipments');
    revalidatePath(`/shipments/${shipmentId}`);
    revalidatePath('/loading');
    return { ok: true, id: shipmentId, message: 'Document status updated.' };
  } catch (error) {
    return toState(error);
  }
}

export async function saveShipmentContainersAction(shipmentId: string, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    const input = shipmentContainersSchema.parse(parseJson(payload));

    await saveShipmentContainers(
      {
        companyId: user.activeCompany.id,
        shipmentId,
        lines: input.lines.map((line) => ({
          batchId: line.batchId,
          containerNumber: line.containerNumber,
        })),
      },
      user.id,
    );

    revalidatePath('/loading');
    revalidatePath('/shipments');
    revalidatePath(`/shipments/${shipmentId}`);
    revalidatePath('/purchases');
    revalidatePath('/goods-receipts');
    return { ok: true, id: shipmentId, message: 'Container numbers saved.' };
  } catch (error) {
    return toState(error);
  }
}

// ---------------------------------------------------------------------------
// Stock transfers
// ---------------------------------------------------------------------------

export async function saveStockTransferAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.INVENTORY_TRANSFER);
    const input = stockTransferSchema.parse(parseJson(payload));

    const transfer = await createStockTransfer({ companyId: user.activeCompany.id, ...input }, user.id);

    revalidatePath('/inventory/transfers');
    return { ok: true, id: transfer.id, message: `Transfer ${transfer.transferNumber} created.` };
  } catch (error) {
    return toState(error);
  }
}

export async function advanceStockTransferAction(
  id: string,
  to: 'APPROVED' | 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED',
  reason?: string,
): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.INVENTORY_TRANSFER);
    const params = { id, companyId: user.activeCompany.id, userId: user.id };

    if (to === 'APPROVED') await approveStockTransfer(params);
    else if (to === 'IN_TRANSIT') await dispatchStockTransfer(params);
    else if (to === 'RECEIVED') await receiveStockTransfer(params);
    else await cancelStockTransfer({ ...params, reason: reason ?? 'Cancelled' });

    revalidatePath('/inventory/transfers');
    revalidatePath('/inventory');
    revalidatePath('/dashboard');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/** Edit a draft transfer in place. */
export async function updateStockTransferAction(id: string, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.INVENTORY_TRANSFER);
    const input = stockTransferSchema.parse(parseJson(payload));
    await updateDraftStockTransfer(id, { companyId: user.activeCompany.id, ...input }, user.id);
    revalidatePath('/inventory/transfers');
    revalidatePath(`/inventory/transfers/${id}`);
    return { ok: true, id, message: 'Transfer updated.' };
  } catch (error) {
    return toState(error);
  }
}

/** Move a received transfer's stock back, keeping its history. */
export async function reverseStockTransferAction(id: string, reason: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.INVENTORY_TRANSFER);
    await reverseReceivedStockTransfer({ id, companyId: user.activeCompany.id, userId: user.id, reason });
    revalidatePath('/inventory/transfers');
    revalidatePath('/inventory');
    revalidatePath(`/inventory/transfers/${id}`);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/** Move a received transfer back and open a new draft copy to correct and receive again. */
export async function correctStockTransferAction(id: string, reason: string): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requirePermission(PERMISSIONS.INVENTORY_TRANSFER);
    const draft = await correctReceivedStockTransfer({ id, companyId: user.activeCompany.id, userId: user.id, reason });
    revalidatePath('/inventory/transfers');
    revalidatePath('/inventory');
    return { ok: true, data: { id: draft.id } };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteStockTransferAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.INVENTORY_TRANSFER);
    await deleteDraftStockTransfer({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidatePath('/inventory/transfers');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}
