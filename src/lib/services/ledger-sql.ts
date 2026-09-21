import { dec } from '@/lib/money';

/**
 * What every ledger row carries besides its amounts: the memo the person
 * typed on the source document, the invoices or orders it belongs to, and who
 * collected the money.
 *
 * Read from the source document at display time rather than copied onto the
 * journal line, so the memo is typed once — on the payment, the invoice, the
 * expense — and every ledger that shows the entry shows the same words.
 */

/** The memo of the document behind a journal entry, or the voucher's own text for a journal. */
export const MEMO_SQL = `
  CASE je."sourceType"
    WHEN 'RECEIPT'           THEN (SELECT r."description" FROM receipts r WHERE r."id" = je."sourceId")
    WHEN 'SALES_INVOICE'     THEN (SELECT si."notes" FROM sales_invoices si WHERE si."id" = je."sourceId")
    WHEN 'PAYMENT'           THEN (SELECT p."description" FROM payments p WHERE p."id" = je."sourceId")
    WHEN 'EXPENSE'           THEN (SELECT e."description" FROM expenses e WHERE e."id" = je."sourceId")
    WHEN 'PURCHASE_CONTRACT' THEN (SELECT pc."notes" FROM purchase_contracts pc WHERE pc."id" = je."sourceId")
    WHEN 'CREDIT_NOTE'       THEN (SELECT COALESCE(cn."notes", cn."reason") FROM credit_notes cn WHERE cn."id" = je."sourceId")
    WHEN 'AGENT_SETTLEMENT'  THEN (SELECT s."notes" FROM agent_settlements s WHERE s."id" = je."sourceId")
    WHEN 'MANUAL'            THEN je."description"
    WHEN 'OPENING_BALANCE'   THEN je."description"
    ELSE NULL
  END
`;

/** The agent a receipt was collected by, when it was. */
export const COLLECTED_BY_SQL = `
  CASE WHEN je."sourceType" = 'RECEIPT' THEN
    (SELECT a2."agentName" FROM receipts r2 JOIN agents a2 ON a2."id" = r2."agentId" WHERE r2."id" = je."sourceId")
  END
`;

/**
 * The sales invoices a row belongs to, as JSON: the invoice itself, the
 * invoices a receipt was applied to (with how much went to each, so a part
 * payment can be told from a full one), or the invoice a credit note is on.
 */
export const INVOICE_DOCUMENTS_SQL = `
  COALESCE(
    CASE
      WHEN je."sourceType" = 'SALES_INVOICE' THEN
        (SELECT json_agg(json_build_object('id', si."id", 'number', si."invoiceNumber", 'total', si."totalAmount"::text))
         FROM sales_invoices si WHERE si."id" = je."sourceId")
      WHEN je."sourceType" = 'RECEIPT' AND jl."salesInvoiceId" IS NOT NULL THEN
        (SELECT json_agg(json_build_object('id', si."id", 'number', si."invoiceNumber", 'total', si."totalAmount"::text,
                                           'applied', (SELECT SUM(ra."amount") FROM receipt_allocations ra
                                                       WHERE ra."receiptId" = je."sourceId" AND ra."salesInvoiceId" = si."id")::text))
         FROM sales_invoices si WHERE si."id" = jl."salesInvoiceId")
      WHEN je."sourceType" = 'RECEIPT' THEN
        (SELECT json_agg(json_build_object('id', si."id", 'number', si."invoiceNumber", 'total', si."totalAmount"::text,
                                           'applied', ra."amount"::text) ORDER BY si."invoiceNumber")
         FROM receipt_allocations ra JOIN sales_invoices si ON si."id" = ra."salesInvoiceId"
         WHERE ra."receiptId" = je."sourceId")
      WHEN je."sourceType" = 'CREDIT_NOTE' THEN
        (SELECT json_agg(json_build_object('id', si."id", 'number', si."invoiceNumber", 'total', si."totalAmount"::text))
         FROM credit_notes cn JOIN sales_invoices si ON si."id" = cn."salesInvoiceId" WHERE cn."id" = je."sourceId")
      WHEN jl."salesInvoiceId" IS NOT NULL THEN
        (SELECT json_agg(json_build_object('id', si."id", 'number', si."invoiceNumber", 'total', si."totalAmount"::text))
         FROM sales_invoices si WHERE si."id" = jl."salesInvoiceId")
    END,
    '[]'::json
  )
`;

