/**
 * Central catalogue of permissions, roles, statuses and accounting metadata for
 * the FID coffee trading platform.
 *
 * Permission codes are the single source of truth for authorisation. They are
 * seeded into the `permissions` table and referenced by both the server guards
 * and the navigation. Never invent a permission string inline.
 */

export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard.view',

  // --- Masters -------------------------------------------------------------
  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_EDIT: 'customers.edit',
  CUSTOMERS_DELETE: 'customers.delete',

  VENDORS_VIEW: 'vendors.view',
  VENDORS_CREATE: 'vendors.create',
  VENDORS_EDIT: 'vendors.edit',
  VENDORS_DELETE: 'vendors.delete',

  AGENTS_VIEW: 'agents.view',
  AGENTS_MANAGE: 'agents.manage',

  ITEMS_VIEW: 'items.view',
  ITEMS_CREATE: 'items.create',
  ITEMS_EDIT: 'items.edit',
  ITEMS_DELETE: 'items.delete',

  WAREHOUSES_VIEW: 'warehouses.view',
  WAREHOUSES_MANAGE: 'warehouses.manage',

  SHIPPING_LINES_VIEW: 'shippinglines.view',
  SHIPPING_LINES_MANAGE: 'shippinglines.manage',

  PORTS_VIEW: 'ports.view',
  PORTS_MANAGE: 'ports.manage',

  EXPENSE_CATEGORIES_VIEW: 'expensecategories.view',
  EXPENSE_CATEGORIES_MANAGE: 'expensecategories.manage',

  // --- Purchasing ----------------------------------------------------------
  PURCHASES_VIEW: 'purchases.view',
  PURCHASES_CREATE: 'purchases.create',
  PURCHASES_EDIT: 'purchases.edit',
  PURCHASES_DELETE: 'purchases.delete',
  /** Approve == post to the ledgers. */
  PURCHASES_APPROVE: 'purchases.approve',
  PURCHASES_REVERSE: 'purchases.reverse',
  /** Gates every display of unit purchase cost and landed cost. */
  PURCHASE_COST_VIEW: 'purchases.cost.view',

  // --- Sales ---------------------------------------------------------------
  SALES_VIEW: 'sales.view',
  SALES_CREATE: 'sales.create',
  SALES_EDIT: 'sales.edit',
  SALES_DELETE: 'sales.delete',
  SALES_APPROVE: 'sales.approve',
  SALES_REVERSE: 'sales.reverse',

  // --- Logistics -----------------------------------------------------------
  SHIPMENTS_VIEW: 'shipments.view',
  SHIPMENTS_UPDATE: 'shipments.update',
  CONTAINERS_MANAGE: 'containers.manage',

  // --- Inventory -----------------------------------------------------------
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_TRANSFER: 'inventory.transfer',
  /** Explicit, audited override that permits stock to go negative. */
  INVENTORY_NEGATIVE_OVERRIDE: 'inventory.negative.override',

  // --- Cash cycle ----------------------------------------------------------
  RECEIPTS_VIEW: 'receipts.view',
  RECEIPTS_CREATE: 'receipts.create',
  RECEIPTS_POST: 'receipts.post',
  RECEIPTS_DELETE: 'receipts.delete',

  PAYMENTS_VIEW: 'payments.view',
  PAYMENTS_CREATE: 'payments.create',
  PAYMENTS_POST: 'payments.post',
  PAYMENTS_DELETE: 'payments.delete',

  EXPENSES_VIEW: 'expenses.view',
  EXPENSES_CREATE: 'expenses.create',
  EXPENSES_POST: 'expenses.post',
  EXPENSES_DELETE: 'expenses.delete',

  CHEQUES_VIEW: 'cheques.view',
  CHEQUES_CREATE: 'cheques.create',
  CHEQUES_UPDATE_STATUS: 'cheques.status.update',

  CASHBANK_VIEW: 'cashbank.view',
  CASHBANK_MANAGE: 'cashbank.manage',

  LEDGERS_VIEW: 'ledgers.view',
  RECEIVABLES_VIEW: 'receivables.view',
  PAYABLES_VIEW: 'payables.view',

  // --- Accounting and insight ----------------------------------------------
  ACCOUNTING_VIEW: 'accounting.view',
  ACCOUNTING_POST: 'accounting.post',
  /** Closing a period freezes it for everyone; reopening is equally serious. */
  PERIODS_CLOSE: 'accounting.periods.close',
  /** Gates gross margin, net profit, landed cost and shipment profitability. */
  PROFITS_VIEW: 'profits.view',
  REPORTS_VIEW: 'reports.view',
  REPORTS_EXPORT: 'reports.export',

  ATTACHMENTS_VIEW: 'attachments.view',
  ATTACHMENTS_MANAGE: 'attachments.manage',

  // --- Credits, counts and reconciliation ----------------------------------
  CREDIT_NOTES_VIEW: 'creditnotes.view',
  CREDIT_NOTES_CREATE: 'creditnotes.create',
  CREDIT_NOTES_POST: 'creditnotes.post',
  STOCK_COUNT_VIEW: 'stockcount.view',
  STOCK_COUNT_MANAGE: 'stockcount.manage',
  STOCK_COUNT_POST: 'stockcount.post',
  BANK_RECONCILE: 'bank.reconcile',
  BACKUP_MANAGE: 'backup.manage',

  // --- Administration ------------------------------------------------------
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  COMPANIES_MANAGE: 'companies.manage',
  AUDIT_VIEW: 'audit.view',
  SETTINGS_MANAGE: 'settings.manage',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<PermissionCode, { module: string; description: string }> = {
  [PERMISSIONS.DASHBOARD_VIEW]: { module: 'Dashboard', description: 'View the management dashboard' },

  [PERMISSIONS.CUSTOMERS_VIEW]: { module: 'Masters', description: 'View customers' },
  [PERMISSIONS.CUSTOMERS_CREATE]: { module: 'Masters', description: 'Create customers' },
  [PERMISSIONS.CUSTOMERS_EDIT]: { module: 'Masters', description: 'Edit customers' },
  [PERMISSIONS.CUSTOMERS_DELETE]: { module: 'Masters', description: 'Deactivate customers' },

  [PERMISSIONS.VENDORS_VIEW]: { module: 'Masters', description: 'View suppliers' },
  [PERMISSIONS.VENDORS_CREATE]: { module: 'Masters', description: 'Create suppliers' },
  [PERMISSIONS.VENDORS_EDIT]: { module: 'Masters', description: 'Edit suppliers' },
  [PERMISSIONS.VENDORS_DELETE]: { module: 'Masters', description: 'Deactivate suppliers' },

  [PERMISSIONS.AGENTS_VIEW]: { module: 'Masters', description: 'View clearing and commission agents' },
  [PERMISSIONS.AGENTS_MANAGE]: { module: 'Masters', description: 'Create and edit agents' },

  [PERMISSIONS.ITEMS_VIEW]: { module: 'Masters', description: 'View the coffee item master' },
  [PERMISSIONS.ITEMS_CREATE]: { module: 'Masters', description: 'Create coffee items' },
  [PERMISSIONS.ITEMS_EDIT]: { module: 'Masters', description: 'Edit coffee items' },
  [PERMISSIONS.ITEMS_DELETE]: { module: 'Masters', description: 'Deactivate coffee items' },

  [PERMISSIONS.WAREHOUSES_VIEW]: { module: 'Masters', description: 'View warehouses' },
  [PERMISSIONS.WAREHOUSES_MANAGE]: { module: 'Masters', description: 'Create and edit warehouses' },

  [PERMISSIONS.SHIPPING_LINES_VIEW]: { module: 'Masters', description: 'View shipping lines' },
  [PERMISSIONS.SHIPPING_LINES_MANAGE]: { module: 'Masters', description: 'Create and edit shipping lines' },
  [PERMISSIONS.PORTS_VIEW]: { module: 'Masters', description: 'View ports' },
  [PERMISSIONS.PORTS_MANAGE]: { module: 'Masters', description: 'Create and edit ports' },

  [PERMISSIONS.EXPENSE_CATEGORIES_VIEW]: { module: 'Masters', description: 'View expense categories' },
  [PERMISSIONS.EXPENSE_CATEGORIES_MANAGE]: { module: 'Masters', description: 'Create and edit expense categories' },

  [PERMISSIONS.PURCHASES_VIEW]: { module: 'Purchasing', description: 'View purchase contracts' },
  [PERMISSIONS.PURCHASES_CREATE]: { module: 'Purchasing', description: 'Create draft purchase contracts' },
  [PERMISSIONS.PURCHASES_EDIT]: { module: 'Purchasing', description: 'Edit draft purchase contracts' },
  [PERMISSIONS.PURCHASES_DELETE]: { module: 'Purchasing', description: 'Delete draft purchase contracts' },
  [PERMISSIONS.PURCHASES_APPROVE]: { module: 'Purchasing', description: 'Approve and post purchase contracts' },
  [PERMISSIONS.PURCHASES_REVERSE]: { module: 'Purchasing', description: 'Reverse posted purchase contracts' },
  [PERMISSIONS.PURCHASE_COST_VIEW]: { module: 'Purchasing', description: 'View purchase cost and landed cost figures' },

  [PERMISSIONS.SALES_VIEW]: { module: 'Sales', description: 'View sales invoices' },
  [PERMISSIONS.SALES_CREATE]: { module: 'Sales', description: 'Create draft sales invoices' },
  [PERMISSIONS.SALES_EDIT]: { module: 'Sales', description: 'Edit draft sales invoices' },
  [PERMISSIONS.SALES_DELETE]: { module: 'Sales', description: 'Delete draft sales invoices' },
  [PERMISSIONS.SALES_APPROVE]: { module: 'Sales', description: 'Approve and post sales invoices' },
  [PERMISSIONS.SALES_REVERSE]: { module: 'Sales', description: 'Reverse posted sales invoices' },

  [PERMISSIONS.SHIPMENTS_VIEW]: { module: 'Logistics', description: 'View shipments and the loading sheet' },
  [PERMISSIONS.SHIPMENTS_UPDATE]: { module: 'Logistics', description: 'Update shipment and document status' },
  [PERMISSIONS.CONTAINERS_MANAGE]: { module: 'Logistics', description: 'Create and edit containers' },

  [PERMISSIONS.INVENTORY_VIEW]: { module: 'Inventory', description: 'View stock and stock movements' },
  [PERMISSIONS.INVENTORY_ADJUST]: { module: 'Inventory', description: 'Post inventory adjustments' },
  [PERMISSIONS.INVENTORY_TRANSFER]: { module: 'Inventory', description: 'Transfer stock between warehouses' },
  [PERMISSIONS.INVENTORY_NEGATIVE_OVERRIDE]: {
    module: 'Inventory',
    description: 'Override the block on negative stock (audited)',
  },

  [PERMISSIONS.RECEIPTS_VIEW]: { module: 'Finance', description: 'View customer receipts' },
  [PERMISSIONS.RECEIPTS_CREATE]: { module: 'Finance', description: 'Create draft receipts' },
  [PERMISSIONS.RECEIPTS_POST]: { module: 'Finance', description: 'Post and reverse receipts' },
  [PERMISSIONS.RECEIPTS_DELETE]: { module: 'Finance', description: 'Delete draft receipts' },

  [PERMISSIONS.PAYMENTS_VIEW]: { module: 'Finance', description: 'View supplier payments' },
  [PERMISSIONS.PAYMENTS_CREATE]: { module: 'Finance', description: 'Create draft payments' },
  [PERMISSIONS.PAYMENTS_POST]: { module: 'Finance', description: 'Post and reverse payments' },
  [PERMISSIONS.PAYMENTS_DELETE]: { module: 'Finance', description: 'Delete draft payments' },

  [PERMISSIONS.EXPENSES_VIEW]: { module: 'Finance', description: 'View expenses and job costs' },
  [PERMISSIONS.EXPENSES_CREATE]: { module: 'Finance', description: 'Create draft expenses' },
  [PERMISSIONS.EXPENSES_POST]: { module: 'Finance', description: 'Post and reverse expenses' },
  [PERMISSIONS.EXPENSES_DELETE]: { module: 'Finance', description: 'Delete draft expenses' },

  [PERMISSIONS.CHEQUES_VIEW]: { module: 'Finance', description: 'View the cheque register' },
  [PERMISSIONS.CHEQUES_CREATE]: { module: 'Finance', description: 'Record cheques' },
  [PERMISSIONS.CHEQUES_UPDATE_STATUS]: {
    module: 'Finance',
    description: 'Deposit, clear, bounce or cancel a cheque',
  },

  [PERMISSIONS.CASHBANK_VIEW]: { module: 'Finance', description: 'View cash, petty cash and bank positions' },
  [PERMISSIONS.CASHBANK_MANAGE]: { module: 'Finance', description: 'Create and edit cash/bank accounts' },

  [PERMISSIONS.LEDGERS_VIEW]: { module: 'Finance', description: 'View customer and supplier ledgers' },
  [PERMISSIONS.RECEIVABLES_VIEW]: { module: 'Finance', description: 'View receivables and ageing' },
  [PERMISSIONS.PAYABLES_VIEW]: { module: 'Finance', description: 'View payables and ageing' },

  [PERMISSIONS.ACCOUNTING_VIEW]: { module: 'Accounting', description: 'View journals, ledgers and statements' },
  [PERMISSIONS.ACCOUNTING_POST]: { module: 'Accounting', description: 'Post manual journal vouchers' },
  [PERMISSIONS.PERIODS_CLOSE]: { module: 'Accounting', description: 'Close and reopen accounting periods' },

  [PERMISSIONS.PROFITS_VIEW]: { module: 'Management', description: 'View margin, net profit and profitability' },
  [PERMISSIONS.REPORTS_VIEW]: { module: 'Management', description: 'Run reports' },
  [PERMISSIONS.REPORTS_EXPORT]: { module: 'Management', description: 'Export reports and lists' },

  [PERMISSIONS.ATTACHMENTS_VIEW]: { module: 'Documents', description: 'View document attachments' },
  [PERMISSIONS.ATTACHMENTS_MANAGE]: { module: 'Documents', description: 'Upload and remove attachments' },

  [PERMISSIONS.CREDIT_NOTES_VIEW]: { module: 'Credits', description: 'View credit notes' },
  [PERMISSIONS.CREDIT_NOTES_CREATE]: { module: 'Credits', description: 'Raise credit notes' },
  [PERMISSIONS.CREDIT_NOTES_POST]: { module: 'Credits', description: 'Post and reverse credit notes' },
  [PERMISSIONS.STOCK_COUNT_VIEW]: { module: 'Inventory', description: 'View stock counts' },
  [PERMISSIONS.STOCK_COUNT_MANAGE]: { module: 'Inventory', description: 'Start a count and record quantities' },
  [PERMISSIONS.STOCK_COUNT_POST]: { module: 'Inventory', description: 'Post a stock count and its adjustments' },
  [PERMISSIONS.BANK_RECONCILE]: { module: 'Finance', description: 'Reconcile a bank account to a statement' },
  [PERMISSIONS.BACKUP_MANAGE]: { module: 'Administration', description: 'Take backups and view backup history' },

  [PERMISSIONS.USERS_MANAGE]: { module: 'Administration', description: 'Create users and assign roles/companies' },
  [PERMISSIONS.ROLES_MANAGE]: { module: 'Administration', description: 'Create roles and grant permissions' },
  [PERMISSIONS.COMPANIES_MANAGE]: { module: 'Administration', description: 'Create and edit companies' },
  [PERMISSIONS.AUDIT_VIEW]: { module: 'Administration', description: 'View the audit trail' },
  [PERMISSIONS.SETTINGS_MANAGE]: { module: 'Administration', description: 'Change application settings' },
};

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as PermissionCode[];

