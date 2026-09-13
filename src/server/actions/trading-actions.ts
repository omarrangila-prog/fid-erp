'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission, assertPermission } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { fieldErrors } from '@/lib/validation/common';
import {
  purchaseContractSchema,
  goodsReceiptSchema,
  salesInvoiceSchema,
  stockTransferSchema,
  shipmentStatusSchema,
  shipmentDetailsSchema,
  markLoadedSchema,
  documentStatusSchema,
} from '@/lib/validation/trading';
import {
  createPurchaseContract,
  updatePurchaseContract,
  postPurchaseContract,
  reversePurchaseContract,
  deleteDraftPurchaseContract,
} from '@/lib/services/purchase';
import {
  createGoodsReceipt,
  postGoodsReceipt,
  reverseGoodsReceipt,
  deleteDraftGoodsReceipt,
} from '@/lib/services/goods-receipt';
import {
  createSalesInvoice,
  updateSalesInvoice,
  postSalesInvoice,
  reverseSalesInvoice,
  deleteDraftSalesInvoice,
} from '@/lib/services/sales';
import {
  createStockTransfer,
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
} from '@/lib/services/shipment';
import { fail, type ActionResult } from '@/server/actions/action-utils';
import { prisma } from '@/lib/db';
import { createReceipt, postReceipt } from '@/lib/services/receipt';

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
    return { ok: true, id: result.id, message: id ? 'Invoice updated.' : 'Invoice created.' };
  } catch (error) {
    return toState(error);
  }
}

/**
 * Post an invoice, and settle it if it was a cash sale.
 *
 * A cash sale is one event to the person doing it: the customer pays and
 * leaves. Making them post the invoice and then key a separate receipt is two
 * entries for one event, and the second is the one that gets forgotten.
 *
 * The two are separate documents — an invoice and a receipt, which is what
 * they genuinely are — so they are two postings, not one. If the receipt fails
 * the invoice still stands, and the message says exactly that rather than
 * pretending nothing happened: the sale is real and only the settlement is
 * missing, which is recoverable from the invoice in one click.
 */
export async function postSalesInvoiceAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.SALES_APPROVE);
    const companyId = user.activeCompany.id;

    await postSalesInvoice({ id, companyId, userId: user.id });

    const invoice = await prisma.salesInvoice.findFirstOrThrow({
      where: { id, companyId },
      select: {
        paymentType: true,
        cashBankAccountId: true,
        customerId: true,
        invoiceDate: true,
        currency: true,
        totalAmount: true,
        rateToUsd: true,
        rateLocalPerUsd: true,
        invoiceNumber: true,
      },
    });

    if (invoice.paymentType === 'CASH' && invoice.cashBankAccountId) {
      try {
        const receipt = await createReceipt(
          {
            companyId,
            receiptDate: invoice.invoiceDate,
            customerId: invoice.customerId,
            currency: invoice.currency,
            amount: invoice.totalAmount.toString(),
            rateToUsd: invoice.rateToUsd.toString(),
            rateLocalPerUsd: invoice.rateLocalPerUsd.toString(),
            paymentMethod: 'CASH',
            cashBankAccountId: invoice.cashBankAccountId,
            reference: invoice.invoiceNumber,
            description: `Cash sale ${invoice.invoiceNumber}`,
            allocations: [{ salesInvoiceId: id, amount: invoice.totalAmount.toString() }],
          },
          user.id,
        );
        await postReceipt({ id: receipt.id, companyId, userId: user.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'the cash receipt could not be recorded';
        return {
          ok: false,
          code: 'CASH_RECEIPT_FAILED',
          error:
            `The invoice posted, but the cash receipt did not: ${message} ` +
            'Record the payment from the invoice.',
        };
      }
    }

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

export async function deleteSalesInvoiceAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.SALES_DELETE);
    await deleteDraftSalesInvoice({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidatePath('/sales');
    revalidatePath('/inventory');
    return { ok: true, data: undefined };
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

export async function changeDocumentStatusAction(shipmentId: string, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SHIPMENTS_UPDATE);
    const input = documentStatusSchema.parse(parseJson(payload));

    await changeDocumentStatus({ shipmentId, companyId: user.activeCompany.id, userId: user.id, ...input });

    revalidatePath('/shipments');
    revalidatePath(`/shipments/${shipmentId}`);
    return { ok: true, id: shipmentId, message: 'Document status updated.' };
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
    return { ok: true, id: transfer.id, message: 'Transfer created.' };
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
