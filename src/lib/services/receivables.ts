import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';

/**
 * Receivables and payables with ageing.
 *
 * Outstanding is always invoice value minus the receipts actually allocated to
 * it, both taken from posted documents. Nothing here is a stored balance.
 */

export type AgeingBucket = 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_90' | 'D90_PLUS';

export const AGEING_LABELS: Record<AgeingBucket, string> = {
  CURRENT: 'Current',
  D1_30: '1–30 Days',
  D31_60: '31–60 Days',
  D61_90: '61–90 Days',
  D90_PLUS: '90+ Days',
};

export function bucketFor(dueDate: Date | null): AgeingBucket {
  if (!dueDate) return 'CURRENT';
  const today = new Date();
  const due = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daysOverdue = Math.floor((now - due) / 86_400_000);
  if (daysOverdue <= 0) return 'CURRENT';
  if (daysOverdue <= 30) return 'D1_30';
  if (daysOverdue <= 60) return 'D31_60';
  if (daysOverdue <= 90) return 'D61_90';
  return 'D90_PLUS';
}

export type ReceivableRow = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date;
  dueDate: Date | null;
  customerId: string;
  customerName: string;
  shipmentId: string | null;
  shipmentNumber: string | null;
  etaDate: Date | null;
  currency: string;
  originalAmount: Decimal;
  paidAmount: Decimal;
  outstandingAmount: Decimal;
  originalAmountUsd: Decimal;
  paidAmountUsd: Decimal;
  outstandingAmountUsd: Decimal;
  bucket: AgeingBucket;
  status: 'UNPAID' | 'PARTIAL' | 'PAID';
};

export async function getReceivables(params: {
  companyId: string;
  customerId?: string;
  shipmentId?: string;
  onlyOutstanding?: boolean;
}): Promise<ReceivableRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      invoiceId: string;
      invoiceNumber: string;
      invoiceDate: Date;
      dueDate: Date | null;
      customerId: string;
      customerName: string;
      shipmentId: string | null;
      shipmentNumber: string | null;
      etaDate: Date | null;
      currency: string;
      originalAmount: string;
      originalAmountUsd: string;
      paidAmount: string;
      paidAmountUsd: string;
    }>
  >`
    SELECT si."id" AS "invoiceId", si."invoiceNumber", si."invoiceDate", si."dueDate",
           si."customerId", c."customerName",
           si."shipmentId", s."shipmentNumber", s."etaDate",
           si."currency",
           si."totalAmount"::text AS "originalAmount",
           si."totalAmountUsd"::text AS "originalAmountUsd",
           (
             COALESCE((SELECT SUM(ra."amount") FROM receipt_allocations ra
                         JOIN receipts r ON r."id" = ra."receiptId"
                        WHERE ra."salesInvoiceId" = si."id" AND r."status" = 'POSTED'), 0)
             + COALESCE((SELECT SUM(cn."totalAmount") FROM credit_notes cn
                          WHERE cn."salesInvoiceId" = si."id" AND cn."status" = 'POSTED'), 0)
           )::text AS "paidAmount",
           (
             COALESCE((SELECT SUM(ra."amountUsd") FROM receipt_allocations ra
                         JOIN receipts r ON r."id" = ra."receiptId"
                        WHERE ra."salesInvoiceId" = si."id" AND r."status" = 'POSTED'), 0)
             + COALESCE((SELECT SUM(cn."totalAmountUsd") FROM credit_notes cn
                          WHERE cn."salesInvoiceId" = si."id" AND cn."status" = 'POSTED'), 0)
           )::text AS "paidAmountUsd"
    FROM sales_invoices si
    JOIN customers c ON c."id" = si."customerId"
    LEFT JOIN shipments s ON s."id" = si."shipmentId"
    WHERE si."companyId" = ${params.companyId}
      AND si."status" = 'POSTED'
      AND (${params.customerId ?? null}::text IS NULL OR si."customerId" = ${params.customerId ?? null})
      AND (${params.shipmentId ?? null}::text IS NULL OR si."shipmentId" = ${params.shipmentId ?? null})
    ORDER BY si."dueDate" ASC NULLS LAST, si."invoiceDate" ASC
  `;

  const shaped = rows.map((row): ReceivableRow => {
    const originalAmount = toMoney(row.originalAmount);
    const paidAmount = toMoney(row.paidAmount);
    const outstandingAmount = toMoney(originalAmount.minus(paidAmount));
    const originalAmountUsd = toMoney(row.originalAmountUsd);
    const paidAmountUsd = toMoney(row.paidAmountUsd);

    let status: ReceivableRow['status'] = 'UNPAID';
    if (outstandingAmount.lessThanOrEqualTo(0)) status = 'PAID';
    else if (paidAmount.greaterThan(0)) status = 'PARTIAL';

    return {
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNumber,
      invoiceDate: row.invoiceDate,
      dueDate: row.dueDate,
      customerId: row.customerId,
      customerName: row.customerName,
      shipmentId: row.shipmentId,
      shipmentNumber: row.shipmentNumber,
      etaDate: row.etaDate,
      currency: row.currency,
      originalAmount,
      paidAmount,
      outstandingAmount,
      originalAmountUsd,
      paidAmountUsd,
      outstandingAmountUsd: toMoney(originalAmountUsd.minus(paidAmountUsd)),
      bucket: bucketFor(row.dueDate),
      status,
    };
  });

  return params.onlyOutstanding ? shaped.filter((r) => r.outstandingAmount.greaterThan(0)) : shaped;
}