const P = PERMISSIONS;

/** Everything a read-only viewer may see, excluding cost and profit. */
const VIEW_ONLY: PermissionCode[] = [
  P.DASHBOARD_VIEW,
  P.CUSTOMERS_VIEW,
  P.VENDORS_VIEW,
  P.AGENTS_VIEW,
  P.ITEMS_VIEW,
  P.WAREHOUSES_VIEW,
  P.SHIPPING_LINES_VIEW,
  P.PORTS_VIEW,
  P.EXPENSE_CATEGORIES_VIEW,
  P.PURCHASES_VIEW,
  P.SALES_VIEW,
  P.SHIPMENTS_VIEW,
  P.INVENTORY_VIEW,
  P.RECEIPTS_VIEW,
  P.PAYMENTS_VIEW,
  P.EXPENSES_VIEW,
  P.CHEQUES_VIEW,
  P.CASHBANK_VIEW,
  P.LEDGERS_VIEW,
  P.RECEIVABLES_VIEW,
  P.PAYABLES_VIEW,
  P.REPORTS_VIEW,
  P.ATTACHMENTS_VIEW,
];

export const SYSTEM_ROLES: Array<{
  code: string;
  name: string;
  description: string;
  permissions: PermissionCode[];
}> = [
  {
    code: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Unrestricted access to every company and every function.',
    permissions: ALL_PERMISSIONS,
  },
  {
    code: 'COMPANY_ADMIN',
    name: 'Company Admin',
    description: 'Full operational and financial control within assigned companies.',
    permissions: ALL_PERMISSIONS.filter((p) => p !== P.COMPANIES_MANAGE),
  },
  {
    code: 'MANAGER',
    name: 'Manager',
    description: 'Approves trading documents and sees full profitability, but does not administer the system.',
    permissions: [
      P.STOCK_COUNT_VIEW,
      P.STOCK_COUNT_POST,
      P.CREDIT_NOTES_VIEW,
      ...VIEW_ONLY,
      P.PURCHASE_COST_VIEW,
      P.PROFITS_VIEW,
      P.ACCOUNTING_VIEW,
      P.REPORTS_EXPORT,
      P.PURCHASES_APPROVE,
      P.SALES_APPROVE,
      P.PURCHASES_REVERSE,
      P.SALES_REVERSE,
      P.SHIPMENTS_UPDATE,
      P.AUDIT_VIEW,
    ],
  },
  {
    code: 'ACCOUNTS',
    name: 'Accounts',
    description: 'Runs the finance function: receipts, payments, cheques, expenses, ledgers and accounting.',
    permissions: [
      ...VIEW_ONLY,
      P.PERIODS_CLOSE,
      P.CREDIT_NOTES_VIEW,
      P.CREDIT_NOTES_CREATE,
      P.CREDIT_NOTES_POST,
      P.BANK_RECONCILE,
      P.STOCK_COUNT_VIEW,
      P.PURCHASE_COST_VIEW,
      P.RECEIPTS_CREATE,
      P.RECEIPTS_POST,
      P.RECEIPTS_DELETE,
      P.PAYMENTS_CREATE,
      P.PAYMENTS_POST,
      P.PAYMENTS_DELETE,
      P.EXPENSES_CREATE,
      P.EXPENSES_POST,
      P.EXPENSES_DELETE,
      P.CHEQUES_CREATE,
      P.CHEQUES_UPDATE_STATUS,
      P.EXPENSE_CATEGORIES_MANAGE,
      P.CASHBANK_MANAGE,
      P.ACCOUNTING_VIEW,
      P.ACCOUNTING_POST,
      P.PROFITS_VIEW,
      P.REPORTS_EXPORT,
      P.ATTACHMENTS_MANAGE,
    ],
  },
  {
    code: 'SALES',
    name: 'Sales',
    description: 'Sells coffee and manages customers. Cannot see purchase cost or profit.',
    permissions: [
      P.DASHBOARD_VIEW,
      P.CUSTOMERS_VIEW,
      P.CUSTOMERS_CREATE,
      P.CUSTOMERS_EDIT,
      P.ITEMS_VIEW,
      P.WAREHOUSES_VIEW,
      P.SALES_VIEW,
      P.SALES_CREATE,
      P.SALES_EDIT,
      P.SALES_APPROVE,
      P.SHIPMENTS_VIEW,
      P.INVENTORY_VIEW,
      P.RECEIVABLES_VIEW,
      P.RECEIPTS_VIEW,
      P.LEDGERS_VIEW,
      P.REPORTS_VIEW,
      P.REPORTS_EXPORT,
      P.ATTACHMENTS_VIEW,
    ],
  },
  {
    code: 'PURCHASE',
    name: 'Purchase',
    description: 'Raises purchase contracts and manages suppliers and the coffee master.',
    permissions: [
      P.DASHBOARD_VIEW,
      P.VENDORS_VIEW,
      P.VENDORS_CREATE,
      P.VENDORS_EDIT,
      P.AGENTS_VIEW,
      P.ITEMS_VIEW,
      P.ITEMS_CREATE,
      P.ITEMS_EDIT,
      P.WAREHOUSES_VIEW,
      P.PURCHASES_VIEW,
      P.PURCHASES_CREATE,
      P.PURCHASES_EDIT,
      P.PURCHASES_APPROVE,
      P.PURCHASE_COST_VIEW,
      P.SHIPMENTS_VIEW,
      P.INVENTORY_VIEW,
      P.PAYABLES_VIEW,
      P.REPORTS_VIEW,
      P.REPORTS_EXPORT,
      P.ATTACHMENTS_MANAGE,
      P.ATTACHMENTS_VIEW,
    ],
  },
  {
    code: 'WAREHOUSE',
    name: 'Warehouse',
    description: 'Maintains stock accuracy, transfers and adjustments.',
    permissions: [
      P.STOCK_COUNT_VIEW,
      P.STOCK_COUNT_MANAGE,
      P.DASHBOARD_VIEW,
      P.ITEMS_VIEW,
      P.WAREHOUSES_VIEW,
      P.SHIPMENTS_VIEW,
      P.INVENTORY_VIEW,
      P.INVENTORY_ADJUST,
      P.INVENTORY_TRANSFER,
      P.REPORTS_VIEW,
      P.ATTACHMENTS_VIEW,
    ],
  },
  {
    code: 'LOGISTICS',
    name: 'Shipment / Logistics',
    description: 'Drives loading, booking, bills of lading, ETA and clearance.',
    permissions: [
      P.DASHBOARD_VIEW,
      P.CUSTOMERS_VIEW,
      P.VENDORS_VIEW,
      P.AGENTS_VIEW,
      P.ITEMS_VIEW,
      P.WAREHOUSES_VIEW,
      P.SHIPPING_LINES_VIEW,
  P.PORTS_VIEW,
      P.SHIPPING_LINES_MANAGE,
      P.PORTS_MANAGE,
      P.PURCHASES_VIEW,
      P.SALES_VIEW,
      P.SHIPMENTS_VIEW,
      P.SHIPMENTS_UPDATE,
      P.CONTAINERS_MANAGE,
      P.INVENTORY_VIEW,
      P.EXPENSES_VIEW,
      P.EXPENSES_CREATE,
      P.REPORTS_VIEW,
      P.REPORTS_EXPORT,
      P.ATTACHMENTS_MANAGE,
      P.ATTACHMENTS_VIEW,
    ],
  },
  {
    code: 'DATA_ENTRY',
    name: 'Data Entry',
    description:
      'Types documents into the system and nothing else. Can raise every kind of draft, but cannot post one, cannot see cost or margin, and cannot reach anything administrative.',
    permissions: [
      // --- What they need to work ---------------------------------------
      P.DASHBOARD_VIEW,
      P.CUSTOMERS_VIEW,
      P.CUSTOMERS_CREATE,
      P.CUSTOMERS_EDIT,
      P.VENDORS_VIEW,
      P.VENDORS_CREATE,
      P.VENDORS_EDIT,
      P.AGENTS_VIEW,
      P.ITEMS_VIEW,
      P.ITEMS_CREATE,
      P.ITEMS_EDIT,
      P.WAREHOUSES_VIEW,
      P.SHIPPING_LINES_VIEW,
  P.PORTS_VIEW,
      P.EXPENSE_CATEGORIES_VIEW,

      // Every document can be *raised*. None can be approved or posted:
      // that is a second pair of eyes, and it is the whole point of the role.
      P.PURCHASES_VIEW,
      P.PURCHASES_CREATE,
      P.PURCHASES_EDIT,
      P.SALES_VIEW,
      P.SALES_CREATE,
      P.SALES_EDIT,
      P.RECEIPTS_VIEW,
      P.RECEIPTS_CREATE,
      P.PAYMENTS_VIEW,
      P.PAYMENTS_CREATE,
      P.EXPENSES_VIEW,
      P.EXPENSES_CREATE,
      P.CHEQUES_VIEW,
      P.CHEQUES_CREATE,
      P.CREDIT_NOTES_VIEW,
      P.CREDIT_NOTES_CREATE,

      // Enough of the operational picture to enter a document correctly.
      P.SHIPMENTS_VIEW,
      P.SHIPMENTS_UPDATE,
      P.INVENTORY_VIEW,
      P.STOCK_COUNT_VIEW,
      P.STOCK_COUNT_MANAGE,
      P.CASHBANK_VIEW,
      P.RECEIVABLES_VIEW,
      P.PAYABLES_VIEW,
      P.REPORTS_VIEW,
      P.ATTACHMENTS_VIEW,
      P.ATTACHMENTS_MANAGE,

      // --- Deliberately absent ------------------------------------------
      // Every *_APPROVE, *_POST, *_REVERSE and *_DELETE: a person who types a
      // document must not also be the one who commits it to the ledger.
      //
      // PURCHASE_COST_VIEW and PROFITS_VIEW: what the coffee cost and what it
      // earned are the owner's business, and a data-entry operator has no
      // reason to see either.
      //
      // ACCOUNTING_VIEW, ACCOUNTING_POST, PERIODS_CLOSE, BANK_RECONCILE,
      // LEDGERS_VIEW: the books themselves.
      //
      // INVENTORY_ADJUST, INVENTORY_TRANSFER, INVENTORY_NEGATIVE_OVERRIDE:
      // moving or writing off stock without a counted sheet behind it.
      //
      // USERS_MANAGE, ROLES_MANAGE, COMPANIES_MANAGE, SETTINGS_MANAGE,
      // AUDIT_VIEW, BACKUP_MANAGE: administration.
    ],
  },
  {
    code: 'STAFF',
    name: 'Staff',
    description: 'General staff: can view operational data and raise drafts, but cannot post.',
    permissions: [
      P.DASHBOARD_VIEW,
      P.CUSTOMERS_VIEW,
      P.VENDORS_VIEW,
      P.ITEMS_VIEW,
      P.WAREHOUSES_VIEW,
      P.PURCHASES_VIEW,
      P.SALES_VIEW,
      P.SALES_CREATE,
      P.SHIPMENTS_VIEW,
      P.INVENTORY_VIEW,
      P.EXPENSES_VIEW,
      P.EXPENSES_CREATE,
      P.ATTACHMENTS_VIEW,
    ],
  },
  {
    code: 'READ_ONLY',
    name: 'Read Only',
    description: 'Sees everything operational including profitability, but cannot change anything.',
    permissions: [...VIEW_ONLY, P.PURCHASE_COST_VIEW, P.PROFITS_VIEW, P.ACCOUNTING_VIEW, P.REPORTS_EXPORT],
  },
];

