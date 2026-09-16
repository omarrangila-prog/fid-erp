/**
 * Map a journal line back to the document that created it.
 *
 * Ledgers and cash books are derived. Editing a derived row would break
 * reconciliation; these hrefs open the source voucher instead.
 */

export function journalSourceHref(
  sourceType: string,
  sourceId: string,
  extra?: { entryNumber?: string },
): string | null {
  if (!sourceId) return extra?.entryNumber ? `/reports/journal?q=${encodeURIComponent(extra.entryNumber)}` : null;

  switch (sourceType) {
    case 'EXPENSE':
      return `/finance/expenses/${sourceId}`;
    case 'RECEIPT':
      return `/finance/receipts/${sourceId}`;
    case 'PAYMENT':
      return `/finance/payments/${sourceId}`;
    case 'SALES_INVOICE':
      return `/sales/${sourceId}`;
    case 'PURCHASE_CONTRACT':
      return `/purchases/${sourceId}`;
    case 'CREDIT_NOTE':
      return `/sales/credit-notes/${sourceId}`;
    case 'CHEQUE':
      return `/finance/cheques`;
    case 'AGENT_SETTLEMENT':
      return `/agents`;
    case 'MANUAL':
      return extra?.entryNumber ? `/reports/journal?q=${encodeURIComponent(extra.entryNumber)}` : '/reports/journal';
    case 'OPENING_BALANCE':
      return '/accounting/chart';
    case 'STOCK_COUNT':
      return `/inventory/stock-counts/${sourceId}`;
    case 'INVENTORY_ADJUSTMENT':
      return '/inventory';
    default:
      return extra?.entryNumber ? `/reports/journal?q=${encodeURIComponent(extra.entryNumber)}` : '/reports/journal';
  }
}

/** Editor for the source document, when one exists. Posted drafts still open the editor; posted expenses redirect to the voucher. */
export function journalSourceEditHref(sourceType: string, sourceId: string): string | null {
  if (!sourceId) return null;
  switch (sourceType) {
    case 'EXPENSE':
      return `/finance/expenses/${sourceId}/edit`;
    case 'SALES_INVOICE':
      return `/sales/${sourceId}/edit`;
    case 'PURCHASE_CONTRACT':
      return `/purchases/${sourceId}/edit`;
    default:
      return journalSourceHref(sourceType, sourceId);
  }
}
