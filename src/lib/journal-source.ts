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

/**
 * Editor for the source document, when one exists.
 *
 * A posted document opens its own editor, where the correction can undo
 * what the document did — the stock, the allocations, the cheque. A voucher
 * somebody wrote by hand has no such consequences, so it is corrected in the
 * journal itself, which needs the entry rather than the source.
 */
export function journalSourceEditHref(
  sourceType: string,
  sourceId: string,
  options?: { journalEntryId?: string | null },
): string | null {
  switch (sourceType) {
    case 'EXPENSE':
      return sourceId ? `/finance/expenses/${sourceId}/edit` : null;
    case 'SALES_INVOICE':
      return sourceId ? `/sales/${sourceId}/edit` : null;
    case 'PURCHASE_CONTRACT':
      return sourceId ? `/purchases/${sourceId}/edit` : null;
    case 'RECEIPT':
      return sourceId ? `/finance/receipts/${sourceId}/edit` : null;
    case 'PAYMENT':
      return sourceId ? `/finance/payments/${sourceId}/edit` : null;
    case 'MANUAL':
      return options?.journalEntryId ? `/accounting/journal/${options.journalEntryId}/edit` : null;
    default:
      return sourceId ? journalSourceHref(sourceType, sourceId) : null;
  }
}
