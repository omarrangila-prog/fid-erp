/**
 * The permission grid: every permission code is `<page>.<action>`, laid out as
 * one row per page and a column per action, in the order of the sidebar.
 * View / Create / Edit / Delete are columns of their own; anything else a page
 * allows (post, approve, reverse, manage…) is listed beside them.
 */

export const GRID_ACTIONS = ['view', 'create', 'edit', 'delete'] as const;

export const GRID_PAGES: Array<{ key: string; label: string; section: string }> = [
  { key: 'dashboard', label: 'Dashboard', section: 'Overview' },
  { key: 'sales', label: 'Sales invoices', section: 'Sales' },
  { key: 'customers', label: 'Customers', section: 'Sales' },
  { key: 'receipts', label: 'Receive payment / collections', section: 'Sales' },
  { key: 'creditnotes', label: 'Credit notes', section: 'Sales' },
  { key: 'receivables', label: 'Receivables', section: 'Sales' },
  { key: 'purchases', label: 'Purchase orders', section: 'Purchases' },
  { key: 'vendors', label: 'Suppliers', section: 'Purchases' },
  { key: 'payments', label: 'Payments made', section: 'Purchases' },
  { key: 'payables', label: 'Payables', section: 'Purchases' },
  { key: 'shipments', label: 'Shipments', section: 'Shipments' },
  { key: 'containers', label: 'Containers', section: 'Shipments' },
  { key: 'expenses', label: 'Expenses', section: 'Shipments' },
  { key: 'expensecategories', label: 'Expense categories', section: 'Shipments' },
  { key: 'inventory', label: 'Inventory / warehouse stock', section: 'Inventory' },
  { key: 'stockcount', label: 'Stock counts', section: 'Inventory' },
  { key: 'items', label: 'Coffee items', section: 'Inventory' },
  { key: 'warehouses', label: 'Warehouses', section: 'Inventory' },
  { key: 'cashbank', label: 'Cash & bank', section: 'Cash & Bank' },
  { key: 'cheques', label: 'Cheques', section: 'Cash & Bank' },
  { key: 'bank', label: 'Bank reconciliation', section: 'Cash & Bank' },
  { key: 'agents', label: 'Agents & agent ledger', section: 'Agents' },
  { key: 'ledgers', label: 'Ledgers', section: 'Accounting' },
  { key: 'accounting', label: 'Accounting & Journal Entry (JV)', section: 'Accounting' },
  { key: 'reports', label: 'Reports', section: 'Reports' },
  { key: 'profits', label: 'Profit & margins', section: 'Reports' },
  { key: 'attachments', label: 'Attachments', section: 'Other' },
  { key: 'shippinglines', label: 'Shipping lines', section: 'Master data' },
  { key: 'ports', label: 'Ports', section: 'Master data' },
  { key: 'users', label: 'Users', section: 'Administration' },
  { key: 'roles', label: 'Roles & permissions', section: 'Administration' },
  { key: 'companies', label: 'Companies', section: 'Administration' },
  { key: 'settings', label: 'Settings', section: 'Administration' },
  { key: 'audit', label: 'Audit log', section: 'Administration' },
  { key: 'backup', label: 'Backups', section: 'Administration' },
];

/** Words for the actions that are not one of the four columns. */
export const OTHER_ACTION_LABEL: Record<string, string> = {
  post: 'Post',
  approve: 'Approve',
  reverse: 'Reverse',
  manage: 'Manage',
  update: 'Update',
  adjust: 'Adjust',
  transfer: 'Transfer',
  export: 'Export',
  reconcile: 'Reconcile',
};
