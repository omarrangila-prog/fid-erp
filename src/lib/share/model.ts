import { z } from 'zod';
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';

/**
 * Sharing a report on WhatsApp: what is shared, and what is recorded about it.
 *
 * A share is a copy of the report as the person sees it — the same rows, the
 * same columns they chose, the same totals — never a second calculation. The
 * page that shows the report builds this snapshot from what it has already
 * worked out; the PDF, the secure link and the WhatsApp message are all made
 * from the one snapshot, so the screen, the PDF and the link cannot disagree.
 *
 * Nothing here knows whether a WhatsApp message was actually sent: the
 * application opens WhatsApp or the phone's share sheet and can only record
 * that. The statuses below say exactly what the application did.
 */

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

export type ShareRowKind = 'row' | 'opening' | 'subtotal' | 'total' | 'closing' | 'heading';

export type ShareSection = {
  heading?: string;
  columns: Array<{ label: string; numeric?: boolean }>;
  rows: Array<{ cells: Array<{ text: string; span?: number }>; kind?: ShareRowKind }>;
};

export type ShareSnapshot = {
  v: 1;
  company: string;
  /** "Agent Ledger", "Profit & Loss". */
  title: string;
  /** The party, account, shipment or invoice. */
  subject?: string;
  period?: string;
  /** In words: "Commission only", "Search: rent". */
  filters: string[];
  /** What part of the report: "Current filtered report", "3 selected rows". */
  scope: string;
  /** Figures above the table: opening balance, closing balance, invoice total. */
  facts: Array<{ label: string; value: string }>;
  sections: ShareSection[];
  generatedAt: string;
  generatedBy: string;
};

const MAX_TEXT = 2_000;
const text = z.string().max(MAX_TEXT);

export const shareSnapshotSchema = z.object({
  v: z.literal(1),
  company: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  subject: z.string().max(300).optional(),
  period: z.string().max(200).optional(),
  filters: z.array(text).max(40),
  scope: z.string().max(200),
  facts: z.array(z.object({ label: text, value: text })).max(60),
  sections: z
    .array(
      z.object({
        heading: z.string().max(300).optional(),
        columns: z.array(z.object({ label: text, numeric: z.boolean().optional() })).min(1).max(40),
        rows: z
          .array(
            z.object({
              cells: z.array(z.object({ text, span: z.number().int().min(1).max(40).optional() })).max(40),
              kind: z.enum(['row', 'opening', 'subtotal', 'total', 'closing', 'heading']).optional(),
            }),
          )
          .max(5_000),
      }),
    )
    .max(30),
  generatedAt: z.string().max(40),
  generatedBy: z.string().max(200),
}) satisfies z.ZodType<ShareSnapshot>;

/** A link holds at most this much report; a ledger of a few thousand rows fits well inside it. */
export const MAX_SNAPSHOT_BYTES = 2_500_000;

export function snapshotRowCount(snapshot: Pick<ShareSnapshot, 'sections'>): number {
  return snapshot.sections.reduce((n, s) => n + s.rows.filter((r) => (r.kind ?? 'row') === 'row').length, 0);
}

// ---------------------------------------------------------------------------
// Which reports can be shared, and who may share them
// ---------------------------------------------------------------------------

type ReportDef = { label: string; party?: 'Customer' | 'Supplier' | 'Agent' | 'Shipment' | 'Account' | 'Invoice'; permissions: PermissionCode[] };

