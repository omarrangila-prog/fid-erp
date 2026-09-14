import { randomUUID } from 'node:crypto';
import type { Tx } from '@/lib/db';
import { DOC_TYPES } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';

/**
 * Concurrency-safe document numbering.
 *
 * Numbers carry the company prefix so a document is identifiable on sight:
 *
 *   FID-DXB-PO-000001   Dubai purchase contract
 *   FID-MA-SI-000042    Morocco sales invoice
 *
 * The counter is advanced with a single `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING`. Postgres holds a row lock for the duration of that statement, so
 * two simultaneous posts can never be handed the same number — no
 * application-level locking required.
 */

const SEQUENCE_YEAR = 0; // Numbering runs continuously rather than per year.

export async function nextReference(
  tx: Tx,
  params: { companyId: string; docType: string; prefixOverride?: string },
): Promise<string> {
  const { companyId, docType } = params;

  let prefix = params.prefixOverride;
  if (!prefix) {
    const company = await tx.company.findUnique({
      where: { id: companyId },
      select: { docPrefix: true },
    });
    if (!company) throw new NotFoundError('Company');
    prefix = company.docPrefix;
  }

  const rows = await tx.$queryRaw<Array<{ lastNumber: number; prefix: string }>>`
    INSERT INTO number_sequences ("id", "companyId", "docType", "year", "prefix", "lastNumber", "updatedAt")
    VALUES (${randomUUID()}, ${companyId}, ${docType}, ${SEQUENCE_YEAR}, ${prefix}, 1, now())
    ON CONFLICT ("companyId", "docType", "year")
    DO UPDATE SET "lastNumber" = number_sequences."lastNumber" + 1, "updatedAt" = now()
    RETURNING "lastNumber", "prefix"
  `;

  const row = rows[0];
  if (!row) throw new Error(`Failed to allocate a document number for ${docType}.`);

  return `${row.prefix}-${docType}-${String(row.lastNumber).padStart(6, '0')}`;
}

const SI = DOC_TYPES.SALES_INVOICE;
const SI_WIDTH = 6;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `FID-MA-SI-000005` — a live sequential number, not a reversed `-REV` suffix. */
export function salesInvoiceSequencePattern(prefix: string) {
  return new RegExp(`^${escapeRegExp(prefix)}-${SI}-(\\d{${SI_WIDTH}})$`);
}

export function formatSalesInvoiceNumber(prefix: string, seq: number) {
  return `${prefix}-${SI}-${String(seq).padStart(SI_WIDTH, '0')}`;
}

export function parseSalesInvoiceSequence(prefix: string, invoiceNumber: string): number | null {
  const match = salesInvoiceSequencePattern(prefix).exec(invoiceNumber.trim());
  return match ? Number(match[1]) : null;
}

/**
 * The smallest positive integer that is not already taken.
 *
 * 1,2,3,4 → 5. Delete 5 and it is 5 again, not 6. That is the rule the
 * invoice book actually uses: a cancelled number is issued to the next sale.
 */
export function nextSequenceNumber(occupied: Iterable<number>): number {
  const used = new Set([...occupied].filter((n) => Number.isInteger(n) && n > 0));
  let next = 1;
  while (used.has(next)) next += 1;
  return next;
}

/**
 * Staff type "5" or "005"; the document is still FID-MA-SI-000005.
 * Anything that is not a bare number is kept as they typed it.
 */
export function normalizeSalesInvoiceNumber(prefix: string, requested: string): string {
  const trimmed = requested.trim();
  if (!trimmed) return '';
  if (/^\d+$/.test(trimmed)) {
    return formatSalesInvoiceNumber(prefix, Number(trimmed));
  }
  const siOnly = new RegExp(`^${SI}-(\\d+)$`, 'i').exec(trimmed);
  if (siOnly) return formatSalesInvoiceNumber(prefix, Number(siOnly[1]));
  const withPrefix = new RegExp(`^${escapeRegExp(prefix)}-${SI}-(\\d+)$`, 'i').exec(trimmed);
  if (withPrefix) return formatSalesInvoiceNumber(prefix, Number(withPrefix[1]));
  return trimmed;
}

