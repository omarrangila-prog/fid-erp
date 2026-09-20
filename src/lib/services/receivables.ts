import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';
import { supplierGrossPayable } from '@/lib/services/tax';

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
  /** The currency the customer's ledger is kept in. */
  partyCurrency: string;
  /** Local units per USD on the invoice, for restating it in the local currency. */
  rateLocalPerUsd: Decimal;
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


/**
 * Balances brought forward when the books started here.
 *
 * An opening balance is posted straight to the control account as a journal
 * entry — there is no invoice behind it, because the invoice belongs to
 * whatever system kept the books before. It still has to appear in the
 * ageing, or the control account and the sub-ledger disagree from day one and
 * the reconciliation reports a break that is not really a break.
 *
 * Nothing can be allocated against it, since allocations point at documents.
 * A receipt from a customer carrying one is simply left unapplied, and the
 * reconciliation already nets unapplied credits off the sub-ledger, so both
 * sides move together.
 */
async function openingBalanceRows(params: {
  companyId: string;
  party: 'CUSTOMER' | 'VENDOR';
  partyId?: string;
}) {
  const column = params.party === 'CUSTOMER' ? 'customerId' : 'vendorId';
  return prisma.$queryRawUnsafe<
    Array<{
      entryId: string;
      entryNumber: string;
      entryDate: Date;
      partyId: string;
      partyName: string;
      partyCurrency: string;
      currency: string;
      rateLocalPerUsd: string;
      amount: string;
      amountUsd: string;
    }>
  >(
    `
    SELECT je."id" AS "entryId", je."entryNumber", je."entryDate",
           jl."${column}" AS "partyId",
           ${params.party === 'CUSTOMER' ? 'c."customerName"' : 'v."vendorName"'} AS "partyName",
           ${params.party === 'CUSTOMER' ? 'c."primaryCurrency"' : 'v."primaryCurrency"'} AS "partyCurrency",
           jl."currency",
           jl."rateLocalPerUsd"::text AS "rateLocalPerUsd",
           (jl."debit" + jl."credit")::text AS "amount",
           (jl."debitUsd" + jl."creditUsd")::text AS "amountUsd"
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    ${params.party === 'CUSTOMER'
        ? 'JOIN customers c ON c."id" = jl."customerId"'
        : 'JOIN vendors v ON v."id" = jl."vendorId"'}
    WHERE je."companyId" = $1
      AND je."sourceType" = 'OPENING_BALANCE'
      AND je."status" = 'POSTED'
      AND jl."${column}" IS NOT NULL
      AND ($2::text IS NULL OR jl."${column}" = $2)
    ORDER BY je."entryDate" ASC`,
    params.companyId,
    params.partyId ?? null,
  );
}

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
      rateLocalPerUsd: string;
      partyCurrency: string;
      originalAmount: string;
      originalAmountUsd: string;
      paidAmount: string;
      paidAmountUsd: string;
    }>
  >`
    SELECT si."id" AS "invoiceId", si."invoiceNumber", si."invoiceDate", si."dueDate",
           si."customerId", c."customerName",
           si."shipmentId", s."shipmentNumber", s."etaDate",
           si."currency", si."rateLocalPerUsd"::text AS "rateLocalPerUsd", c."primaryCurrency" AS "partyCurrency",
           si."totalAmount"::text AS "originalAmount",
           si."totalAmountUsd"::text AS "originalAmountUsd",
           (
             COALESCE((SELECT SUM(ra."amount") FROM receipt_allocations ra
                         JOIN receipts r ON r."id" = ra."receiptId"
                        WHERE ra."salesInvoiceId" = si."id" AND r."status" = 'POSTED'
                          AND NOT EXISTS (
                            SELECT 1 FROM cheques ch
                            WHERE ch."receiptId" = r."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
                          )), 0)
             + COALESCE((SELECT SUM(cn."totalAmount") FROM credit_notes cn
                          WHERE cn."salesInvoiceId" = si."id" AND cn."status" = 'POSTED'), 0)
           )::text AS "paidAmount",
           (
             COALESCE((SELECT SUM(ra."amountUsd") FROM receipt_allocations ra
                         JOIN receipts r ON r."id" = ra."receiptId"
                        WHERE ra."salesInvoiceId" = si."id" AND r."status" = 'POSTED'
                          AND NOT EXISTS (
                            SELECT 1 FROM cheques ch
                            WHERE ch."receiptId" = r."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
                          )), 0)
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
      partyCurrency: row.partyCurrency,
      rateLocalPerUsd: dec(row.rateLocalPerUsd),
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

  const openings = params.shipmentId
    ? []
    : (await openingBalanceRows({
        companyId: params.companyId,
        party: 'CUSTOMER',
        partyId: params.customerId,
      })).map((row): ReceivableRow => {
        const amount = toMoney(row.amount);
        const amountUsd = toMoney(row.amountUsd);
        return {
          invoiceId: row.entryId,
          invoiceNumber: row.entryNumber,
          invoiceDate: row.entryDate,
          // Already due: it was outstanding before the books opened.
          dueDate: row.entryDate,
          customerId: row.partyId,
          customerName: row.partyName,
          shipmentId: null,
          shipmentNumber: null,
          etaDate: null,
          currency: row.currency,
          partyCurrency: row.partyCurrency,
          rateLocalPerUsd: dec(row.rateLocalPerUsd),
          originalAmount: amount,
          paidAmount: toMoney(0),
          outstandingAmount: amount,
          originalAmountUsd: amountUsd,
          paidAmountUsd: toMoney(0),
          outstandingAmountUsd: amountUsd,
          bucket: bucketFor(row.entryDate),
          status: 'UNPAID',
        };
      });

  const all = [...openings, ...shaped];

  // Non-zero, not positive. A customer who has been credited more than they
  // still owe carries a credit balance — money the business owes them — and
  // dropping it here hid a real balance from the report while the control
  // account kept it, which the reconciliation then reported as a break.
  return params.onlyOutstanding ? all.filter((r) => !r.outstandingAmount.isZero()) : all;
}

export type PayableRow = {
  /** The currency the supplier's ledger is kept in. */
  partyCurrency: string;
  /** Local units per USD on the document, for restating it in the local currency. */
  rateLocalPerUsd: Decimal;
  /**
   * What the supplier is owed for. A purchase contract is the coffee itself; an
   * expense is a cost booked against the supplier rather than paid on the spot
   * — freight, clearing, inspection. An opening balance is what they were
   * already owed when the books started here. All three credit Accounts
   * Payable, so all three have to appear or the control account stops
   * agreeing with the statement.
   */
  kind: 'CONTRACT' | 'EXPENSE' | 'OPENING';
  /** The payable document: a contract id, or an expense id when kind is EXPENSE. */
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
      vendorId: string | null;
      vendorName: string | null;
      vendorCountry: string | null;
      companyCountry: string | null;
      shipmentNumbers: string | null;
      currency: string;
      rateLocalPerUsd: string;
      partyCurrency: string | null;
      netAmount: string;
      taxAmount: string;
      netAmountUsd: string;
      taxAmountUsd: string;
      paidAmount: string;
      paidAmountUsd: string;
      kind: 'CONTRACT' | 'EXPENSE';
    }>
  >`
    SELECT pc."id" AS "contractId", pc."contractNumber", pc."contractReference", pc."contractDate", pc."dueDate",
           pc."vendorId", v."vendorName", v."country" AS "vendorCountry", c."country" AS "companyCountry",
           pc."currency", pc."rateLocalPerUsd"::text AS "rateLocalPerUsd", v."primaryCurrency" AS "partyCurrency",
           pc."totalValue"::text AS "netAmount",
           pc."taxAmount"::text AS "taxAmount",
           pc."totalValueUsd"::text AS "netAmountUsd",
           pc."taxAmountUsd"::text AS "taxAmountUsd",
           (SELECT string_agg(s."shipmentNumber", ', ' ORDER BY s."shipmentNumber")
              FROM shipments s WHERE s."purchaseContractId" = pc."id") AS "shipmentNumbers",
           (
             COALESCE((SELECT SUM(pa."amount") FROM payment_allocations pa
                         JOIN payments p ON p."id" = pa."paymentId"
                        WHERE pa."purchaseContractId" = pc."id" AND p."status" = 'POSTED'
                          AND NOT EXISTS (
                            SELECT 1 FROM cheques ch
                            WHERE ch."paymentId" = p."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
                          )), 0)
             + COALESCE((SELECT SUM(cn."totalAmount") FROM credit_notes cn
                          WHERE cn."purchaseContractId" = pc."id" AND cn."status" = 'POSTED'), 0)
           )::text AS "paidAmount",
           (
             COALESCE((SELECT SUM(pa."amountUsd") FROM payment_allocations pa
                         JOIN payments p ON p."id" = pa."paymentId"
                        WHERE pa."purchaseContractId" = pc."id" AND p."status" = 'POSTED'
                          AND NOT EXISTS (
                            SELECT 1 FROM cheques ch
                            WHERE ch."paymentId" = p."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
                          )), 0)
             + COALESCE((SELECT SUM(cn."totalAmountUsd") FROM credit_notes cn
                          WHERE cn."purchaseContractId" = pc."id" AND cn."status" = 'POSTED'), 0)
           )::text AS "paidAmountUsd",
           'CONTRACT' AS kind
    FROM purchase_contracts pc
    JOIN vendors v ON v."id" = pc."vendorId"
    JOIN companies c ON c."id" = pc."companyId"
    WHERE pc."companyId" = ${params.companyId}
      AND pc."status" = 'POSTED'
      AND (${params.vendorId ?? null}::text IS NULL OR pc."vendorId" = ${params.vendorId ?? null})

    UNION ALL

    -- Costs owed to a supplier rather than paid from an account.
    SELECT e."id" AS "contractId", e."expenseNumber" AS "contractNumber",
           COALESCE(e."reference", ec."name") AS "contractReference", e."expenseDate" AS "contractDate",
           e."expenseDate" AS "dueDate",
           e."vendorId", v."vendorName", v."country" AS "vendorCountry", c."country" AS "companyCountry",
           e."currency", e."rateLocalPerUsd"::text AS "rateLocalPerUsd", v."primaryCurrency" AS "partyCurrency",
           e."amount"::text AS "netAmount",
           e."taxAmount"::text AS "taxAmount",
           e."amountUsd"::text AS "netAmountUsd",
           e."taxAmountUsd"::text AS "taxAmountUsd",
           (SELECT s."shipmentNumber" FROM shipments s WHERE s."id" = e."shipmentId") AS "shipmentNumbers",
           COALESCE((SELECT SUM(pa."amount") FROM payment_allocations pa
                       JOIN payments p ON p."id" = pa."paymentId"
                      WHERE pa."expenseId" = e."id" AND p."status" = 'POSTED'
                        AND NOT EXISTS (
                          SELECT 1 FROM cheques ch
                          WHERE ch."paymentId" = p."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
                        )), 0)::text AS "paidAmount",
           COALESCE((SELECT SUM(pa."amountUsd") FROM payment_allocations pa
                       JOIN payments p ON p."id" = pa."paymentId"
                      WHERE pa."expenseId" = e."id" AND p."status" = 'POSTED'
                        AND NOT EXISTS (
                          SELECT 1 FROM cheques ch
                          WHERE ch."paymentId" = p."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
                        )), 0)::text AS "paidAmountUsd",
           'EXPENSE' AS kind
    FROM expenses e
    JOIN vendors v ON v."id" = e."vendorId"
    JOIN companies c ON c."id" = e."companyId"
    JOIN expense_categories ec ON ec."id" = e."expenseCategoryId"
    WHERE e."companyId" = ${params.companyId}
      AND e."status" = 'POSTED'
      AND e."cashBankAccountId" IS NULL
      AND e."payableToAgentId" IS NULL
      AND e."vendorId" IS NOT NULL
      AND (${params.vendorId ?? null}::text IS NULL OR e."vendorId" = ${params.vendorId ?? null})

    ORDER BY "dueDate" ASC NULLS LAST, "contractDate" ASC
  `;

  const shaped = rows.map((row): PayableRow => {
    const payable = supplierGrossPayable({
      netAmount: row.netAmount,
      taxAmount: row.taxAmount,
      netAmountUsd: row.netAmountUsd,
      taxAmountUsd: row.taxAmountUsd,
      vendorCountry: row.vendorCountry,
      companyCountry: row.companyCountry,
    });
    const purchaseValue = payable.amount;
    const paidAmount = toMoney(row.paidAmount);
    const outstandingAmount = toMoney(purchaseValue.minus(paidAmount));

    let status: PayableRow['status'] = 'UNPAID';
    if (outstandingAmount.lessThanOrEqualTo(0)) status = 'PAID';
    else if (paidAmount.greaterThan(0)) status = 'PARTIAL';

    return {
      kind: row.kind,
      contractId: row.contractId,
      contractNumber: row.contractNumber,
      contractReference: row.contractReference,
      contractDate: row.contractDate,
      dueDate: row.dueDate,
      vendorId: row.vendorId ?? '',
      vendorName: row.vendorName ?? 'Unpaid — pay later',
      shipmentNumbers: row.shipmentNumbers ? row.shipmentNumbers.split(', ') : [],
      currency: row.currency,
      partyCurrency: row.partyCurrency ?? row.currency,
      rateLocalPerUsd: dec(row.rateLocalPerUsd),
      purchaseValue,
      paidAmount,
      outstandingAmount,
      purchaseValueUsd: payable.amountUsd,
      outstandingAmountUsd: toMoney(payable.amountUsd.minus(dec(row.paidAmountUsd))),
      bucket: bucketFor(row.dueDate),
      status,
    };
  });

  // Non-zero, for the same reason as receivables: a supplier over-credited
  // is a debit balance the business is owed, and it belongs on the report.
  const openings = (
    await openingBalanceRows({ companyId: params.companyId, party: 'VENDOR', partyId: params.vendorId })
  ).map((row): PayableRow => {
    const amount = toMoney(row.amount);
    const amountUsd = toMoney(row.amountUsd);
    return {
      kind: 'OPENING',
      contractId: row.entryId,
      contractNumber: row.entryNumber,
      contractReference: 'Opening balance',
      contractDate: row.entryDate,
      // Already due: it was outstanding before the books opened.
      dueDate: row.entryDate,
      vendorId: row.partyId,
      vendorName: row.partyName,
      shipmentNumbers: [],
      currency: row.currency,
      partyCurrency: row.partyCurrency,
      rateLocalPerUsd: dec(row.rateLocalPerUsd),
      purchaseValue: amount,
      paidAmount: toMoney(0),
      outstandingAmount: amount,
      purchaseValueUsd: amountUsd,
      outstandingAmountUsd: amountUsd,
      bucket: bucketFor(row.entryDate),
      status: 'UNPAID',
    };
  });

  const all = [...openings, ...shaped];
  return params.onlyOutstanding ? all.filter((r) => !r.outstandingAmount.isZero()) : all;
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

/**
 * The same credits, per party and in that party's own ledger currency.
 *
 * The USD figure above is enough to reconcile a control account. It is not
 * enough to reconcile one customer's statement, which is kept in their
 * currency — so this restates each credit the way the ledger line was
 * written: at the credit note's own rates.
 */
export async function getUnappliedCreditsByParty(companyId: string) {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { localCurrency: true },
  });
  const localCode = company.localCurrency.toUpperCase();

  const rows = await prisma.$queryRaw<
    Array<{
      type: string;
      partyId: string;
      partyCurrency: string;
      currency: string;
      amount: string;
      amountUsd: string;
      rateLocalPerUsd: string;
    }>
  >`
    SELECT cn."type"::text AS type,
           COALESCE(cn."customerId", cn."vendorId") AS "partyId",
           COALESCE(c."primaryCurrency", v."primaryCurrency") AS "partyCurrency",
           cn."currency",
           cn."totalAmount"::text AS amount,
           cn."totalAmountUsd"::text AS "amountUsd",
           cn."rateLocalPerUsd"::text AS "rateLocalPerUsd"
    FROM credit_notes cn
    LEFT JOIN customers c ON c."id" = cn."customerId"
    LEFT JOIN vendors v ON v."id" = cn."vendorId"
    WHERE cn."companyId" = ${companyId}
      AND cn."status" = 'POSTED'
      AND cn."salesInvoiceId" IS NULL
      AND cn."purchaseContractId" IS NULL
      AND COALESCE(cn."customerId", cn."vendorId") IS NOT NULL`;

  const byParty = new Map<string, Decimal>();
  for (const row of rows) {
    const party = (row.partyCurrency ?? row.currency).toUpperCase();
    const amount =
      party === row.currency.toUpperCase()
        ? dec(row.amount)
        : party === 'USD'
          ? dec(row.amountUsd)
          : party === localCode
            ? toMoney(dec(row.amountUsd).times(row.rateLocalPerUsd))
            : dec(row.amount);
    const key = `${row.type}|${row.partyId}|${party}`;
    byParty.set(key, (byParty.get(key) ?? new Decimal(0)).plus(amount));
  }
  return byParty;
}

// ---------------------------------------------------------------------------
// Ageing summary: one row per party, one column per bucket
// ---------------------------------------------------------------------------

export const AGEING_BUCKETS: AgeingBucket[] = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'];

export type AgeingDetailLine = {
  documentId: string;
  documentLabel: string;
  documentDate: Date;
  dueDate: Date | null;
  daysOverdue: number;
  currency: string;
  originalAmount: Decimal;
  paidAmount: Decimal;
  outstandingAmount: Decimal;
  outstandingUsd: Decimal;
  bucket: AgeingBucket;
  href: string;
};

export type AgeingSummaryRow = {
  partyId: string;
  partyName: string;
  /** The currency the party's ledger is kept in; the columns are in it. */
  currency: string;
  byBucket: Record<AgeingBucket, Decimal>;
  total: Decimal;
  totalUsd: Decimal;
  lines: AgeingDetailLine[];
  ledgerHref: string;
};

function daysOverdue(dueDate: Date | null): number {
  if (!dueDate) return 0;
  const today = new Date();
  const due = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.floor((now - due) / 86_400_000));
}

/**
 * The ageing report the way an accountant reads it: a row per customer, a
 * column per bucket, a total; each row opens into its invoices. Every figure
 * is the same one the customer's ledger shows — this is a view of the
 * receivables, not another calculation of them.
 */
export async function getReceivablesAgeing(companyId: string): Promise<AgeingSummaryRow[]> {
  const rows = await getReceivables({ companyId, onlyOutstanding: true });
  return summarise(
    rows.map((r) => ({
      partyId: r.customerId,
      partyName: r.customerName,
      currency: r.partyCurrency,
      line: {
        documentId: r.invoiceId,
        documentLabel: shortNumber(r.invoiceNumber, 'INV'),
        documentDate: r.invoiceDate,
        dueDate: r.dueDate,
        daysOverdue: daysOverdue(r.dueDate),
        currency: r.currency,
        originalAmount: r.originalAmount,
        paidAmount: r.paidAmount,
        outstandingAmount: r.outstandingAmount,
        outstandingUsd: r.outstandingAmountUsd,
        bucket: r.bucket,
        href: r.invoiceId.startsWith('opening') ? `/ledgers/customers/${r.customerId}` : `/sales/${r.invoiceId}`,
      },
    })),
    (id) => `/ledgers/customers/${id}`,
  );
}

/** The same, for what the company owes its suppliers. */
export async function getPayablesAgeing(companyId: string): Promise<AgeingSummaryRow[]> {
  const rows = await getPayables({ companyId, onlyOutstanding: true });
  return summarise(
    rows.map((r) => ({
      partyId: r.vendorId,
      partyName: r.vendorName,
      currency: r.partyCurrency,
      line: {
        documentId: r.contractId,
        documentLabel: r.contractReference,
        documentDate: r.contractDate,
        dueDate: r.dueDate,
        daysOverdue: daysOverdue(r.dueDate),
        currency: r.currency,
        originalAmount: r.purchaseValue,
        paidAmount: r.paidAmount,
        outstandingAmount: r.outstandingAmount,
        outstandingUsd: r.outstandingAmountUsd,
        bucket: r.bucket,
        href: r.contractId.startsWith('opening') ? `/ledgers/vendors/${r.vendorId}` : `/purchases/${r.contractId}`,
      },
    })),
    (id) => `/ledgers/vendors/${id}`,
  );
}

function shortNumber(fullNumber: string, prefix: string): string {
  const trailing = fullNumber.match(/(\d+)\s*$/);
  return trailing ? `${prefix} ${Number(trailing[1])}` : fullNumber;
}

function summarise(
  items: Array<{ partyId: string; partyName: string; currency: string; line: AgeingDetailLine }>,
  ledgerHref: (partyId: string) => string,
): AgeingSummaryRow[] {
  const byParty = new Map<string, AgeingSummaryRow>();
  for (const item of items) {
    // A party dealing in two currencies is two rows: dirhams and dollars are
    // never added into one figure.
    const key = `${item.partyId}:${item.line.currency}`;
    const row =
      byParty.get(key) ??
      {
        partyId: item.partyId,
        partyName: item.partyName,
        currency: item.line.currency,
        byBucket: { CURRENT: new Decimal(0), D1_30: new Decimal(0), D31_60: new Decimal(0), D61_90: new Decimal(0), D90_PLUS: new Decimal(0) },
        total: new Decimal(0),
        totalUsd: new Decimal(0),
        lines: [],
        ledgerHref: ledgerHref(item.partyId),
      };
    row.byBucket[item.line.bucket] = row.byBucket[item.line.bucket].plus(item.line.outstandingAmount);
    row.total = row.total.plus(item.line.outstandingAmount);
    row.totalUsd = row.totalUsd.plus(item.line.outstandingUsd);
    row.lines.push(item.line);
    byParty.set(key, row);
  }
  return [...byParty.values()]
    .map((row) => ({
      ...row,
      byBucket: Object.fromEntries(AGEING_BUCKETS.map((b) => [b, toMoney(row.byBucket[b])])) as Record<AgeingBucket, Decimal>,
      total: toMoney(row.total),
      totalUsd: toMoney(row.totalUsd),
      lines: row.lines.sort((a, b) => a.documentDate.getTime() - b.documentDate.getTime()),
    }))
    .sort((a, b) => a.partyName.localeCompare(b.partyName) || a.currency.localeCompare(b.currency));
}
