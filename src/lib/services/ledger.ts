import { prisma } from '@/lib/db';
import { LIVE_ENTRY_TEXT } from '@/lib/services/journal-visibility';
import { Decimal, dec, toMoney } from '@/lib/money';
import {
  COLLECTED_BY_SQL,
  INVOICE_DOCUMENTS_SQL,
  MEMO_SQL,
  ORDER_DOCUMENTS_SQL,
  ledgerTypeLabel,
  parseDocuments,
  type LedgerDocument,
} from '@/lib/services/ledger-sql';

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

export const BOOK_CURRENCIES = ['USD', 'AED', 'MAD'] as const;
export type BookCurrency = (typeof BOOK_CURRENCIES)[number];

export function isBookCurrency(value: string | null | undefined): value is BookCurrency {
  return value === 'USD' || value === 'AED' || value === 'MAD';
}

/** Tabs on a person/account ledger: always USD and MAD, plus AED when that book is in play. */
export function ledgerCurrencyTabs(localCurrency: string, partyCurrency?: string): BookCurrency[] {
  const tabs: BookCurrency[] = ['USD', 'MAD'];
  if (localCurrency === 'AED' || partyCurrency === 'AED') tabs.splice(1, 0, 'AED');
  return tabs;
}

/**
 * USD and MAD mean "show only that currency's original amounts" — not a
 * converted mix. Legacy `view=LOCAL` maps to the company's local currency.
 */
export function resolvePartyLedgerQuery(params: {
  view?: string;
  currency?: string;
  localCurrency: string;
  partyCurrency: string;
}): { view: LedgerView; currency?: BookCurrency } {
  if (isBookCurrency(params.currency)) {
    return { view: 'TRANSACTION', currency: params.currency };
  }
  if (isBookCurrency(params.view)) {
    return { view: 'TRANSACTION', currency: params.view };
  }
  if (params.view === 'LOCAL' && isBookCurrency(params.localCurrency)) {
    return { view: 'TRANSACTION', currency: params.localCurrency };
  }
  if (params.view === 'TRANSACTION') {
    return { view: 'TRANSACTION' };
  }
  const fallback = isBookCurrency(params.partyCurrency)
    ? params.partyCurrency
    : isBookCurrency(params.localCurrency)
      ? params.localCurrency
      : 'USD';
  return { view: 'TRANSACTION', currency: fallback };
}

export type LedgerRow = {
  journalEntryId: string;
  entryNumber: string;
  entryDate: Date;
  sourceType: string;
  sourceId: string;
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
  /** What was typed on the document behind the entry. */
  memo: string | null;
  /** The invoices (customer) or orders/expenses (supplier) this row belongs to. */
  documents: LedgerDocument[];
  /** "Invoice", "Partial Payment", "Payment", "Credit Note"… */
  typeLabel: string;
  /** The agent who collected a customer's payment, when one did. */
  collectedBy: string | null;
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
  /** When set, only vouchers in this currency are included — totals are not mixed. */
  currencyFilter?: BookCurrency;
};

type RawLedgerRow = {
  journalEntryId: string;
  entryNumber: string;
  entryDate: Date;
  sourceType: string;
  sourceId: string;
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
  memo: string | null;
  documents: unknown;
  collectedBy: string | null;
};

/**
 * Resolves the human-facing document number behind a journal entry. The join is
 * done in SQL so the ledger stays a single round trip.
 */
