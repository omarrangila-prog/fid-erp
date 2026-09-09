'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { fieldErrors } from '@/lib/validation/common';
import {
  creditNoteSchema,
  stockCountSchema,
  stockCountLinesSchema,
  taxCodeSchema,
  taxRegistrationSchema,
  taxReturnFilingSchema,
  bankReconciliationSchema,
} from '@/lib/validation/trading';
import { createCreditNote, postCreditNote, reverseCreditNote } from '@/lib/services/credit-note';
import { createStockCount, recordCount, postStockCount, cancelStockCount } from '@/lib/services/stock-count';
import { saveTaxCode, archiveTaxCode, enableTax, disableTax } from '@/lib/services/tax';
import { fileTaxReturn } from '@/lib/services/tax-return';
import {
  openReconciliation,
  setLineReconciled,
  completeReconciliation,
} from '@/lib/services/bank-reconciliation';
import { runBackup } from '@/lib/services/backup';
import { saveAttachment, deleteAttachment } from '@/lib/services/attachment';
import { fail, ok, type ActionResult } from '@/server/actions/action-utils';

/**
 * Credit notes, stock counts, tax, bank reconciliation, backups and
 * attachments.
 *
 * Thin, like the other action modules: validate, assert the permission,
 * delegate, revalidate. Every one re-reads the active company from the session
 * rather than trusting a company id from the client, so a crafted request
 * cannot reach into the other company's data.
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

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error('The submitted form could not be read. Please try again.');
  }
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

function creditPaths(type: 'CUSTOMER' | 'VENDOR') {
  return type === 'CUSTOMER'
    ? ['/sales/credit-notes', '/sales', '/finance/receivables']
    : ['/purchases/debit-notes', '/purchases', '/finance/payables'];
}

export async function saveCreditNoteAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.CREDIT_NOTES_CREATE);
    const input = creditNoteSchema.parse(parseJson(payload));

    const note = await createCreditNote(
      {
        companyId: user.activeCompany.id,
        type: input.type,
        creditDate: input.creditDate,
        customerId: input.customerId,
        vendorId: input.vendorId,
        salesInvoiceId: input.salesInvoiceId,
        purchaseContractId: input.purchaseContractId,
        currency: input.currency,
        rateToUsd: input.rateToUsd,
        rateLocalPerUsd: input.rateLocalPerUsd,
        reason: input.reason,
        reference: input.reference,
        notes: input.notes,
        lines: input.lines.map((line) => ({
          description: line.description,
          batchId: line.batchId,
          warehouseId: line.warehouseId,
          quantityKg: line.quantityKg,
          bags: line.bags,
          unitPrice: line.unitPrice,
          amount: line.amount,
          taxCodeId: line.taxCodeId,
        })),
      },
      user.id,
    );

    for (const path of creditPaths(input.type)) revalidatePath(path);
    return { ok: true, id: note.id, message: `${note.creditNoteNumber} saved as a draft.` };
  } catch (error) {
    return toState(error);
  }
}

export async function postCreditNoteAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.CREDIT_NOTES_POST);
    const posted = await postCreditNote({ id, companyId: user.activeCompany.id, userId: user.id });

    for (const path of creditPaths(posted.type)) revalidatePath(path);
    revalidatePath('/reports/reconciliation');
    revalidatePath('/dashboard');
    return ok(undefined, `${posted.creditNoteNumber} posted.`);
  } catch (error) {
    return fail(error);
  }
}

export async function reverseCreditNoteAction(id: string, reason: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.CREDIT_NOTES_POST);
    const reversed = await reverseCreditNote({ id, companyId: user.activeCompany.id, userId: user.id, reason });

    for (const path of creditPaths(reversed.type)) revalidatePath(path);
    revalidatePath('/inventory');
    return ok(undefined, `${reversed.creditNoteNumber} reversed.`);
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Physical stock count
// ---------------------------------------------------------------------------

export async function createStockCountAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.STOCK_COUNT_MANAGE);
    const input = stockCountSchema.parse(parseJson(payload));

    const count = await createStockCount(
      {
        companyId: user.activeCompany.id,
        warehouseId: input.warehouseId,
        countDate: input.countDate,
        notes: input.notes,
      },
      user.id,
    );

    revalidatePath('/inventory/stock-counts');
    return { ok: true, id: count.id, message: `${count.countNumber} opened with ${count.lines.length} batches.` };
  } catch (error) {
    return toState(error);
  }
}

export async function recordStockCountAction(id: string, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.STOCK_COUNT_MANAGE);
    const input = stockCountLinesSchema.parse(parseJson(payload));

    await recordCount({
      id,
      companyId: user.activeCompany.id,
      userId: user.id,
      lines: input.lines.map((line) => ({
        batchId: line.batchId,
        countedKg: line.countedKg,
        reason: line.reason ?? null,
        notes: line.notes,
      })),
    });

    revalidatePath(`/inventory/stock-counts/${id}`);
    revalidatePath('/inventory/stock-counts');
    return { ok: true, id, message: 'Counted quantities saved.' };
  } catch (error) {
    return toState(error);
  }
}

export async function postStockCountAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.STOCK_COUNT_POST);
    await postStockCount({ id, companyId: user.activeCompany.id, userId: user.id });

    revalidatePath(`/inventory/stock-counts/${id}`);
    revalidatePath('/inventory/stock-counts');
    revalidatePath('/inventory');
    revalidatePath('/reports/reconciliation');
    return ok(undefined, 'Count posted and stock adjusted.');
  } catch (error) {
    return fail(error);
  }
}

export async function cancelStockCountAction(id: string, reason: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.STOCK_COUNT_MANAGE);
    await cancelStockCount({ id, companyId: user.activeCompany.id, userId: user.id, reason });

    revalidatePath('/inventory/stock-counts');
    return ok(undefined, 'Count cancelled.');
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

export async function enableTaxAction(formData: FormData): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const input = taxRegistrationSchema.parse({
      registrationNumber: formData.get('registrationNumber') ?? '',
      label: formData.get('label') ?? '',
      periodMonths: formData.get('periodMonths') ?? '3',
    });

    await enableTax({
      companyId: user.activeCompany.id,
      userId: user.id,
      registrationNumber: input.registrationNumber,
      label: input.label,
      periodMonths: input.periodMonths,
    });

    revalidatePath('/settings/tax');
    revalidatePath('/reports/tax-return');
    return { ok: true, id: user.activeCompany.id, message: 'Tax registration saved.' };
  } catch (error) {
    return toState(error);
  }
}

export async function disableTaxAction(): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    await disableTax({ companyId: user.activeCompany.id, userId: user.id });

    revalidatePath('/settings/tax');
    return ok(undefined, 'Tax switched off for new documents.');
  } catch (error) {
    return fail(error);
  }
}

export async function saveTaxCodeAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const input = taxCodeSchema.parse(parseJson(payload));

    const saved = await saveTaxCode({ companyId: user.activeCompany.id, ...input }, user.id);

    revalidatePath('/settings/tax');
    return { ok: true, id: saved.id, message: `${saved.code} saved.` };
  } catch (error) {
    return toState(error);
  }
}

export async function archiveTaxCodeAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    await archiveTaxCode({ companyId: user.activeCompany.id, id, userId: user.id });

    revalidatePath('/settings/tax');
    return ok(undefined, 'Tax code deactivated.');
  } catch (error) {
    return fail(error);
  }
}

export async function fileTaxReturnAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const input = taxReturnFilingSchema.parse(parseJson(payload));

    const filed = await fileTaxReturn({
      companyId: user.activeCompany.id,
      userId: user.id,
      from: input.from,
      to: input.to,
      reference: input.reference,
      notes: input.notes,
    });

    revalidatePath('/reports/tax-return');
    return { ok: true, id: filed.id, message: 'Return recorded as filed.' };
  } catch (error) {
    return toState(error);
  }
}

// ---------------------------------------------------------------------------
// Bank reconciliation
// ---------------------------------------------------------------------------

export async function openReconciliationAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.BANK_RECONCILE);
    const input = bankReconciliationSchema.parse(parseJson(payload));

    const opened = await openReconciliation(
      {
        companyId: user.activeCompany.id,
        cashBankAccountId: input.cashBankAccountId,
        statementDate: input.statementDate,
        statementBalance: input.statementBalance,
      },
      user.id,
    );

    revalidatePath('/finance/reconciliation');
    return { ok: true, id: opened.id, message: 'Statement opened.' };
  } catch (error) {
    return toState(error);
  }
}

export async function tickReconciliationLineAction(
  reconciliationId: string,
  journalLineId: string,
  reconciled: boolean,
): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.BANK_RECONCILE);
    await setLineReconciled({
      companyId: user.activeCompany.id,
      reconciliationId,
      journalLineId,
      reconciled,
    });

    revalidatePath('/finance/reconciliation');
    return ok(undefined);
  } catch (error) {
    return fail(error);
  }
}

export async function completeReconciliationAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.BANK_RECONCILE);
    await completeReconciliation({ id, companyId: user.activeCompany.id, userId: user.id });

    revalidatePath('/finance/reconciliation');
    return ok(undefined, 'Reconciliation signed off.');
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

export async function runBackupAction(): Promise<ActionResult<{ location: string | null }>> {
  try {
    const user = await requirePermission(PERMISSIONS.BACKUP_MANAGE);
    const run = await runBackup({
      companyId: user.activeCompany.id,
      userId: user.id,
      trigger: 'MANUAL',
    });

    revalidatePath('/admin/backups');
    return ok({ location: run.location }, 'Backup completed.');
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export async function uploadAttachmentAction(formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requirePermission(PERMISSIONS.ATTACHMENTS_MANAGE);

    const file = formData.get('file');
    const entityType = String(formData.get('entityType') ?? '');
    const entityId = String(formData.get('entityId') ?? '');
    const category = formData.get('category');

    if (!(file instanceof File)) {
      throw new Error('Choose a file to attach.');
    }
    if (!entityType || !entityId) {
      throw new Error('That document could not be identified.');
    }

    const attachment = await saveAttachment({
      companyId: user.activeCompany.id,
      entityType,
      entityId,
      category: category ? String(category) : null,
      fileName: file.name,
      mimeType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
      uploadedById: user.id,
    });

    revalidatePath(`/${entityType.toLowerCase()}`);
    return ok({ id: attachment.id }, `${attachment.fileName} attached.`);
  } catch (error) {
    return fail(error);
  }
}

export async function deleteAttachmentAction(attachmentId: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.ATTACHMENTS_MANAGE);
    await deleteAttachment({ companyId: user.activeCompany.id, attachmentId, userId: user.id });
    return ok(undefined, 'Attachment removed.');
  } catch (error) {
    return fail(error);
  }
}