const LEDGERS: PermissionCode[] = [PERMISSIONS.LEDGERS_VIEW, PERMISSIONS.CUSTOMERS_VIEW, PERMISSIONS.VENDORS_VIEW, PERMISSIONS.AGENTS_VIEW, PERMISSIONS.CASHBANK_VIEW];
const ACCOUNTS: PermissionCode[] = [PERMISSIONS.REPORTS_VIEW, PERMISSIONS.ACCOUNTING_VIEW, PERMISSIONS.PROFITS_VIEW, PERMISSIONS.LEDGERS_VIEW];
const SALES: PermissionCode[] = [PERMISSIONS.SALES_VIEW, PERMISSIONS.RECEIPTS_VIEW, PERMISSIONS.RECEIVABLES_VIEW, PERMISSIONS.CREDIT_NOTES_VIEW, PERMISSIONS.REPORTS_VIEW];
const PURCHASES: PermissionCode[] = [PERMISSIONS.PURCHASES_VIEW, PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.PAYABLES_VIEW, PERMISSIONS.VENDORS_VIEW, PERMISSIONS.REPORTS_VIEW];
const SHIPMENTS: PermissionCode[] = [PERMISSIONS.SHIPMENTS_VIEW, PERMISSIONS.EXPENSES_VIEW, PERMISSIONS.PROFITS_VIEW, PERMISSIONS.REPORTS_VIEW];
const STOCK: PermissionCode[] = [PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.WAREHOUSES_VIEW, PERMISSIONS.ITEMS_VIEW, PERMISSIONS.STOCK_COUNT_VIEW, PERMISSIONS.REPORTS_VIEW];
const EXPENSES: PermissionCode[] = [PERMISSIONS.EXPENSES_VIEW, PERMISSIONS.LEDGERS_VIEW, PERMISSIONS.REPORTS_VIEW];
const AGENTS: PermissionCode[] = [PERMISSIONS.AGENTS_VIEW, PERMISSIONS.LEDGERS_VIEW, PERMISSIONS.EXPENSES_VIEW];
const CASH: PermissionCode[] = [PERMISSIONS.CASHBANK_VIEW, PERMISSIONS.CHEQUES_VIEW, PERMISSIONS.REPORTS_VIEW, PERMISSIONS.LEDGERS_VIEW];