// ---------------------------------------------------------------------------
// Status metadata used by badges across the UI
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';

export const SHIPMENT_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  CONTRACT_CREATED: { label: 'Contract Created', tone: 'neutral' },
  AWAITING_LOADING: { label: 'Awaiting Loading', tone: 'warning' },
  LOADED: { label: 'Loaded', tone: 'info' },
  IN_TRANSIT: { label: 'In Transit', tone: 'progress' },
  ARRIVED: { label: 'Arrived', tone: 'info' },
  CUSTOMS_CLEARING: { label: 'Customs / Clearing', tone: 'progress' },
  CLEARED: { label: 'Cleared', tone: 'info' },
  DELIVERED: { label: 'Delivered', tone: 'success' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};

export const DOCUMENT_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  DRAFT_PENDING: { label: 'Draft Pending', tone: 'neutral' },
  DRAFT_RECEIVED: { label: 'Draft Received', tone: 'info' },
  UNDER_APPROVAL: { label: 'Under Approval', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'info' },
  ORIGINALS_WITH_SUPPLIER: { label: 'Originals with Supplier', tone: 'progress' },
  DISPATCHED: { label: 'Dispatched', tone: 'progress' },
  WITH_BANK: { label: 'With Bank', tone: 'progress' },
  WITH_CUSTOMER: { label: 'With Customer', tone: 'info' },
  COMPLETED: { label: 'Completed', tone: 'success' },
};

