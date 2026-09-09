import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';

/**
 * LedgerService — the dual-view customer and vendor ledgers.
 *
 * Each row carries three amounts that were all frozen at posting time:
 *
 *   TRANSACTION  the currency the voucher was actually raised in
 *   USD          the group reporting view, at the voucher's own rate
 *   LOCAL        the company reporting view, at the voucher's own rate
 *
 * Switching the view therefore reads a different stored column — it never
 * re-converts. Changing today's default exchange rate cannot restate a ledger
 * that was posted last month, which is the whole point.
 */

export type LedgerView = 'TRANSACTION' | 'USD' | 'LOCAL';

export type LedgerRow = {
  journalEntryId: string;
  entryNumber: string;
  entryDate: Date;
  sourceType: string;
  reference: string | null;
  description: string;
  currency: string;
  debit: Decimal;
  credit: Decimal;
  rateToUsd: Decimal;
  debitUsd: Decimal;
  creditUsd: Decimal;
  debitLocal: Decimal;
  creditLocal: Decimal;
  shipmentNumber: string | null;
  /** Running balance expressed in the currently selected view. */
  balance: Decimal;
};

export type LedgerResult = {
  openingBalance: Decimal;
  closingBalance: Decimal;
  totalDebit: Decimal;
  totalCredit: Decimal;
  rows: LedgerRow[];
  view: LedgerView;
  viewCurrency: string;
};

type RawLedgerRow = {
  journalEntryId: string;
  entryNumber: string;
  entryDate: Date;
  sourceType: string;
  description: string;
  currency: string;
  debit: string;
  credit: string;
  rateToUsd: string;
  debitUsd: string;
  creditUsd: string;
  debitLocal: string;
  creditLocal: string;
  reference: string | null;
  shipmentNumber: string | null;
};

/**
 * Resolves the human-facing document number behind a journal entry. The join is
 * done in SQL so the ledger stays a single round trip.
 */
const REFERENCE_SQL = `
  CASE je."sourceType"
    WHEN 'SALES_INVOICE'     THEN (SELECT si."invoiceNumber"  FROM sales_invoices si     WHERE si."id"  = je."sourceId")
    WHEN 'RECEIPT'           THEN (SELECT r."receiptNumber"   FROM receipts r            WHERE r."id"   = je."sourceId")
    WHEN 'PURCHASE_CONTRACT' THEN (SELECT pc."contractNumber" FROM purchase_contracts pc WHERE pc."id"  = je."sourceId")
    WHEN 'PAYMENT'           THEN (SELECT p."paymentNumber"   FROM payments p            WHERE p."id"   = je."sourceId")
    WHEN 'EXPENSE'           THEN (SELECT e."expenseNumber"   FROM expenses e            WHERE e."id"   = je."sourceId")
    ELSE je."entryNumber"
  END
`;

function pickAmounts(row: RawLedgerRow, view: LedgerView): { debit: Decimal; credit: Decimal } {
  if (view === 'USD') return { debit: dec(row.debitUsd), credit: dec(row.creditUsd) };
  if (view === 'LOCAL') return { debit: dec(row.debitLocal), credit: dec(row.creditLocal) };
  return { debit: dec(row.debit), credit: dec(row.credit) };
}

