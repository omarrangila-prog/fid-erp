import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';
import { PageHeader } from '@/components/shared/page-header';
import { ReportsClient, type ReportEntry } from '@/app/(app)/reports/reports-client';
import { listSavedReports } from '@/lib/services/saved-reports';

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
  { href: '/reports/business-overview', title: 'Business Overview', category: 'Business overview', pinned: true,
    description: 'Cash, receivables, payables, stock, shipments and profit on one screen.',
    keywords: 'summary position management dashboard', permission: PERMISSIONS.REPORTS_VIEW },
  { href: '/reports/profit-loss', title: 'Profit & Loss', category: 'Business overview', pinned: true,
    description: 'Revenue less cost of sales and operating expenses, for any period.',
    keywords: 'income statement p&l pnl earnings', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/balance-sheet', title: 'Balance Sheet', category: 'Business overview', pinned: true,
    description: 'Assets, liabilities and equity as at a date, from the double-entry records.',
    keywords: 'statement of financial position assets liabilities equity', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/financial-position', title: 'Cash & Bank Position', category: 'Cash & bank', pinned: true,
    description: 'Every cash and bank account by currency, never merged into one total.',
    keywords: 'cash bank currency position treasury', permission: PERMISSIONS.CASHBANK_VIEW },
  { href: '/finance/receivables', title: 'Customer Receivables', category: 'Sales & customers', pinned: true,
    description: 'What customers owe, with ageing and overdue balances.',
    keywords: 'ar debtors ageing aging overdue outstanding', permission: PERMISSIONS.RECEIVABLES_VIEW },
  { href: '/finance/payables', title: 'Vendor Payables', category: 'Purchases & suppliers', pinned: true,
    description: 'What we owe suppliers, with ageing.',
    keywords: 'ap creditors ageing aging supplier outstanding', permission: PERMISSIONS.PAYABLES_VIEW },
  { href: '/inventory', title: 'Inventory Summary', category: 'Inventory', pinned: true,
    description: 'Stock on hand by coffee and warehouse, with available and reserved quantities.',
    keywords: 'stock summary on hand available kg bags', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/reports/inventory-valuation?view=summary', title: 'Inventory Valuation Summary', category: 'Inventory', pinned: false,
    description: 'Each coffee on hand, its average landed cost and asset value, adding up to the inventory on the balance sheet.',
    keywords: 'inventory valuation summary stock value asset average cost', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/reports/inventory-valuation', title: 'Inventory Valuation by Warehouse', category: 'Inventory', pinned: false,
    description: 'On-hand stock at each batch\'s landed cost, by warehouse.',
    keywords: 'inventory valuation stock value landed cost warehouse batch', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/reports/inventory-valuation?view=detail', title: 'Inventory Valuation Detail', category: 'Inventory', pinned: false,
    description: 'Every movement that changed a batch\'s quantity or value, with the quantity and value after each.',
    keywords: 'inventory valuation detail movements batch rate cost on hand', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/inventory/batches', title: 'Warehouse & Batch Stock', category: 'Inventory', pinned: true,
    description: 'Every batch and lot, where it sits and what remains of it.',
    keywords: 'batch lot container warehouse traceability', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/shipments', title: 'Shipment Position', category: 'Shipment & profitability', pinned: true,
    description: 'Where every job stands, with ETA and document status.',
    keywords: 'shipment job eta container bl booking status', permission: PERMISSIONS.SHIPMENTS_VIEW },
  { href: '/reports/analytics', title: 'Analysis', category: 'Shipment & profitability', pinned: true,
    description: 'Pivot revenue, profit and margin by customer, coffee, batch, container or shipment.',
    keywords: 'analysis pivot breakdown slice dice power bi dashboard margin', permission: PERMISSIONS.PROFITS_VIEW },
  { href: '/profitability?view=statement', title: 'Shipment Profitability Statement', category: 'Shipment & profitability', pinned: true,
    description: 'One column per shipment: purchase, direct expenses, landed cost, sold and remaining, revenue, cost of sales, profit and margin.',
    keywords: 'profitability statement column per shipment container landed cost margin', permission: PERMISSIONS.PROFITS_VIEW },
  { href: '/profitability', title: 'Shipment Profitability', category: 'Shipment & profitability', pinned: true,
    description: 'Margin per job, contract, customer, coffee, batch and container, in USD and local currency.',
    keywords: 'profit margin per kg landed cost job contract mad', permission: PERMISSIONS.PROFITS_VIEW },
  { href: '/reports/cogs', title: 'Cost of Goods Sold', category: 'Shipment & profitability', pinned: false,
    description: 'Posted cost of goods on every sold line, frozen at the batch landed cost when the invoice was posted.',
    keywords: 'cogs cost of sales landed cost invoice line', permission: PERMISSIONS.PROFITS_VIEW },

  { href: '/reports/sales', title: 'Sales Report', category: 'Sales & customers', pinned: true,
    description: 'Every sale in the period, what it cost, what it earned and what is still owed on it.',
    keywords: 'sales register invoices revenue sold customers margin', permission: PERMISSIONS.REPORTS_VIEW },
  { href: '/reports/purchases', title: 'Purchase Report', category: 'Purchases & suppliers', pinned: true,
    description: 'Every purchase in the period, how much has landed, and how much is still owed to the supplier.',
    keywords: 'purchase register contracts suppliers bought landed received', permission: PERMISSIONS.REPORTS_VIEW },
  { href: '/reports/shipment-cost', title: 'Shipment Costing', category: 'Shipment & profitability', pinned: true,
    description: 'What one job cost once freight, clearing and every other charge is in — per kilo, in both currencies.',
    keywords: 'shipment cost landed cost per kg freight clearing job costing', permission: PERMISSIONS.SHIPMENTS_VIEW },
  { href: '/reports/cash-book', title: 'Cash Book & Bank Book', category: 'Cash & bank', pinned: true,
    description: 'Every movement through one drawer or account: in, out, and what was left after each.',
    keywords: 'cash book bank book statement reconcile movements in out running balance', permission: PERMISSIONS.CASHBANK_VIEW },
  { href: '/ledgers/agents', title: 'Agent Ledger & Clearing', category: 'Agents', pinned: true,
    description: 'What each agent is holding for the company, and what the company owes them.',
    keywords: 'agent clearing collections held commission ridwan settlement', permission: PERMISSIONS.AGENTS_VIEW },
  { href: '/finance/agent-commission', title: 'Agent Commission', category: 'Agents', pinned: false,
    description: 'Commission agreed on each shipment, what has been paid and what is still owed.',
    keywords: 'agent commission payable register', permission: PERMISSIONS.AGENTS_VIEW },
  { href: '/finance/cheques', title: 'Cheque Register', category: 'Cash & bank', pinned: false,
    description: 'Every cheque in and out, pending, cleared or bounced, and who is holding it.',
    keywords: 'cheque check pending cleared bounced agent register', permission: PERMISSIONS.CHEQUES_VIEW },

  // --- Accounting ------------------------------------------------------------
  { href: '/accounting/chart', title: 'Chart of Accounts', category: 'Accounting', pinned: false,
    description: 'Every ledger head: cash, banks, receivables, payables, inventory, sales, COGS and expenses.',
    keywords: 'chart of accounts coa cash bank ar ap inventory sales cogs expenses', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/trial-balance', title: 'Trial Balance', category: 'Business overview', pinned: false,
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
  { href: '/accounting/revaluation', title: 'Currency Revaluation', category: 'Accounting', pinned: false,
    description: 'Restates foreign-currency balances at a closing rate and posts the difference to Foreign Exchange Gain/Loss.',
    keywords: 'forex fx revaluation exchange rate gain loss closing', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/forex', title: 'Forex Gain / Loss', category: 'Accounting', pinned: false,
    description: 'Exchange differences posted when a payment uses a different rate from the original bill. The original purchase is never rewritten.',
    keywords: 'forex fx gain loss exchange difference rate payment', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/ledgers/agents', title: 'Agent Ledgers', category: 'Accounting', pinned: false,
    description: 'What each collection agent is holding for the company, and what the company owes them in commission.',
    keywords: 'agent ridwan clearing collection commission payable holding', permission: PERMISSIONS.LEDGERS_VIEW },
  { href: '/finance/agent-commission', title: 'Agent Commission', category: 'Accounting', pinned: false,
    description: 'Commission agreed on a shipment: agent, contract, amount and whether it is still unpaid.',
    keywords: 'agent commission register unpaid payable contract', permission: PERMISSIONS.EXPENSES_VIEW },
  { href: '/finance/reconciliation', title: 'Bank Reconciliation', category: 'Cash & bank', pinned: false,
    description: 'Tick the ledger against a bank statement and explain what has not yet cleared.',
    keywords: 'bank reconcile statement cleared outstanding cheques', permission: PERMISSIONS.BANK_RECONCILE },
  { href: '/reports/stock-ageing', title: 'Stock Ageing', category: 'Inventory', pinned: false,
    description: 'How long each parcel has been in the warehouse, oldest first, with what is reserved.',
    keywords: 'ageing aging old stock slow moving reserved available days', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/ports', title: 'Ports', category: 'Accounting', pinned: false,
    description: 'The ports this company loads at and discharges into.',
    keywords: 'port locode loading discharge jebel ali casablanca santos', permission: PERMISSIONS.PORTS_VIEW },
  { href: '/reports/allocations', title: 'Stock Allocation', category: 'Inventory', pinned: false,
    description: 'Each purchase and every customer it was sold to, with what is still available.',
    keywords: 'allocation sold unsold remaining container split morocco customers', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/loading', title: 'Loading Follow-Up', category: 'Shipment & profitability', pinned: false,
    description: 'Every container from contract to consignee, with status, documents and payment.',
    keywords: 'loading sheet contract follow up container eta bl shipment', permission: PERMISSIONS.SHIPMENTS_VIEW },
  { href: '/inventory/stock-counts', title: 'Stock Counts', category: 'Inventory', pinned: false,
    description: 'Physical counts against the books, with every difference explained and valued.',
    keywords: 'stock take count physical shrinkage variance', permission: PERMISSIONS.STOCK_COUNT_VIEW },
  { href: '/reports/cash-flow', title: 'Cash Flow', category: 'Business overview', pinned: false,
    description: 'Money in and out of every account, grouped by what caused it.',
    keywords: 'cash flow movement receipts payments', permission: PERMISSIONS.CASHBANK_VIEW },
  { href: '/finance/cash-bank', title: 'Cash & Bank Accounts', category: 'Cash & bank', pinned: false,
    description: 'Each account with its own book, in its own currency.',
    keywords: 'cash book bank book petty cash', permission: PERMISSIONS.CASHBANK_VIEW },
  { href: '/finance/cheques', title: 'Cheque Register', category: 'Cash & bank', pinned: false,
    description: 'Every cheque and where it stands in its life cycle.',
    keywords: 'cheque check deposited cleared bounced', permission: PERMISSIONS.CHEQUES_VIEW },

  // --- Ledgers ---------------------------------------------------------------
  { href: '/ledgers/customers', title: 'Customer Ledgers', category: 'Sales & customers', pinned: false,
    description: 'Per-customer account in their currency, USD or local books.',
    keywords: 'customer statement ledger running balance', permission: PERMISSIONS.LEDGERS_VIEW },
  { href: '/ledgers/vendors', title: 'Supplier Ledgers', category: 'Purchases & suppliers', pinned: false,
    description: 'Per-supplier account with the same three views.',
    keywords: 'vendor supplier statement ledger', permission: PERMISSIONS.LEDGERS_VIEW },

  // --- Trading ---------------------------------------------------------------
  { href: '/sales', title: 'Sales Register', category: 'Sales & customers', pinned: false,
    description: 'Every invoice with what has been paid and what is outstanding.',
    keywords: 'sales invoices register revenue', permission: PERMISSIONS.SALES_VIEW },
  { href: '/purchases', title: 'Purchase Register', category: 'Purchases & suppliers', pinned: false,
    description: 'Every contract with ordered, received and outstanding quantities.',
    keywords: 'purchase orders po contracts received', permission: PERMISSIONS.PURCHASES_VIEW },
  { href: '/goods-receipts', title: 'Goods Receipts', category: 'Purchases & suppliers', pinned: false,
    description: 'What arrived, when, into which warehouse.',
    keywords: 'grn receipt inbound arrival', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/loading', title: 'Loading Sheet', category: 'Shipment & profitability', pinned: false,
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
  { href: '/reports/expenses', title: 'Expense Report', category: 'Purchases & suppliers', pinned: false,
    description: 'Costs by category, by job or by month.',
    keywords: 'expenses category job cost overhead', permission: PERMISSIONS.EXPENSES_VIEW },
  { href: '/reports/sales-by?by=customer', title: 'Sales by Customer', category: 'Sales & customers', pinned: true,
    description: 'Sales, cost and gross profit per customer, each row opening into its invoice lines.',
    keywords: 'sales customer summary detail revenue margin', permission: PERMISSIONS.SALES_VIEW },
  { href: '/reports/sales-by?by=item', title: 'Sales by Item', category: 'Sales & customers', pinned: false,
    description: 'Quantity sold, sales, COGS and gross profit per coffee.',
    keywords: 'sales item product coffee summary detail margin', permission: PERMISSIONS.SALES_VIEW },
  { href: '/reports/sales-by?by=shipment', title: 'Sales by Shipment', category: 'Shipment & profitability', pinned: false,
    description: 'What each shipment sold, and what it earned.',
    keywords: 'sales shipment container batch warehouse', permission: PERMISSIONS.SALES_VIEW },
  { href: '/reports/balances', title: 'Customer Balance Summary', category: 'Sales & customers', pinned: false,
    description: 'One line per customer: what they owe. Click through to the ledger.',
    keywords: 'customer balance summary owed outstanding', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/balances?side=suppliers', title: 'Supplier Balance Summary', category: 'Purchases & suppliers', pinned: false,
    description: 'One line per supplier: what we owe them.',
    keywords: 'supplier vendor balance summary owed outstanding', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/ageing', title: 'A/R Ageing Summary & Detail', category: 'Sales & customers', pinned: true,
    description: 'Who owes what, by how long — Current, 1–30, 31–60, 61–90, 90+ — each row opening into its invoices.',
    keywords: 'ageing aging receivable customer overdue bucket collections outstanding', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/ageing?side=payables', title: 'A/P Ageing Summary & Detail', category: 'Purchases & suppliers', pinned: false,
    description: 'What we owe each supplier, by how long — each row opening into its orders.',
    keywords: 'ageing aging payable supplier vendor overdue bucket outstanding', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/general-ledger?account=all', title: 'General Ledger — all accounts', category: 'Accounting', pinned: false,
    description: 'The printed ledger: every account with activity, opening, lines, running balance, closing.',
    keywords: 'general ledger book all accounts register', permission: PERMISSIONS.ACCOUNTING_VIEW },
  { href: '/reports/stock-movement', title: 'Daily Stock Movement', category: 'Inventory', pinned: false,
    description: 'Opening stock, everything that moved, closing stock — for a day or any range.',
    keywords: 'stock movement opening closing daily received sold transfer', permission: PERMISSIONS.INVENTORY_VIEW },
  { href: '/reports/overhead-allocation', title: 'Overhead Allocation', category: 'Purchases & suppliers', pinned: false,
    description: "Share the company's general expenses across shipments — management view, nothing posted.",
    keywords: 'overhead allocation general expense absorb rent salary management', permission: PERMISSIONS.REPORTS_VIEW },
  { href: '/admin/audit', title: 'Audit Trail', category: 'Accounting', pinned: false,
    description: 'Who did what and when, across every module.',
    keywords: 'audit log activity user history changes', permission: PERMISSIONS.AUDIT_VIEW },
];

export default async function ReportsPage() {
  const user = await requirePageAccess(PERMISSIONS.REPORTS_VIEW);
  const saved = await listSavedReports(user.activeCompany.id, user.id);

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
      <ReportsClient reports={reports} saved={saved} />
    </div>
  );
}