export const REFERENCE_SQL = `
  CASE je."sourceType"
    WHEN 'SALES_INVOICE'     THEN COALESCE(
      (SELECT si."invoiceNumber" FROM sales_invoices si WHERE si."id" = je."sourceId"),
      CASE
        WHEN je."description" LIKE '[%]%' THEN split_part(substr(je."description", 2), ']', 1)
        ELSE NULL
      END,
      je."entryNumber"
    )
    WHEN 'RECEIPT'           THEN (SELECT r."receiptNumber"   FROM receipts r            WHERE r."id"   = je."sourceId")
    WHEN 'PURCHASE_CONTRACT' THEN (SELECT pc."contractNumber" FROM purchase_contracts pc WHERE pc."id"  = je."sourceId")
    WHEN 'PAYMENT'           THEN (SELECT p."paymentNumber"   FROM payments p            WHERE p."id"   = je."sourceId")
    WHEN 'EXPENSE'           THEN (SELECT e."expenseNumber"   FROM expenses e            WHERE e."id"   = je."sourceId")
    WHEN 'AGENT_SETTLEMENT'  THEN (SELECT s."settlementNumber" FROM agent_settlements s  WHERE s."id"   = je."sourceId")
    WHEN 'CREDIT_NOTE'       THEN (SELECT cn."creditNoteNumber" FROM credit_notes cn     WHERE cn."id"  = je."sourceId")
    -- A voucher raised by hand shows the client's own reference when it has one.
    ELSE COALESCE(NULLIF(je."reference", ''), je."entryNumber")
  END
`;