/** The purchase orders (by their ICUL/FID reference) and expenses a supplier row belongs to. */
export const ORDER_DOCUMENTS_SQL = `
  COALESCE(
    CASE
      WHEN je."sourceType" = 'PURCHASE_CONTRACT' THEN
        (SELECT json_agg(json_build_object('id', pc."id", 'number', pc."contractReference", 'kind', 'ORDER', 'total', pc."totalValue"::text))
         FROM purchase_contracts pc WHERE pc."id" = je."sourceId")
      WHEN je."sourceType" = 'PAYMENT' THEN
        (SELECT json_agg(x) FROM (
           SELECT json_build_object('id', pc."id", 'number', pc."contractReference", 'kind', 'ORDER',
                                    'total', pc."totalValue"::text, 'applied', pa."amount"::text) AS x
           FROM payment_allocations pa JOIN purchase_contracts pc ON pc."id" = pa."purchaseContractId"
           WHERE pa."paymentId" = je."sourceId"
           UNION ALL
           SELECT json_build_object('id', e."id", 'number', e."expenseNumber", 'kind', 'EXPENSE',
                                    'total', e."amount"::text, 'applied', pa."amount"::text) AS x
           FROM payment_allocations pa JOIN expenses e ON e."id" = pa."expenseId"
           WHERE pa."paymentId" = je."sourceId"
         ) docs)
      WHEN je."sourceType" = 'EXPENSE' THEN
        (SELECT json_agg(json_build_object('id', e."id", 'number', e."expenseNumber", 'kind', 'EXPENSE'))
         FROM expenses e WHERE e."id" = je."sourceId")
      WHEN jl."purchaseContractId" IS NOT NULL THEN
        (SELECT json_agg(json_build_object('id', pc."id", 'number', pc."contractReference", 'kind', 'ORDER'))
         FROM purchase_contracts pc WHERE pc."id" = jl."purchaseContractId")
    END,
    '[]'::json
  )
`;

export type LedgerDocument = {
  id: string;
  /** What the client calls it: INV 15, or the order's ICUL/FID reference. */
  number: string;
  kind?: 'INVOICE' | 'ORDER' | 'EXPENSE';
  total?: string | null;
  /** How much of this row's money went to the document, where that applies. */
  applied?: string | null;
};

export function parseDocuments(raw: unknown): LedgerDocument[] {
  const list = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(list)) return [];
  return list.filter((d): d is LedgerDocument => Boolean(d && typeof d === 'object' && 'id' in d));
}

/** A payment covered part of a document when what it applied is less than the document's total. */
export function isPartial(documents: LedgerDocument[]): boolean {
  return documents.some(
    (d) => d.applied !== undefined && d.applied !== null && d.total && dec(d.applied).lessThan(dec(d.total).minus('0.005')),
  );
}

/**
 * The row's type in the client's words.
 *
 * "Receipt" does not say whether the invoice is now paid; "Partial Payment"
 * does. A receipt applied to nothing is an advance, and says so.
 */
export function ledgerTypeLabel(params: {
  sourceType: string;
  documents: LedgerDocument[];
  debit: boolean;
  collectedBy?: string | null;
  accountKey?: string | null;
  accountName?: string | null;
  /** Worded for the agent's own ledger: "Loan Received from Agent" rather than "Loan Received". */
  agent?: boolean;
}): string {
  const { sourceType, documents } = params;
  const name = (params.accountName ?? '').toLowerCase();
  const of = params.agent ? ' from Agent' : '';
  const to = params.agent ? ' to Agent' : '';
  if (name.startsWith('loan from')) return params.debit ? `Loan Repaid${to}` : `Loan Received${of}`;
  if (name.startsWith('loan to')) return params.debit ? `Loan Given${to}` : `Loan Repaid${params.agent ? ' by Agent' : ''}`;
  if (params.accountKey === 'AGENT_COMMISSION_PAYABLE') return params.debit ? 'Commission Paid' : 'Agent Commission';
  switch (sourceType) {
    case 'SALES_INVOICE':
      return 'Invoice';
    case 'RECEIPT':
      if (params.accountKey === 'AGENT_CLEARING') return params.debit ? 'Collected from Customer' : 'Collection Reversed';
      if (documents.length === 0) return 'Advance Received';
      return isPartial(documents) ? 'Partial Payment' : 'Payment';
    case 'PAYMENT':
      if (documents.length === 0) return 'Advance Paid';
      return isPartial(documents) ? 'Partial Payment' : 'Payment';
    case 'PURCHASE_CONTRACT':
      return 'Purchase Order';
    case 'CREDIT_NOTE':
      return 'Credit Note';
    case 'EXPENSE':
      return 'Expense';
    case 'CHEQUE':
      return 'Cheque';
    case 'OPENING_BALANCE':
      return 'Opening Balance';
    case 'AGENT_SETTLEMENT':
      return 'Agent Settlement';
    case 'LANDED_COST':
      return 'Landed Cost';
    case 'MANUAL':
      return params.accountKey === 'AGENT_CLEARING' ? (params.debit ? 'Cash Received by Agent' : 'Cash Paid by Agent') : 'Journal Adjustment';
    default:
      return sourceType
        .toLowerCase()
        .split('_')
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' ');
  }
}
