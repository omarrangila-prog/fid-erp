import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';
import { PageHeader } from '@/components/shared/page-header';
import { ReportsClient, type ReportEntry } from '@/app/(app)/reports/reports-client';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

type Catalogued = ReportEntry & { permission: PermissionCode };

/**
 * The report catalogue.
 *
 * `pinned` marks the handful a trading business opens daily; everything else is
 * grouped by category and reachable through search. Each entry names the
 * permission that gates it, and the page it points at checks the same one — the
 * list is a convenience, not the control.
 */
const CATALOGUE: Catalogued[] = [
  // --- Everyday --------------------------------------------------------------
  { href: '/reports/business-overview', title: 'Business Overview', category: 'Business Overview', pinned: true,
    description: 'Cash, receivables, payables, stock, shipments and profit on one screen.',
    keywords: 'summary position management dashboard', permission: PERMISSIONS.REPORTS_VIEW },
  { href: '/reports/profit-loss', title: 'Profit & Loss', category: 'Financial Statements', pinned: true,
    description: 'Revenue less cost of sales and operating expenses, for any period.',
    keywords: 'income statement p&l pnl earnings', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/balance-sheet', title: 'Balance Sheet', category: 'Financial Statements', pinned: true,
    description: 'Assets, liabilities and equity as at a date, from the double-entry records.',
    keywords: 'statement of financial position assets liabilities equity', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/financial-position', title: 'Cash & Bank Position', category: 'Cash & Bank', pinned: true,
    description: 'Every cash and bank account by currency, never merged into one total.',
    keywords: 'cash bank currency position treasury', permission: PERMISSIONS.CASHBANK_VIEW },
  { href: '/finance/receivables', title: 'Customer Receivables', category: 'Receivables', pinned: true,
    description: 'What customers owe, with ageing and overdue balances.',
    keywords: 'ar debtors ageing aging overdue outstanding', permission: PERMISSIONS.RECEIVABLES_VIEW },
  { href: '/finance/payables', title: 'Vendor Payables', category: 'Payables', pinned: true,
    description: 'What we owe suppliers, with ageing.',
    keywords: 'ap creditors ageing aging supplier outstanding', permission: PERMISSIONS.PAYABLES_VIEW },
  { href: '/inventory', title: 'Inventory Summary', category: 'Inventory', pinned: true,
    description: 'Stock on hand by coffee and warehouse, with available and reserved quantities.',
    keywords: 'stock summary on hand available kg bags', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/inventory/batches', title: 'Warehouse & Batch Stock', category: 'Inventory', pinned: true,
    description: 'Every batch and lot, where it sits and what remains of it.',
    keywords: 'batch lot container warehouse traceability', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/shipments', title: 'Shipment Position', category: 'Shipments', pinned: true,
    description: 'Where every job stands, with ETA and document status.',
    keywords: 'shipment job eta container bl booking status', permission: PERMISSIONS.SHIPMENTS_VIEW },
  { href: '/reports/analytics', title: 'Analysis', category: 'Profitability', pinned: true,
    description: 'Pivot revenue, profit and margin by customer, coffee, batch, container or shipment.',
    keywords: 'analysis pivot breakdown slice dice power bi dashboard margin', permission: PERMISSIONS.PROFITS_VIEW },
  { href: '/profitability', title: 'Shipment Profitability', category: 'Profitability', pinned: true,
    description: 'Margin per job, customer, coffee, batch and container.',
    keywords: 'profit margin per kg landed cost job', permission: PERMISSIONS.PROFITS_VIEW },

  // --- Accounting ------------------------------------------------------------
  { href: '/reports/trial-balance', title: 'Trial Balance', category: 'Accounting', pinned: false,
    description: 'Every account with a balance, in USD and local currency.',
    keywords: 'tb debit credit accounts', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/general-ledger', title: 'General Ledger', category: 'Accounting', pinned: false,
    description: 'Every movement through a chosen account, with a running balance.',
    keywords: 'gl account ledger running balance', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/journal', title: 'Journal', category: 'Accounting', pinned: false,
    description: 'Every posted entry with its lines, newest first.',
    keywords: 'journal entries double entry postings', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/reconciliation', title: 'Reconciliation', category: 'Accounting', pinned: false,
    description: 'Checks that the control accounts agree with the sub-ledgers and the stock ledger.',
    keywords: 'reconcile control account integrity check audit tie out', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/tax-return', title: 'Tax Return', category: 'Accounting', pinned: false,
    description: 'VAT or TVA for a filing period, with the taxable base split by treatment and tied back to the ledger.',
    keywords: 'vat tva tax return output input fta filing 201', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/finance/reconciliation', title: 'Bank Reconciliation', category: 'Cash & Bank', pinned: false,
    description: 'Tick the ledger against a bank statement and explain what has not yet cleared.',
    keywords: 'bank reconcile statement cleared outstanding cheques', permission: PERMISSIONS.BANK_RECONCILE },
  { href: '/reports/allocations', title: 'Stock Allocation', category: 'Inventory', pinned: false,
    description: 'Each purchase and every customer it was sold to, with what is still available.',
    keywords: 'allocation sold unsold remaining container split morocco customers', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/loading', title: 'Loading Follow-Up', category: 'Trading', pinned: false,
    description: 'Every container from contract to consignee, with status, documents and payment.',
    keywords: 'loading sheet contract follow up container eta bl shipment', permission: PERMISSIONS.SHIPMENTS_VIEW },
  { href: '/inventory/stock-counts', title: 'Stock Counts', category: 'Inventory', pinned: false,
    description: 'Physical counts against the books, with every difference explained and valued.',
    keywords: 'stock take count physical shrinkage variance', permission: PERMISSIONS.STOCK_COUNT_VIEW },
  { href: '/reports/cash-flow', title: 'Cash Flow', category: 'Cash & Bank', pinned: false,
    description: 'Money in and out of every account, grouped by what caused it.',
    keywords: 'cash flow movement receipts payments', permission: PERMISSIONS.CASHBANK_VIEW },
  { href: '/finance/cash-bank', title: 'Cash & Bank Accounts', category: 'Cash & Bank', pinned: false,
    description: 'Each account with its own book, in its own currency.',
    keywords: 'cash book bank book petty cash', permission: PERMISSIONS.CASHBANK_VIEW },
  { href: '/finance/cheques', title: 'Cheque Register', category: 'Cash & Bank', pinned: false,
    description: 'Every cheque and where it stands in its life cycle.',
    keywords: 'cheque check deposited cleared bounced', permission: PERMISSIONS.CHEQUES_VIEW },

  // --- Ledgers ---------------------------------------------------------------
  { href: '/ledgers/customers', title: 'Customer Ledgers', category: 'Receivables', pinned: false,
    description: 'Per-customer account in their currency, USD or local books.',
    keywords: 'customer statement ledger running balance', permission: PERMISSIONS.LEDGERS_VIEW },
  { href: '/ledgers/vendors', title: 'Supplier Ledgers', category: 'Payables', pinned: false,
    description: 'Per-supplier account with the same three views.',
    keywords: 'vendor supplier statement ledger', permission: PERMISSIONS.LEDGERS_VIEW },

  // --- Trading ---------------------------------------------------------------
  { href: '/sales', title: 'Sales Register', category: 'Sales', pinned: false,
    description: 'Every invoice with what has been paid and what is outstanding.',
    keywords: 'sales invoices register revenue', permission: PERMISSIONS.SALES_VIEW },
  { href: '/purchases', title: 'Purchase Register', category: 'Purchases', pinned: false,
    description: 'Every contract with ordered, received and outstanding quantities.',
    keywords: 'purchase orders po contracts received', permission: PERMISSIONS.PURCHASES_VIEW },
  { href: '/goods-receipts', title: 'Goods Receipts', category: 'Purchases', pinned: false,
    description: 'What arrived, when, into which warehouse.',
    keywords: 'grn receipt inbound arrival', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/loading', title: 'Loading Sheet', category: 'Shipments', pinned: false,
    description: 'The operational sheet: job, coffee, container, buyer and status.',
    keywords: 'loading sheet operations container buyer', permission: PERMISSIONS.SHIPMENTS_VIEW },
  { href: '/inventory/shipments', title: 'Shipment Stock', category: 'Inventory', pinned: false,
    description: 'Coffee still on the water, by job.',
    keywords: 'in transit shipment stock afloat', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/inventory/movements', title: 'Stock Movements', category: 'Inventory', pinned: false,
    description: 'The movement ledger: every receipt, sale, transfer and adjustment.',
    keywords: 'movement ledger in out transfer adjustment history', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/inventory/transfers', title: 'Warehouse Transfers', category: 'Inventory', pinned: false,
    description: 'Stock moved between warehouses, and what is still in transit.',
    keywords: 'transfer warehouse move relocation', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/reports/expenses', title: 'Expense Report', category: 'Purchases', pinned: false,
    description: 'Costs by category, by job or by month.',
    keywords: 'expenses category job cost overhead', permission: PERMISSIONS.EXPENSES_VIEW },
  { href: '/admin/audit', title: 'Audit Trail', category: 'Audit & Activity', pinned: false,
    description: 'Who did what and when, across every module.',
    keywords: 'audit log activity user history changes', permission: PERMISSIONS.AUDIT_VIEW },
];

export default async function ReportsPage() {
  const user = await requirePageAccess(PERMISSIONS.REPORTS_VIEW);

  const reports: ReportEntry[] = CATALOGUE.filter((entry) => can(user, entry.permission)).map((entry) => ({
    href: entry.href,
    title: entry.title,
    description: entry.description,
    category: entry.category,
    pinned: entry.pinned,
    keywords: entry.keywords,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Every figure is calculated from posted transactions. Nothing here is a stored summary."
        breadcrumbs={[{ label: 'Reports' }]}
      />
      <ReportsClient reports={reports} />
    </div>
  );
}