function pickAmounts(
  row: RawLedgerRow,
  view: LedgerView,
  currencyFilter?: BookCurrency,
): { debit: Decimal; credit: Decimal } {
  if (currencyFilter) return { debit: dec(row.debit), credit: dec(row.credit) };
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
  currencyFilter?: BookCurrency;
  sourceType?: string;
  shipmentId?: string;
}): Promise<LedgerResult> {
  const { companyId, partyId, from, to, view, currencyFilter } = params;

  const partyFilter = params.partyColumn === 'customerId' ? 'jl."customerId"' : 'jl."vendorId"';
  const amountSuffix = currencyFilter ? '' : view === 'USD' ? 'Usd' : view === 'LOCAL' ? 'Local' : '';

  // Opening balance: everything strictly before the window starts.
  const openingRows = await prisma.$queryRawUnsafe<Array<{ debit: string | null; credit: string | null }>>(
    `
    SELECT SUM(jl."debit${amountSuffix}")::text  AS debit,
           SUM(jl."credit${amountSuffix}")::text AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = $1
      AND ${LIVE_ENTRY_TEXT}
      AND ${partyFilter} = $2
      AND a."subledgerType" = '${params.subledgerType}'
      -- No start date means no opening balance: every row belongs in the body
      -- of the ledger, so this deliberately matches nothing when $3 is null.
      AND $3::date IS NOT NULL AND je."entryDate" < $3::date
      AND ($4::text IS NULL OR jl."currency" = $4)
    `,
    companyId,
    partyId,
    from ?? null,
    currencyFilter ?? null,
  );

  const openingRaw = toMoney(dec(openingRows[0]?.debit ?? 0).minus(dec(openingRows[0]?.credit ?? 0)));
  const openingBalance = params.invert ? openingRaw.negated() : openingRaw;

  const rows = await prisma.$queryRawUnsafe<RawLedgerRow[]>(
    `
    SELECT je."id" AS "journalEntryId", je."entryNumber", je."entryDate",
           je."sourceType"::text AS "sourceType", je."sourceId" AS "sourceId", je."description",
           jl."currency",
           jl."debit"::text AS debit, jl."credit"::text AS credit,
           jl."rateToUsd"::text AS "rateToUsd",
           jl."debitUsd"::text AS "debitUsd", jl."creditUsd"::text AS "creditUsd",
           jl."debitLocal"::text AS "debitLocal", jl."creditLocal"::text AS "creditLocal",
           ${REFERENCE_SQL} AS reference,
           (SELECT s."shipmentNumber" FROM shipments s WHERE s."id" = jl."shipmentId") AS "shipmentNumber",
           ${MEMO_SQL} AS memo,
           ${params.partyColumn === 'customerId' ? INVOICE_DOCUMENTS_SQL : ORDER_DOCUMENTS_SQL} AS documents,
           ${COLLECTED_BY_SQL} AS "collectedBy"
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = $1
      AND ${LIVE_ENTRY_TEXT}
      AND ${partyFilter} = $2
      AND a."subledgerType" = '${params.subledgerType}'
      AND ($3::date IS NULL OR je."entryDate" >= $3::date)
      AND ($4::date IS NULL OR je."entryDate" <= $4::date)
      AND ($5::text  IS NULL OR je."sourceType"::text = $5)
      AND ($6::text  IS NULL OR jl."shipmentId" = $6)
      AND ($7::text  IS NULL OR jl."currency" = $7)
    ORDER BY je."entryDate" ASC, je."entryNumber" ASC, jl."lineNumber" ASC
    `,
    companyId,
    partyId,
    from ?? null,
    to ?? null,
    params.sourceType ?? null,
    params.shipmentId ?? null,
    currencyFilter ?? null,
  );

  let running = openingBalance;
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);

  const shaped: LedgerRow[] = rows.map((row) => {
    const { debit, credit } = pickAmounts(row, view, currencyFilter);
    const movement = params.invert ? credit.minus(debit) : debit.minus(credit);
    running = toMoney(running.plus(movement));
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
    const documents = parseDocuments(row.documents).map((d) => ({
      ...d,
      kind: d.kind ?? ('INVOICE' as const),
    }));

    return {
      journalEntryId: row.journalEntryId,
      entryNumber: row.entryNumber,
      entryDate: row.entryDate,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      reference: row.reference,
      description: row.description,
      currency: row.currency,
      debit: currencyFilter ? debit : dec(row.debit),
      credit: currencyFilter ? credit : dec(row.credit),
      rateToUsd: dec(row.rateToUsd),
      debitUsd: dec(row.debitUsd),
      creditUsd: dec(row.creditUsd),
      debitLocal: dec(row.debitLocal),
      creditLocal: dec(row.creditLocal),
      shipmentNumber: row.shipmentNumber,
      memo: row.memo?.trim() || null,
      documents,
      typeLabel: ledgerTypeLabel({
        sourceType: row.sourceType,
        documents,
        debit: dec(row.debit).greaterThan(0),
      }),
      collectedBy: row.collectedBy,
      balance: running,
    };
  });

  const txnCurrencies = new Set(shaped.map((row) => row.currency));
  const viewCurrency = currencyFilter
    ? currencyFilter
    : view === 'TRANSACTION' && txnCurrencies.size === 1
      ? [...txnCurrencies][0]!
      : params.viewCurrency;

  return {
    openingBalance,
    closingBalance: running,
    totalDebit: toMoney(totalDebit),
    totalCredit: toMoney(totalCredit),
    rows: shaped,
    view: currencyFilter ? 'TRANSACTION' : view,
    viewCurrency,
    currencyFilter,
  };
}

/** Filter a party ledger to invoices, receipts/payments, or everything. */
export function ledgerKindToSourceType(
  kind?: string | null,
  party: 'customer' | 'vendor' = 'customer',
): string | undefined {
  if (kind === 'INVOICES') return party === 'vendor' ? 'PURCHASE_CONTRACT' : 'SALES_INVOICE';
  if (kind === 'PAYMENTS') return party === 'vendor' ? 'PAYMENT' : 'RECEIPT';
  return undefined;
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
  currency?: BookCurrency;
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
    currencyFilter: params.currency,
    viewCurrency: params.currency
      ? params.currency
      : params.view === 'USD'
        ? 'USD'
        : params.view === 'LOCAL'
          ? params.localCurrency
          : params.partyCurrency,
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
  currency?: BookCurrency;
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
    currencyFilter: params.currency,
    viewCurrency: params.currency
      ? params.currency
      : params.view === 'USD'
        ? 'USD'
        : params.view === 'LOCAL'
          ? params.localCurrency
          : params.partyCurrency,
  });
}