async function buildLedger(params: {
  companyId: string;
  partyColumn: 'customerId' | 'vendorId';
  partyId: string;
  subledgerType: 'CUSTOMER' | 'VENDOR';
  /** Vendors are credit-balance accounts, so their running balance is inverted. */
  invert: boolean;
  from?: Date;
  to?: Date;
  view: LedgerView;
  viewCurrency: string;
  sourceType?: string;
  shipmentId?: string;
}): Promise<LedgerResult> {
  const { companyId, partyId, from, to, view } = params;

  const partyFilter = params.partyColumn === 'customerId' ? 'jl."customerId"' : 'jl."vendorId"';

  // Opening balance: everything strictly before the window starts.
  const openingRows = await prisma.$queryRawUnsafe<Array<{ debit: string | null; credit: string | null }>>(
    `
    SELECT SUM(jl."debit${view === 'USD' ? 'Usd' : view === 'LOCAL' ? 'Local' : ''}")::text  AS debit,
           SUM(jl."credit${view === 'USD' ? 'Usd' : view === 'LOCAL' ? 'Local' : ''}")::text AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = $1
      AND je."status" = 'POSTED'
      AND ${partyFilter} = $2
      AND a."subledgerType" = '${params.subledgerType}'
      -- No start date means no opening balance: every row belongs in the body
      -- of the ledger, so this deliberately matches nothing when $3 is null.
      AND $3::date IS NOT NULL AND je."entryDate" < $3::date
    `,
    companyId,
    partyId,
    from ?? null,
  );

  const openingRaw = toMoney(dec(openingRows[0]?.debit ?? 0).minus(dec(openingRows[0]?.credit ?? 0)));
  const openingBalance = params.invert ? openingRaw.negated() : openingRaw;

  const rows = await prisma.$queryRawUnsafe<RawLedgerRow[]>(
    `
    SELECT je."id" AS "journalEntryId", je."entryNumber", je."entryDate",
           je."sourceType"::text AS "sourceType", je."description",
           jl."currency",
           jl."debit"::text AS debit, jl."credit"::text AS credit,
           jl."rateToUsd"::text AS "rateToUsd",
           jl."debitUsd"::text AS "debitUsd", jl."creditUsd"::text AS "creditUsd",
           jl."debitLocal"::text AS "debitLocal", jl."creditLocal"::text AS "creditLocal",
           ${REFERENCE_SQL} AS reference,
           (SELECT s."shipmentNumber" FROM shipments s WHERE s."id" = jl."shipmentId") AS "shipmentNumber"
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = $1
      AND je."status" = 'POSTED'
      AND ${partyFilter} = $2
      AND a."subledgerType" = '${params.subledgerType}'
      AND ($3::date IS NULL OR je."entryDate" >= $3::date)
      AND ($4::date IS NULL OR je."entryDate" <= $4::date)
      AND ($5::text  IS NULL OR je."sourceType"::text = $5)
      AND ($6::text  IS NULL OR jl."shipmentId" = $6)
    ORDER BY je."entryDate" ASC, je."entryNumber" ASC, jl."lineNumber" ASC
    `,
    companyId,
    partyId,
    from ?? null,
    to ?? null,
    params.sourceType ?? null,
    params.shipmentId ?? null,
  );

  let running = openingBalance;
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);

  const shaped: LedgerRow[] = rows.map((row) => {
    const { debit, credit } = pickAmounts(row, view);
    const movement = params.invert ? credit.minus(debit) : debit.minus(credit);
    running = toMoney(running.plus(movement));
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);

    return {
      journalEntryId: row.journalEntryId,
      entryNumber: row.entryNumber,
      entryDate: row.entryDate,
      sourceType: row.sourceType,
      reference: row.reference,
      description: row.description,
      currency: row.currency,
      debit: dec(row.debit),
      credit: dec(row.credit),
      rateToUsd: dec(row.rateToUsd),
      debitUsd: dec(row.debitUsd),
      creditUsd: dec(row.creditUsd),
      debitLocal: dec(row.debitLocal),
      creditLocal: dec(row.creditLocal),
      shipmentNumber: row.shipmentNumber,
      balance: running,
    };
  });

  return {
    openingBalance,
    closingBalance: running,
    totalDebit: toMoney(totalDebit),
    totalCredit: toMoney(totalCredit),
    rows: shaped,
    view,
    viewCurrency: params.viewCurrency,
  };
}

export async function getCustomerLedger(params: {
  companyId: string;
  customerId: string;
  view: LedgerView;
  localCurrency: string;
  partyCurrency: string;
  from?: Date;
  to?: Date;
  sourceType?: string;
  shipmentId?: string;
}): Promise<LedgerResult> {
  return buildLedger({
    companyId: params.companyId,
    partyColumn: 'customerId',
    partyId: params.customerId,
    subledgerType: 'CUSTOMER',
    invert: false,
    from: params.from,
    to: params.to,
    view: params.view,
    sourceType: params.sourceType,
    shipmentId: params.shipmentId,
    viewCurrency:
      params.view === 'USD' ? 'USD' : params.view === 'LOCAL' ? params.localCurrency : params.partyCurrency,
  });
}

export async function getVendorLedger(params: {
  companyId: string;
  vendorId: string;
  view: LedgerView;
  localCurrency: string;
  partyCurrency: string;
  from?: Date;
  to?: Date;
  sourceType?: string;
  shipmentId?: string;
}): Promise<LedgerResult> {
  return buildLedger({
    companyId: params.companyId,
    partyColumn: 'vendorId',
    partyId: params.vendorId,
    subledgerType: 'VENDOR',
    invert: true,
    from: params.from,
    to: params.to,
    view: params.view,
    sourceType: params.sourceType,
    shipmentId: params.shipmentId,
    viewCurrency:
      params.view === 'USD' ? 'USD' : params.view === 'LOCAL' ? params.localCurrency : params.partyCurrency,
  });
}