export const SHARE_REPORTS = {
  // Ledgers
  'customer-ledger': { label: 'Customer Ledger', party: 'Customer', permissions: LEDGERS },
  'supplier-ledger': { label: 'Supplier Ledger', party: 'Supplier', permissions: LEDGERS },
  'agent-ledger': { label: 'Agent Ledger', party: 'Agent', permissions: LEDGERS },
  'cash-bank-ledger': { label: 'Cash & Bank Ledger', party: 'Account', permissions: LEDGERS },
  'general-ledger': { label: 'General Ledger', party: 'Account', permissions: ACCOUNTS },
  'unpaid-expenses': { label: 'Unpaid Expenses', permissions: EXPENSES },
  'customer-statement': { label: 'Customer Statement', party: 'Customer', permissions: LEDGERS },
  'supplier-statement': { label: 'Supplier Statement', party: 'Supplier', permissions: LEDGERS },
  // Accounting reports
  'profit-loss': { label: 'Profit & Loss', permissions: ACCOUNTS },
  'balance-sheet': { label: 'Balance Sheet', permissions: ACCOUNTS },
  'trial-balance': { label: 'Trial Balance', permissions: ACCOUNTS },
  'cash-flow': { label: 'Cash Flow', permissions: ACCOUNTS },
  'general-journal': { label: 'General Journal', permissions: ACCOUNTS },
  'financial-position': { label: 'Financial Position', permissions: ACCOUNTS },
  'business-overview': { label: 'Business Overview', permissions: ACCOUNTS },
  'balances': { label: 'Account Balances', permissions: ACCOUNTS },
  'forex': { label: 'Exchange Differences', permissions: ACCOUNTS },
  'tax-return': { label: 'Tax Return', permissions: ACCOUNTS },
  'reconciliation': { label: 'Reconciliation', permissions: ACCOUNTS },
  'chart-of-accounts': { label: 'Chart of Accounts', permissions: ACCOUNTS },
  'cogs': { label: 'Cost of Goods Sold', permissions: ACCOUNTS },
  'analytics': { label: 'Analytics', permissions: ACCOUNTS },
  // Cash
  'cash-book': { label: 'Cash Book & Bank Book', party: 'Account', permissions: CASH },
  'cash-bank': { label: 'Cash & Bank Accounts', permissions: CASH },
  'cheques': { label: 'Cheque Register', permissions: CASH },
  // Sales and purchases
  'sales-invoices': { label: 'Sales Invoices', permissions: SALES },
  'outstanding-invoices': { label: 'Outstanding Invoices', permissions: SALES },
  'invoice': { label: 'Sales Invoice', party: 'Invoice', permissions: SALES },
  'sales-report': { label: 'Sales Report', permissions: SALES },
  'sales-by': { label: 'Sales Summary', permissions: SALES },
  'receipts': { label: 'Payments Received', permissions: SALES },
  'receivables': { label: 'Receivables', permissions: SALES },
  'ageing': { label: 'Ageing', permissions: [...SALES, ...PURCHASES] },
  'customers': { label: 'Customers', permissions: SALES },
  'credit-notes': { label: 'Credit Notes', permissions: SALES },
  'purchase-orders': { label: 'Purchase Orders', permissions: PURCHASES },
  'purchase-report': { label: 'Purchase Report', permissions: PURCHASES },
  'payments': { label: 'Payments Made', permissions: PURCHASES },
  'payables': { label: 'Payables', permissions: PURCHASES },
  'suppliers': { label: 'Suppliers', permissions: PURCHASES },
  'goods-receipts': { label: 'Goods Receipts', permissions: [...PURCHASES, ...STOCK] },
  // Shipments
  'shipments': { label: 'Shipments', permissions: SHIPMENTS },
  'shipment': { label: 'Shipment Report', party: 'Shipment', permissions: SHIPMENTS },
  'shipment-costing': { label: 'Shipment Costing', party: 'Shipment', permissions: SHIPMENTS },
  'shipment-profitability': { label: 'Shipment Profitability', permissions: SHIPMENTS },
  'loading-sheet': { label: 'Loading Sheet', permissions: SHIPMENTS },
  'allocations': { label: 'Container Allocation', permissions: [...SHIPMENTS, ...STOCK] },
  // Expenses
  'expenses': { label: 'Expenses', permissions: EXPENSES },
  'shipment-expenses': { label: 'Shipment Expenses', permissions: EXPENSES },
  'expense-report': { label: 'Expense Report', permissions: EXPENSES },
  // Agents
  'agent-balances': { label: 'Agent Balances', permissions: AGENTS },
  'agents': { label: 'Agents', permissions: AGENTS },
  'agent-commission': { label: 'Agent Commission', permissions: AGENTS },
  // Stock
  'stock-on-hand': { label: 'Stock on Hand', permissions: STOCK },
  'warehouse-stock': { label: 'Warehouse Stock', permissions: STOCK },
  'batch-stock': { label: 'Batches / Containers', permissions: STOCK },
  'inventory-valuation': { label: 'Inventory Valuation', permissions: STOCK },
  'stock-movement': { label: 'Stock Movements', permissions: STOCK },
  'stock-ageing': { label: 'Stock Ageing', permissions: STOCK },
  'transfers': { label: 'Warehouse Transfers', permissions: STOCK },
  'items': { label: 'Items', permissions: STOCK },
} as const satisfies Record<string, ReportDef>;

export type ShareReportKey = keyof typeof SHARE_REPORTS;

export function isShareReportKey(value: string): value is ShareReportKey {
  return Object.prototype.hasOwnProperty.call(SHARE_REPORTS, value);
}

export function shareReportLabel(key: string): string {
  return isShareReportKey(key) ? SHARE_REPORTS[key].label : key;
}

export function shareReportParty(key: string): string | null {
  if (!isShareReportKey(key)) return null;
  const def: ReportDef = SHARE_REPORTS[key];
  return def.party ?? null;
}

export function shareReportPermissions(key: ShareReportKey): PermissionCode[] {
  return [...SHARE_REPORTS[key].permissions];
}

// ---------------------------------------------------------------------------
// Formats, methods, expiry, statuses
// ---------------------------------------------------------------------------

export const SHARE_FORMATS = ['PDF', 'LINK'] as const;
export type ShareFormat = (typeof SHARE_FORMATS)[number];