async function companyPrefix(tx: Tx, companyId: string): Promise<string> {
  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { docPrefix: true },
  });
  if (!company) throw new NotFoundError('Company');
  return company.docPrefix;
}

async function liveSalesInvoiceNumbers(
  tx: Tx,
  companyId: string,
  excludeId?: string,
): Promise<string[]> {
  const rows = await tx.salesInvoice.findMany({
    where: {
      companyId,
      status: { in: ['DRAFT', 'POSTED'] },
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { invoiceNumber: true },
  });
  return rows.map((row) => row.invoiceNumber);
}

export async function suggestSalesInvoiceNumber(
  tx: Tx,
  companyId: string,
  excludeId?: string,
): Promise<string> {
  const prefix = await companyPrefix(tx, companyId);
  const occupied = (await liveSalesInvoiceNumbers(tx, companyId, excludeId))
    .map((number) => parseSalesInvoiceSequence(prefix, number))
    .filter((n): n is number => n !== null);
  return formatSalesInvoiceNumber(prefix, nextSequenceNumber(occupied));
}

/**
 * Issue the next free sales-invoice number, or the number the user typed.
 *
 * Live drafts and posted invoices occupy a number. Deleted drafts and reversed
 * invoices do not — the reversed record is renamed so the unique constraint
 * can give the original number to the next sale.
 */
export async function allocateSalesInvoiceNumber(
  tx: Tx,
  params: { companyId: string; requested?: string | null; excludeId?: string },
): Promise<string> {
  const prefix = await companyPrefix(tx, params.companyId);

  // Serialise allocation even when there are no invoices yet, so two first
  // invoices cannot both be handed 000001.
  await tx.$queryRaw`
    INSERT INTO number_sequences ("id", "companyId", "docType", "year", "prefix", "lastNumber", "updatedAt")
    VALUES (${randomUUID()}, ${params.companyId}, ${SI}, ${SEQUENCE_YEAR}, ${prefix}, 0, now())
    ON CONFLICT ("companyId", "docType", "year")
    DO UPDATE SET "updatedAt" = now()
    RETURNING "id"
  `;

  const live = await liveSalesInvoiceNumbers(tx, params.companyId, params.excludeId);
  const occupied = live
    .map((number) => parseSalesInvoiceSequence(prefix, number))
    .filter((n): n is number => n !== null);

  const requested = params.requested ? normalizeSalesInvoiceNumber(prefix, params.requested) : '';
  const invoiceNumber = requested || formatSalesInvoiceNumber(prefix, nextSequenceNumber(occupied));

  const clash = await tx.salesInvoice.findFirst({
    where: {
      companyId: params.companyId,
      invoiceNumber,
      ...(params.excludeId ? { NOT: { id: params.excludeId } } : {}),
    },
    select: { id: true, status: true, invoiceNumber: true },
  });
  if (clash) {
    if (clash.status === 'REVERSED') {
      await retireSalesInvoiceNumber(tx, {
        id: clash.id,
        companyId: params.companyId,
        invoiceNumber: clash.invoiceNumber,
      });
    } else {
      throw new BusinessRuleError(`Invoice number ${invoiceNumber} is already in use.`);
    }
  }

  return invoiceNumber;
}

/** Rename a reversed invoice so its original number can be issued again. */
export async function retireSalesInvoiceNumber(
  tx: Tx,
  invoice: { id: string; companyId: string; invoiceNumber: string },
): Promise<string> {
  let candidate = `${invoice.invoiceNumber}-REV`;
  let attempt = 2;
  while (
    await tx.salesInvoice.findFirst({
      where: { companyId: invoice.companyId, invoiceNumber: candidate, NOT: { id: invoice.id } },
      select: { id: true },
    })
  ) {
    candidate = `${invoice.invoiceNumber}-REV${attempt}`;
    attempt += 1;
  }

  await tx.salesInvoice.update({
    where: { id: invoice.id },
    data: { invoiceNumber: candidate },
  });
  return candidate;
}
