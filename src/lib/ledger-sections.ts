/**
 * The headings the General Ledgers list is read under.
 *
 * A trader opening that page wants to know how much cash there is, what the
 * stock is worth, what is owed to Dubai and where he stands with the man who
 * collects for him. Those are four different questions, and a flat list of
 * ledger accounts answers none of them — which is what the client was
 * looking at. Every entry belongs under one of these.
 *
 * They live here rather than beside the query that fills them because the
 * list itself runs in the browser, and importing the service there drags the
 * database driver into the bundle with it.
 */
export const LEDGER_SECTIONS = {
  CASH_BANK: 'Cash & bank',
  INVENTORY: 'Inventory',
  RELATED_PARTY: 'Related parties & loans',
  COUNTERPARTY: 'Agents & counterparties',
  CONTROL: 'Control accounts',
  OTHER: 'Other ledgers',
} as const;

export type LedgerSection = keyof typeof LEDGER_SECTIONS;

/** The order a trader reads them in: money first, then what is owed. */
export const SECTION_ORDER: LedgerSection[] = [
  'CASH_BANK',
  'INVENTORY',
  'RELATED_PARTY',
  'COUNTERPARTY',
  'OTHER',
  'CONTROL',
];