/** How the person handed the report on. */
export const SHARE_METHODS = ['NATIVE_SHARE', 'WHATSAPP', 'DOWNLOAD'] as const;
export type ShareMethod = (typeof SHARE_METHODS)[number];

export const SHARE_METHOD_LABEL: Record<ShareMethod, string> = {
  NATIVE_SHARE: 'Phone share sheet',
  WHATSAPP: 'WhatsApp',
  DOWNLOAD: 'PDF download',
};

export const SHARE_EXPIRY = ['1', '3', '7', '30', 'never'] as const;
export type ShareExpiry = (typeof SHARE_EXPIRY)[number];
export const SHARE_EXPIRY_LABEL: Record<ShareExpiry, string> = {
  '1': '1 day',
  '3': '3 days',
  '7': '7 days',
  '30': '30 days',
  never: 'Never expires',
};

/**
 * What the application actually did — and nothing it cannot know. "Sent" is
 * deliberately absent: opening WhatsApp or the share sheet says nothing about
 * whether anybody pressed Send.
 */
export const SHARE_EVENTS = {
  SHARE_INITIATED: 'Share initiated',
  SHARE_PDF_GENERATED: 'PDF generated',
  SHARE_PDF_DOWNLOADED: 'PDF downloaded',
  SHARE_LINK_GENERATED: 'Link generated',
  SHARE_WHATSAPP_OPENED: 'WhatsApp opened',
  SHARE_SHEET_OPENED: 'Share sheet opened',
  SHARE_SHEET_HANDED_OFF: 'Handed to an app from the share sheet',
  SHARE_CANCELLED: 'Cancelled before sharing',
  SHARE_LINK_VIEWED: 'Link opened',
  SHARE_LINK_REVOKED: 'Link revoked',
  SHARE_LINK_EXPIRED_VIEW: 'Expired link opened',
} as const;
export type ShareEvent = keyof typeof SHARE_EVENTS;

/** The client may report these; the server writes the others itself. */
export const CLIENT_SHARE_EVENTS = [
  'SHARE_INITIATED',
  'SHARE_PDF_GENERATED',
  'SHARE_PDF_DOWNLOADED',
  'SHARE_WHATSAPP_OPENED',
  'SHARE_SHEET_OPENED',
  'SHARE_SHEET_HANDED_OFF',
  'SHARE_CANCELLED',
] as const satisfies readonly ShareEvent[];

/** What a share log entry says about the share — metadata only, never the report itself. */
export const shareMetaSchema = z.object({
  shareId: z.string().regex(/^shr_[a-z0-9]{12,32}$/),
  report: z.string().max(60),
  title: z.string().max(200),
  subject: z.string().max(300).optional(),
  period: z.string().max(200).optional(),
  filters: z.array(z.string().max(300)).max(40),
  scope: z.string().max(200),
  rows: z.number().int().min(0).max(1_000_000),
  columns: z.array(z.string().max(120)).max(40),
  format: z.enum(SHARE_FORMATS),
  method: z.enum(SHARE_METHODS),
  page: z.string().max(500),
});
export type ShareMeta = z.infer<typeof shareMetaSchema>;

export const SHARE_ENTITY = 'ReportShare';

/** One line of text for WhatsApp, and for a PDF's file name. */
export function shareHeadline(s: Pick<ShareSnapshot, 'title' | 'subject'>): string {
  return s.subject ? `${s.subject} — ${s.title}` : s.title;
}

export function shareFileName(s: Pick<ShareSnapshot, 'title' | 'subject' | 'period'>): string {
  const base = [s.subject, s.title, s.period].filter(Boolean).join(' ');
  const safe = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return `${safe || 'report'}.pdf`;
}

/** The message WhatsApp opens with. */
export function whatsappMessage(s: Pick<ShareSnapshot, 'company' | 'title' | 'subject' | 'period'>, link?: string): string {
  return [s.company, shareHeadline(s), s.period, link ? `\nView report:\n${link}` : null].filter(Boolean).join('\n');
}

export function whatsappUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}
