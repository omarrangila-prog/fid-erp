/**
 * The columns every ledger can show, and which it shows by default.
 *
 * One list for every ledger in the system — customer, supplier, agent, cash
 * and bank, general ledger, unpaid expenses — so a column means the same
 * thing wherever it appears. Date, Memo, Debit, Credit and Balance are the
 * accounting view and are always on; everything else is the reader's choice,
 * remembered per person and per ledger.
 */

export const LEDGER_COLUMN_KEYS = [
  'date',
  'reference',
  'jv',
  'type',
  'memo',
  'shipment',
  'invoice',
  'party',
  'currency',
  'status',
  'createdBy',
  'debit',
  'credit',
  'balance',
] as const;

export type LedgerColumnKey = (typeof LEDGER_COLUMN_KEYS)[number];

export const LEDGER_COLUMN_LABEL: Record<LedgerColumnKey, string> = {
  date: 'Date',
  reference: 'Reference',
  jv: 'JV No.',
  type: 'Transaction type',
  memo: 'Memo',
  shipment: 'Shipment ref',
  invoice: 'Invoice no.',
  party: 'Party',
  currency: 'Currency',
  status: 'Status',
  createdBy: 'Created by',
  debit: 'Debit',
  credit: 'Credit',
  balance: 'Balance',
};

/** Always shown: the accounting view itself. They can be moved, not removed. */
export const CORE_LEDGER_COLUMNS: readonly LedgerColumnKey[] = ['date', 'memo', 'debit', 'credit', 'balance'];

export const DEFAULT_LEDGER_COLUMNS: readonly LedgerColumnKey[] = ['date', 'reference', 'memo', 'debit', 'credit', 'balance'];

export const LEDGER_PAGE_SIZES = [25, 50, 100] as const;

export type LedgerPrefs = {
  /** Visible columns, in the order shown. */
  columns: LedgerColumnKey[];
  pageSize: (typeof LEDGER_PAGE_SIZES)[number];
  /** Table, or one card per row on a small phone. */
  view: 'table' | 'compact';
  /** Whether this person has saved a layout; until then a phone leaves Reference out. */
  saved?: boolean;
};

export const DEFAULT_LEDGER_PREFS: LedgerPrefs = { columns: [...DEFAULT_LEDGER_COLUMNS], pageSize: 50, view: 'table' };

export const LEDGER_REPORT_KEYS = ['customer', 'supplier', 'agent', 'cash-bank', 'general-ledger', 'unpaid-expenses'] as const;
export type LedgerReportKey = (typeof LEDGER_REPORT_KEYS)[number];

/** Whatever was stored, made safe: known columns only, the core ones always present, sizes from the list. */
export function normaliseLedgerPrefs(value: unknown, available: readonly LedgerColumnKey[] = LEDGER_COLUMN_KEYS): LedgerPrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof LedgerPrefs, unknown>>;
  const allowed = new Set<LedgerColumnKey>([...available, ...CORE_LEDGER_COLUMNS]);
  const wanted = Array.isArray(raw.columns)
    ? raw.columns.filter((c): c is LedgerColumnKey => typeof c === 'string' && allowed.has(c as LedgerColumnKey))
    : DEFAULT_LEDGER_COLUMNS.filter((c) => allowed.has(c));
  const columns = [...new Set(wanted)];
  // A core column that went missing goes back where the default puts it.
  for (const core of CORE_LEDGER_COLUMNS) {
    if (!columns.includes(core)) {
      const after = DEFAULT_LEDGER_COLUMNS.slice(0, DEFAULT_LEDGER_COLUMNS.indexOf(core)).reverse().find((c) => columns.includes(c));
      columns.splice(after ? columns.indexOf(after) + 1 : 0, 0, core);
    }
  }
  const pageSize = LEDGER_PAGE_SIZES.includes(raw.pageSize as never) ? (raw.pageSize as LedgerPrefs['pageSize']) : 50;
  return { columns, pageSize, view: raw.view === 'compact' ? 'compact' : 'table' };
}

export const ledgerPrefsKey = (userId: string, report: LedgerReportKey) => `ledger_view:${userId}:${report}`;