export const TRANSACTION_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  POSTED: { label: 'Posted', tone: 'success' },
  REVERSED: { label: 'Reversed', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

export const SETTLEMENT_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  UNPAID: { label: 'Unpaid', tone: 'danger' },
  PARTIAL: { label: 'Partially Paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
};

export const CHEQUE_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  RECEIVED: { label: 'Received', tone: 'info' },
  DEPOSITED: { label: 'Deposited', tone: 'progress' },
  CLEARED: { label: 'Cleared', tone: 'success' },
  BOUNCED: { label: 'Bounced', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export const COFFEE_TYPE_LABELS: Record<string, string> = {
  ARABICA: 'Arabica',
  ROBUSTA: 'Robusta',
  BLEND: 'Blend',
};

export const COFFEE_PROCESS_LABELS: Record<string, string> = {
  WASHED: 'Washed',
  NATURAL: 'Natural',
  HONEY: 'Honey',
  WET_HULLED: 'Wet Hulled',
  ANAEROBIC: 'Anaerobic',
  OTHER: 'Other',
};

export const PACKAGING_LABELS: Record<string, string> = {
  JUTE_BAG: 'Jute Bag',
  GRAINPRO: 'GrainPro',
  VACUUM_PACK: 'Vacuum Pack',
  BULK: 'Bulk',
  OTHER: 'Other',
};

export const CONTAINER_TYPE_LABELS: Record<string, string> = {
  FT20: "20' Dry",
  FT40: "40' Dry",
  FT40HC: "40' High Cube",
  LCL: 'LCL',
  BULK: 'Break Bulk',
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank Transfer',
  CHEQUE: 'Cheque',
};

export const INCOTERM_LABELS: Record<string, string> = {
  EXW: 'EXW — Ex Works',
  FCA: 'FCA — Free Carrier',
  FOB: 'FOB — Free on Board',
  CFR: 'CFR — Cost and Freight',
  CIF: 'CIF — Cost, Insurance and Freight',
  DAP: 'DAP — Delivered at Place',
  DDP: 'DDP — Delivered Duty Paid',
};

/**
 * Allowed shipment status transitions. Anything not listed is rejected by
 * ShipmentService. One step backwards is permitted so a mis-click can be
 * corrected without opening the whole workflow.
 */
export const SHIPMENT_STATUS_TRANSITIONS: Record<string, string[]> = {
  CONTRACT_CREATED: ['AWAITING_LOADING'],
  AWAITING_LOADING: ['LOADED', 'CONTRACT_CREATED'],
  LOADED: ['IN_TRANSIT', 'AWAITING_LOADING'],
  IN_TRANSIT: ['ARRIVED', 'LOADED'],
  ARRIVED: ['CUSTOMS_CLEARING', 'IN_TRANSIT'],
  CUSTOMS_CLEARING: ['CLEARED', 'ARRIVED'],
  CLEARED: ['DELIVERED', 'CUSTOMS_CLEARING'],
  DELIVERED: ['CLOSED', 'CLEARED'],
  CLOSED: ['DELIVERED'],
};

/**
 * Data a shipment must carry before it may enter a status. "Loaded" without a
 * booking, a vessel and an ETA is not a loaded shipment.
 */
export const SHIPMENT_STATUS_REQUIREMENTS: Record<string, Array<{ field: string; label: string }>> = {
  LOADED: [
    { field: 'loadingDate', label: 'Loading Date' },
    { field: 'bookingNumber', label: 'Booking Number' },
    { field: 'shippingLineId', label: 'Shipping Line' },
    { field: 'vesselName', label: 'Vessel Name' },
    { field: 'portOfLoading', label: 'Port of Loading' },
    { field: 'portOfDischarge', label: 'Port of Discharge' },
    { field: 'etdDate', label: 'ETD' },
    { field: 'etaDate', label: 'ETA' },
  ],
  IN_TRANSIT: [
    { field: 'billOfLading', label: 'Bill of Lading' },
    { field: 'etaDate', label: 'ETA' },
  ],
  ARRIVED: [{ field: 'ataDate', label: 'Actual Arrival Date' }],
  CLEARED: [{ field: 'clearanceDate', label: 'Clearance Date' }],
  DELIVERED: [{ field: 'deliveryDate', label: 'Delivery Date' }],
};

/** Statuses at which the cargo is physically in the destination warehouse. */
export const SHIPMENT_STATUSES_LANDED = ['ARRIVED', 'CUSTOMS_CLEARING', 'CLEARED', 'DELIVERED', 'CLOSED'];

/** Statuses at which the cargo is still on the water or at origin. */
export const SHIPMENT_STATUSES_IN_TRANSIT = ['CONTRACT_CREATED', 'AWAITING_LOADING', 'LOADED', 'IN_TRANSIT'];

/**
 * Standard expense categories.
 *
 * `capitalise` marks a direct shipment cost that belongs in the landed cost of
 * the coffee rather than in period expenses. Getting this wrong distorts both
 * inventory valuation and gross margin, so the defaults are deliberate.
 */
/**
 * The expense catalogue.
 *
 * `kind` says which job the money was spent on; `capitalise` says how the
 * ledger treats it. They are not the same question, and conflating them is
 * how a broker's commission ends up either invisible on the shipment or
 * wrongly inside the cost of the coffee.
 *
 * Seeds only. An administrator can add, rename and deactivate categories, so
 * nothing here is permanent.
 */
export const EXPENSE_CATEGORY_SEEDS: Array<{
  code: string;
  name: string;
  kind: 'SHIPMENT' | 'GENERAL';
  capitalise: boolean;
}> = [
  // --- Direct shipment costs: these become the landed cost of the coffee ---
  { code: 'FREIGHT', name: 'Ocean Freight', kind: 'SHIPMENT', capitalise: true },
  { code: 'INSURANCE', name: 'Marine Insurance', kind: 'SHIPMENT', capitalise: true },
  { code: 'CUSTOMS', name: 'Customs Duty', kind: 'SHIPMENT', capitalise: true },
  { code: 'CLEARING', name: 'Clearing Charges', kind: 'SHIPMENT', capitalise: true },
  { code: 'PORT', name: 'Port Charges', kind: 'SHIPMENT', capitalise: true },
  { code: 'TRANSPORT', name: 'Inland Transport', kind: 'SHIPMENT', capitalise: true },
  { code: 'DOCUMENTATION', name: 'Documentation', kind: 'SHIPMENT', capitalise: true },
  { code: 'HANDLING', name: 'Handling', kind: 'SHIPMENT', capitalise: true },
  { code: 'LABOUR', name: 'Labour', kind: 'SHIPMENT', capitalise: true },
  { code: 'LOADING', name: 'Loading / Stuffing', kind: 'SHIPMENT', capitalise: true },
  { code: 'INSPECTION', name: 'Quality Inspection', kind: 'SHIPMENT', capitalise: true },
  { code: 'SHPSTORAGE', name: 'Shipment Storage', kind: 'SHIPMENT', capitalise: true },
  { code: 'FUEL', name: 'Fuel', kind: 'SHIPMENT', capitalise: true },
  // A broker who is paid to place one consignment is a cost of landing it.
  { code: 'BROKER', name: 'Broker Commission', kind: 'SHIPMENT', capitalise: true },
  { code: 'COMMISSION', name: 'Agent Commission', kind: 'SHIPMENT', capitalise: true },
  /// Recoverable tax is not a cost, so this covers the irrecoverable duty and
  /// levies a shipment genuinely bears. Reclaimable VAT goes to the tax
  /// account through the expense's own tax code, never through here.
  { code: 'SHPTAX', name: 'Shipment Tax / Levies', kind: 'SHIPMENT', capitalise: true },
  // Shipment-linked for reporting, but not a cost of getting the coffee in:
  // it belongs to the profit and loss the period it was incurred.
  { code: 'SHPBANK', name: 'Shipment Bank Charges', kind: 'SHIPMENT', capitalise: false },
  { code: 'OTHERSHP', name: 'Other Direct Shipment Cost', kind: 'SHIPMENT', capitalise: true },

  // --- Running the company: never touches a shipment's cost ---------------
  { code: 'MEALS', name: 'Food / Meals', kind: 'GENERAL', capitalise: false },
  { code: 'ENTERTAIN', name: 'Entertainment', kind: 'GENERAL', capitalise: false },
  { code: 'RENT', name: 'Office Rent', kind: 'GENERAL', capitalise: false },
  { code: 'UTILITIES', name: 'Utilities', kind: 'GENERAL', capitalise: false },
  { code: 'SALARY', name: 'Salary / Wages', kind: 'GENERAL', capitalise: false },
  { code: 'SUPPLIES', name: 'Office Supplies', kind: 'GENERAL', capitalise: false },
  { code: 'TRAVEL', name: 'Travel', kind: 'GENERAL', capitalise: false },
  { code: 'TELECOM', name: 'Telephone / Internet', kind: 'GENERAL', capitalise: false },
  { code: 'PROFFEE', name: 'Professional Fees', kind: 'GENERAL', capitalise: false },
  { code: 'BANK', name: 'General Bank Charges', kind: 'GENERAL', capitalise: false },
  { code: 'REPAIRS', name: 'Repairs & Maintenance', kind: 'GENERAL', capitalise: false },
  { code: 'GENTRANS', name: 'General Transport', kind: 'GENERAL', capitalise: false },
  { code: 'WAREHOUSE', name: 'Warehouse Rent', kind: 'GENERAL', capitalise: false },
  { code: 'MISC', name: 'Other Administrative Expense', kind: 'GENERAL', capitalise: false },
];

/** System account keys referenced by the posting engine. */
export const ACCOUNT_KEYS = {
  ACCOUNTS_RECEIVABLE: 'ACCOUNTS_RECEIVABLE',
  ACCOUNTS_PAYABLE: 'ACCOUNTS_PAYABLE',
  INVENTORY: 'INVENTORY',
  INVENTORY_IN_TRANSIT: 'INVENTORY_IN_TRANSIT',
  CHEQUES_ON_HAND: 'CHEQUES_ON_HAND',
  CHEQUES_ISSUED: 'CHEQUES_ISSUED',
  SALES_REVENUE: 'SALES_REVENUE',
  COST_OF_GOODS_SOLD: 'COST_OF_GOODS_SOLD',
  FREIGHT_COST: 'FREIGHT_COST',
  OPENING_BALANCE_EQUITY: 'OPENING_BALANCE_EQUITY',
  RETAINED_EARNINGS: 'RETAINED_EARNINGS',
  FX_GAIN_LOSS: 'FX_GAIN_LOSS',
  EXPENSE_DEFAULT: 'EXPENSE_DEFAULT',
  INVENTORY_ADJUSTMENT: 'INVENTORY_ADJUSTMENT',
  /// Money received before there is an invoice to put it against.
  CUSTOMER_ADVANCES: 'CUSTOMER_ADVANCES',
  /// Money paid to a supplier before their bill arrives.
  SUPPLIER_ADVANCES: 'SUPPLIER_ADVANCES',
  /// Contra-revenue, so credits are visible rather than netted into sales.
  SALES_RETURNS: 'SALES_RETURNS',
  /// Contra-cost for supplier credits that do not relate to stock.
  PURCHASE_RETURNS: 'PURCHASE_RETURNS',
  /// Tax charged to customers and owed to the authority.
  VAT_OUTPUT: 'VAT_OUTPUT',
  /// Tax paid to suppliers and reclaimable from the authority.
  VAT_INPUT: 'VAT_INPUT',
} as const;

export type AccountKey = (typeof ACCOUNT_KEYS)[keyof typeof ACCOUNT_KEYS];

/** Report grouping used by the Profit & Loss and Balance Sheet. */
export const REPORT_GROUPS = {
  CURRENT_ASSET: 'CURRENT_ASSET',
  NON_CURRENT_ASSET: 'NON_CURRENT_ASSET',
  CURRENT_LIABILITY: 'CURRENT_LIABILITY',
  NON_CURRENT_LIABILITY: 'NON_CURRENT_LIABILITY',
  EQUITY: 'EQUITY',
  REVENUE: 'REVENUE',
  COGS: 'COGS',
  OPERATING: 'OPERATING',
  OTHER_INCOME: 'OTHER_INCOME',
  OTHER_EXPENSE: 'OTHER_EXPENSE',
} as const;

/** Default ETA alert offsets, in days before arrival. */
export const DEFAULT_ETA_ALERT_DAYS = [7, 3, 0];

export const SETTING_KEYS = {
  ALLOW_NEGATIVE_STOCK: 'inventory.allowNegativeStock',
  ETA_ALERT_DAYS: 'alerts.etaDays',
  DEFAULT_PAYMENT_TERM_DAYS: 'sales.defaultPaymentTermDays',
  LANDED_COST_BASIS: 'costing.landedCostBasis',
  /** ISO date. Nothing may post on or before this date. Empty means open. */
  PERIOD_CLOSED_UNTIL: 'accounting.periodClosedUntil',
} as const;

/**
 * Standard tax codes, seeded the moment a company is registered for tax.
 *
 * A zero-rated export and an exempt supply both charge nothing, but they are
 * reported on different lines of the return and treated differently for input
 * recovery, so they are separate codes rather than one "0%".
 */
export const TAX_CODE_SEEDS: Array<{
  code: string;
  name: string;
  ratePct: number;
  treatment: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT' | 'OUT_OF_SCOPE' | 'REVERSE_CHARGE';
  appliesTo: 'SALES' | 'PURCHASE' | 'BOTH';
  isDefault?: boolean;
}> = [
  { code: 'STD', name: 'Standard rate', ratePct: 0, treatment: 'STANDARD', appliesTo: 'BOTH', isDefault: true },
  { code: 'ZERO', name: 'Zero-rated export', ratePct: 0, treatment: 'ZERO_RATED', appliesTo: 'SALES' },
  { code: 'EXEMPT', name: 'Exempt supply', ratePct: 0, treatment: 'EXEMPT', appliesTo: 'BOTH' },
  { code: 'OOS', name: 'Out of scope', ratePct: 0, treatment: 'OUT_OF_SCOPE', appliesTo: 'BOTH' },
  { code: 'RC', name: 'Reverse charge (import)', ratePct: 0, treatment: 'REVERSE_CHARGE', appliesTo: 'PURCHASE' },
];

/**
 * Statutory standard rate and local name, by country of registration.
 *
 * Matched on substrings of the company's country because that field holds a
 * name ("United Arab Emirates") rather than an ISO code, and a company created
 * by hand may say "UAE" or "Maroc" instead.
 */
export const TAX_REGIMES: Array<{
  match: string[];
  label: string;
  standardRatePct: number;
  periodMonths: number;
}> = [
  { match: ['emirat', 'uae', 'dubai', 'ae'], label: 'VAT', standardRatePct: 5, periodMonths: 3 },
  { match: ['morocco', 'maroc', 'ma'], label: 'TVA', standardRatePct: 20, periodMonths: 1 },
];

/** Somewhere we hold no statutory knowledge about: the rate has to be entered. */
export const DEFAULT_TAX_REGIME = { label: 'VAT', standardRatePct: 0, periodMonths: 3 };

export const DOC_TYPES = {
  PURCHASE_CONTRACT: 'PO',
  PURCHASE_BILL: 'PB',
  SHIPMENT: 'SHP',
  JOB: 'JOB',
  SALES_INVOICE: 'SI',
  RECEIPT: 'RV',
  PAYMENT: 'PV',
  EXPENSE: 'EV',
  JOURNAL: 'JV',
  BATCH: 'BAT',
  LOT: 'LOT',
  CREDIT_NOTE: 'CN',
  DEBIT_NOTE: 'DN',
  STOCK_COUNT: 'SC',
} as const;

export const DOC_TYPE_LABELS: Record<string, string> = {
  PO: 'Purchase Contract',
  PB: 'Purchase Bill',
  SHP: 'Shipment',
  JOB: 'Job',
  SI: 'Sales Invoice',
  RV: 'Receipt Voucher',
  PV: 'Payment Voucher',
  EV: 'Expense Voucher',
  JV: 'Journal Voucher',
  BAT: 'Batch',
  LOT: 'Lot',
  CN: 'Credit Note',
  DN: 'Debit Note',
};


/**
 * Ports a coffee trader routinely touches, seeded so the picker is useful on
 * day one. Not exhaustive and not permanent — an administrator adds their own.
 */
export const PORT_SEEDS: Record<string, Array<{ code: string; name: string; country: string }>> = {
  AE: [
    { code: 'AEJEA', name: 'Jebel Ali', country: 'United Arab Emirates' },
    { code: 'AEDXB', name: 'Port Rashid, Dubai', country: 'United Arab Emirates' },
    { code: 'AEKLF', name: 'Khalifa Port, Abu Dhabi', country: 'United Arab Emirates' },
    { code: 'AESHJ', name: 'Sharjah', country: 'United Arab Emirates' },
  ],
  MA: [
    { code: 'MACAS', name: 'Casablanca', country: 'Morocco' },
    { code: 'MAPTM', name: 'Tanger Med', country: 'Morocco' },
    { code: 'MAAGA', name: 'Agadir', country: 'Morocco' },
  ],
  /** Loading ports, shared by both companies: this is where coffee comes from. */
  ORIGIN: [
    { code: 'BRSSZ', name: 'Santos', country: 'Brazil' },
    { code: 'BRPNG', name: 'Paranaguá', country: 'Brazil' },
    { code: 'COCTG', name: 'Cartagena', country: 'Colombia' },
    { code: 'COBUN', name: 'Buenaventura', country: 'Colombia' },
    { code: 'DJJIB', name: 'Djibouti', country: 'Djibouti' },
    { code: 'ETADD', name: 'Addis Ababa (dry port)', country: 'Ethiopia' },
    { code: 'KEMBA', name: 'Mombasa', country: 'Kenya' },
    { code: 'TZDAR', name: 'Dar es Salaam', country: 'Tanzania' },
    { code: 'VNSGN', name: 'Ho Chi Minh City', country: 'Vietnam' },
    { code: 'IDPNK', name: 'Panjang', country: 'Indonesia' },
    { code: 'HNPCR', name: 'Puerto Cortés', country: 'Honduras' },
    { code: 'UGKLA', name: 'Kampala (inland)', country: 'Uganda' },
  ],
};