export type PayableRow = {
  contractId: string;
  contractNumber: string;
  contractReference: string;
  contractDate: Date;
  dueDate: Date | null;
  vendorId: string;
  vendorName: string;
  shipmentNumbers: string[];
  currency: string;
  purchaseValue: Decimal;
  paidAmount: Decimal;
  outstandingAmount: Decimal;
  purchaseValueUsd: Decimal;
  outstandingAmountUsd: Decimal;
  bucket: AgeingBucket;
  status: 'UNPAID' | 'PARTIAL' | 'PAID';
};

export async function getPayables(params: {
  companyId: string;
  vendorId?: string;
  onlyOutstanding?: boolean;
}): Promise<PayableRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      contractId: string;
      contractNumber: string;
      contractReference: string;
      contractDate: Date;
      dueDate: Date | null;
      vendorId: string;
      vendorName: string;
      shipmentNumbers: string | null;
      currency: string;
      purchaseValue: string;
      purchaseValueUsd: string;
      paidAmount: string;
      paidAmountUsd: string;
    }>
  >`
    SELECT pc."id" AS "contractId", pc."contractNumber", pc."contractReference", pc."contractDate", pc."dueDate",
           pc."vendorId", v."vendorName", pc."currency",
           pc."totalValue"::text AS "purchaseValue",
           pc."totalValueUsd"::text AS "purchaseValueUsd",
           (SELECT string_agg(s."shipmentNumber", ', ' ORDER BY s."shipmentNumber")
              FROM shipments s WHERE s."purchaseContractId" = pc."id") AS "shipmentNumbers",
           (
             COALESCE((SELECT SUM(pa."amount") FROM payment_allocations pa
                         JOIN payments p ON p."id" = pa."paymentId"
                        WHERE pa."purchaseContractId" = pc."id" AND p."status" = 'POSTED'), 0)
             + COALESCE((SELECT SUM(cn."totalAmount") FROM credit_notes cn
                          WHERE cn."purchaseContractId" = pc."id" AND cn."status" = 'POSTED'), 0)
           )::text AS "paidAmount",
           (
             COALESCE((SELECT SUM(pa."amountUsd") FROM payment_allocations pa
                         JOIN payments p ON p."id" = pa."paymentId"
                        WHERE pa."purchaseContractId" = pc."id" AND p."status" = 'POSTED'), 0)
             + COALESCE((SELECT SUM(cn."totalAmountUsd") FROM credit_notes cn
                          WHERE cn."purchaseContractId" = pc."id" AND cn."status" = 'POSTED'), 0)
           )::text AS "paidAmountUsd"
    FROM purchase_contracts pc
    JOIN vendors v ON v."id" = pc."vendorId"
    WHERE pc."companyId" = ${params.companyId}
      AND pc."status" = 'POSTED'
      AND (${params.vendorId ?? null}::text IS NULL OR pc."vendorId" = ${params.vendorId ?? null})
    ORDER BY pc."dueDate" ASC NULLS LAST, pc."contractDate" ASC
  `;

  const shaped = rows.map((row): PayableRow => {
    const purchaseValue = toMoney(row.purchaseValue);
    const paidAmount = toMoney(row.paidAmount);
    const outstandingAmount = toMoney(purchaseValue.minus(paidAmount));

    let status: PayableRow['status'] = 'UNPAID';
    if (outstandingAmount.lessThanOrEqualTo(0)) status = 'PAID';
    else if (paidAmount.greaterThan(0)) status = 'PARTIAL';

    return {
      contractId: row.contractId,
      contractNumber: row.contractNumber,
      contractReference: row.contractReference,
      contractDate: row.contractDate,
      dueDate: row.dueDate,
      vendorId: row.vendorId,
      vendorName: row.vendorName,
      shipmentNumbers: row.shipmentNumbers ? row.shipmentNumbers.split(', ') : [],
      currency: row.currency,
      purchaseValue,
      paidAmount,
      outstandingAmount,
      purchaseValueUsd: toMoney(row.purchaseValueUsd),
      outstandingAmountUsd: toMoney(dec(row.purchaseValueUsd).minus(dec(row.paidAmountUsd))),
      bucket: bucketFor(row.dueDate),
      status,
    };
  });

  return params.onlyOutstanding ? shaped.filter((r) => r.outstandingAmount.greaterThan(0)) : shaped;
}

/** Totals by ageing bucket, in USD — used by the dashboard charts. */
export function summariseAgeing(
  rows: Array<{ bucket: AgeingBucket; outstandingAmountUsd: Decimal }>,
): Array<{ bucket: AgeingBucket; label: string; amountUsd: Decimal }> {
  const buckets: AgeingBucket[] = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'];
  return buckets.map((bucket) => ({
    bucket,
    label: AGEING_LABELS[bucket],
    amountUsd: toMoney(
      rows.filter((r) => r.bucket === bucket).reduce((acc, r) => acc.plus(r.outstandingAmountUsd), new Decimal(0)),
    ),
  }));
}

/**
 * Credit notes not tied to a specific document.
 *
 * A credit raised without naming an invoice or contract still reduces what the
 * party owes, but it cannot be netted against any single document. It sits here
 * until it is applied, and the reconciliation subtracts it from the sub-ledger
 * total so the control account still agrees.
 */
export async function getUnappliedCredits(companyId: string) {
  const rows = await prisma.$queryRaw<Array<{ type: string; total: string }>>`
    SELECT cn."type"::text AS type, COALESCE(SUM(cn."totalAmountUsd"), 0)::text AS total
    FROM credit_notes cn
    WHERE cn."companyId" = ${companyId}
      AND cn."status" = 'POSTED'
      AND cn."salesInvoiceId" IS NULL
      AND cn."purchaseContractId" IS NULL
    GROUP BY cn."type"`;

  const find = (type: string) => toMoney(rows.find((row) => row.type === type)?.total ?? 0);
  return { customerUsd: find('CUSTOMER'), vendorUsd: find('VENDOR') };
}
