import {
  Anchor,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  BarChart3,
  BookOpen,
  BookPlus,
  Boxes,
  Building2,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardList,
  Coffee,
  Compass,
  DatabaseBackup,
  Factory,
  FileCheck,
  FileMinus,
  FileText,
  HandCoins,
  History,
  Layers,
  LayoutDashboard,
  LineChart,
  PackageCheck,
  Percent,
  Receipt,
  Settings,
  ShieldCheck,
  Ship,
  ShoppingCart,
  Tags,
  Truck,
  UserCog,
  Users,
  Wallet,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** The user needs at least one of these to see the item. */
  permissions: PermissionCode[];
};

export type NavGroup = {
  label: string;
  /** Shown on the collapsed rail, where there is no room for the words. */
  icon: LucideIcon;
  items: NavItem[];
};

/**
 * The sidebar.
 *
 * Eight sections and fifty-two entries was a list of everything the
 * application can do, which is not the same as a list of what anyone does.
 * What is here now is the work: buy, ship, receive, sell, get paid. Master
 * records sit together in one section because they are set up once and edited
 * rarely, and every report lives behind All Reports, which is a real index with
 * descriptions rather than thirty more lines in the rail.
 *
 * Nothing was deleted — everything remains at its own address and reachable
 * from the index or the screen it belongs to. Only the rail got shorter.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    icon: LayoutDashboard,
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, permissions: [PERMISSIONS.DASHBOARD_VIEW] },
      { label: 'Getting Started', href: '/getting-started', icon: Compass, permissions: [PERMISSIONS.DASHBOARD_VIEW] },
    ],
  },
  {
    // The order of the job: buy it, watch it ship, receive it, sell it.
    label: 'Trading',
    icon: Ship,
    items: [
      { label: 'Items', href: '/items', icon: Coffee, permissions: [PERMISSIONS.ITEMS_VIEW] },
      { label: 'Purchase Orders', href: '/purchases', icon: FileText, permissions: [PERMISSIONS.PURCHASES_VIEW] },
      { label: 'Loading Sheet', href: '/loading', icon: ClipboardList, permissions: [PERMISSIONS.SHIPMENTS_VIEW] },
      { label: 'Purchase Receipts', href: '/goods-receipts', icon: PackageCheck, permissions: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Sales Invoices', href: '/sales', icon: ShoppingCart, permissions: [PERMISSIONS.SALES_VIEW] },
      { label: 'Shipments', href: '/shipments', icon: Ship, permissions: [PERMISSIONS.SHIPMENTS_VIEW] },
      { label: 'Credit Notes', href: '/sales/credit-notes', icon: FileMinus, permissions: [PERMISSIONS.CREDIT_NOTES_VIEW] },
    ],
  },
  {
    label: 'Inventory',
    icon: Boxes,
    items: [
      { label: 'Stock on Hand', href: '/inventory', icon: Boxes, permissions: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Batches', href: '/inventory/batches', icon: Layers, permissions: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Warehouse Transfers', href: '/inventory/transfers', icon: ArrowLeftRight, permissions: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Stock Movements', href: '/inventory/movements', icon: History, permissions: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Stock Counts', href: '/inventory/stock-counts', icon: ClipboardCheck, permissions: [PERMISSIONS.STOCK_COUNT_VIEW] },
    ],
  },
  {
    label: 'Money',
    icon: Wallet,
    items: [
      { label: 'Payments Received', href: '/finance/receipts', icon: ArrowDownToLine, permissions: [PERMISSIONS.RECEIPTS_VIEW] },
      { label: 'Payments Made', href: '/finance/payments', icon: ArrowUpFromLine, permissions: [PERMISSIONS.PAYMENTS_VIEW] },
      { label: 'Expenses', href: '/finance/expenses', icon: Receipt, permissions: [PERMISSIONS.EXPENSES_VIEW] },
      { label: 'Agent Commission', href: '/finance/agent-commission', icon: HandCoins, permissions: [PERMISSIONS.EXPENSES_VIEW] },
      { label: 'Cheques', href: '/finance/cheques', icon: FileCheck, permissions: [PERMISSIONS.CHEQUES_VIEW] },
      { label: 'Cash & Bank Accounts', href: '/finance/cash-bank', icon: Wallet, permissions: [PERMISSIONS.CASHBANK_VIEW] },
      { label: 'Receivables', href: '/finance/receivables', icon: CircleDollarSign, permissions: [PERMISSIONS.RECEIVABLES_VIEW] },
      { label: 'Payables', href: '/finance/payables', icon: HandCoins, permissions: [PERMISSIONS.PAYABLES_VIEW] },
    ],
  },
  {
    label: 'Accounting',
    icon: BookOpen,
    items: [
      { label: 'Chart of Accounts', href: '/accounting/chart', icon: BookOpen, permissions: [PERMISSIONS.ACCOUNTING_VIEW] },
      { label: 'Journal Entries', href: '/reports/journal', icon: LineChart, permissions: [PERMISSIONS.ACCOUNTING_VIEW] },
      { label: 'General Ledger', href: '/reports/general-ledger', icon: BookOpen, permissions: [PERMISSIONS.ACCOUNTING_VIEW] },
      { label: 'Customer Ledgers', href: '/ledgers/customers', icon: Users, permissions: [PERMISSIONS.LEDGERS_VIEW] },
      { label: 'Supplier Ledgers', href: '/ledgers/vendors', icon: Factory, permissions: [PERMISSIONS.LEDGERS_VIEW] },
      { label: 'Agent Ledgers', href: '/ledgers/agents', icon: HandCoins, permissions: [PERMISSIONS.LEDGERS_VIEW] },
    ],
  },
  {
    // One entry, because /reports is a real index with a description against
    // every report — a better place to choose one than a list of bare names.
    label: 'Reports',
    icon: BarChart3,
    items: [
      { label: 'All Reports', href: '/reports', icon: BarChart3, permissions: [PERMISSIONS.REPORTS_VIEW] },
    ],
  },
  {
    // Set up once, edited rarely. Together, and out of the way.
    label: 'Master Data',
    icon: Users,
    items: [
      { label: 'Customers', href: '/customers', icon: Users, permissions: [PERMISSIONS.CUSTOMERS_VIEW] },
      { label: 'Suppliers', href: '/vendors', icon: Factory, permissions: [PERMISSIONS.VENDORS_VIEW] },
      { label: 'Agents', href: '/agents', icon: UserCog, permissions: [PERMISSIONS.AGENTS_VIEW] },
      { label: 'Warehouses', href: '/warehouses', icon: Warehouse, permissions: [PERMISSIONS.WAREHOUSES_VIEW] },
      { label: 'Expense Categories', href: '/expense-categories', icon: Tags, permissions: [PERMISSIONS.EXPENSE_CATEGORIES_VIEW] },
      { label: 'Shipping Lines', href: '/shipping-lines', icon: Ship, permissions: [PERMISSIONS.SHIPPING_LINES_VIEW] },
      { label: 'Ports', href: '/ports', icon: Anchor, permissions: [PERMISSIONS.PORTS_VIEW] },
    ],
  },
  {
    label: 'Administration',
    icon: Settings,
    items: [
      { label: 'Users', href: '/admin/users', icon: UserCog, permissions: [PERMISSIONS.USERS_MANAGE] },
      { label: 'Roles & Permissions', href: '/admin/roles', icon: ShieldCheck, permissions: [PERMISSIONS.ROLES_MANAGE] },
      { label: 'Companies', href: '/admin/companies', icon: Building2, permissions: [PERMISSIONS.COMPANIES_MANAGE] },
      { label: 'Audit Log', href: '/admin/audit', icon: History, permissions: [PERMISSIONS.AUDIT_VIEW] },
      { label: 'Backups', href: '/admin/backups', icon: DatabaseBackup, permissions: [PERMISSIONS.BACKUP_MANAGE] },
      { label: 'Tax Settings', href: '/settings/tax', icon: Percent, permissions: [PERMISSIONS.SETTINGS_MANAGE] },
      { label: 'Settings', href: '/settings', icon: Settings, permissions: [PERMISSIONS.SETTINGS_MANAGE] },
    ],
  },
];

/**
 * The "+ New" menu.
 *
 * Everything a person creates from scratch, in the order the business does it,
 * reachable from any screen. Entries the user cannot action are filtered out —
 * the routes themselves check the same permission server-side.
 */
export type QuickCreateItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  group: 'Trade' | 'Money' | 'Records';
  hint: string;
  permission: PermissionCode;
};

export const QUICK_CREATE: QuickCreateItem[] = [
  { label: 'Purchase contract', href: '/purchases/new', icon: FileText, group: 'Trade', hint: 'Coffee you have agreed to buy', permission: PERMISSIONS.PURCHASES_CREATE },
  { label: 'Sales invoice', href: '/sales/new', icon: ShoppingCart, group: 'Trade', hint: 'Sell stock to a customer', permission: PERMISSIONS.SALES_CREATE },
  { label: 'Warehouse transfer', href: '/inventory/transfers/new', icon: ArrowLeftRight, group: 'Trade', hint: 'Move stock between warehouses', permission: PERMISSIONS.INVENTORY_TRANSFER },

  { label: 'Receipt', href: '/finance/receipts/new', icon: ArrowDownToLine, group: 'Money', hint: 'Money received from a customer', permission: PERMISSIONS.RECEIPTS_CREATE },
  { label: 'Payment', href: '/finance/payments/new', icon: ArrowUpFromLine, group: 'Money', hint: 'Money paid to a supplier', permission: PERMISSIONS.PAYMENTS_CREATE },
  { label: 'Expense', href: '/finance/expenses/new', icon: Receipt, group: 'Money', hint: 'Freight, clearing, bank charges', permission: PERMISSIONS.EXPENSES_CREATE },

  { label: 'Customer', href: '/customers?new=1', icon: Users, group: 'Records', hint: 'Someone you sell to', permission: PERMISSIONS.CUSTOMERS_CREATE },
  { label: 'Supplier', href: '/vendors?new=1', icon: Truck, group: 'Records', hint: 'Someone you buy from', permission: PERMISSIONS.VENDORS_CREATE },
  { label: 'Item', href: '/items?new=1', icon: Coffee, group: 'Records', hint: 'Coffee name, unit, origin, screen', permission: PERMISSIONS.ITEMS_CREATE },
  { label: 'Journal voucher', href: '/accounting/journal/new', icon: BookPlus, group: 'Money', hint: 'A direct double-entry posting', permission: PERMISSIONS.ACCOUNTING_POST },
  { label: 'Credit note', href: '/sales/credit-notes/new', icon: FileMinus, group: 'Money', hint: 'Reduce what a customer owes', permission: PERMISSIONS.CREDIT_NOTES_CREATE },
  { label: 'Stock count', href: '/inventory/stock-counts/new', icon: ClipboardCheck, group: 'Trade', hint: 'Verify a warehouse against the books', permission: PERMISSIONS.STOCK_COUNT_MANAGE },
];

export function filterQuickCreate(permissions: string[], isSuperAdmin: boolean): QuickCreateItem[] {
  const granted = new Set(permissions);
  return QUICK_CREATE.filter((item) => isSuperAdmin || granted.has(item.permission));
}

/** Flattened navigation, used by the command palette. */
export function navDestinations(permissions: string[], isSuperAdmin: boolean): Array<NavItem & { group: string }> {
  return filterNav(NAV_GROUPS, permissions, isSuperAdmin).flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.label })),
  );
}

/** The five destinations that matter most on a phone. */
export const MOBILE_PRIMARY: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, permissions: [PERMISSIONS.DASHBOARD_VIEW] },
  { label: 'Shipments', href: '/shipments', icon: Ship, permissions: [PERMISSIONS.SHIPMENTS_VIEW] },
  { label: 'Stock', href: '/inventory', icon: Boxes, permissions: [PERMISSIONS.INVENTORY_VIEW] },
  { label: 'Payments Received', href: '/finance/receipts', icon: ArrowDownToLine, permissions: [PERMISSIONS.RECEIPTS_VIEW] },
];

export function filterNav(groups: NavGroup[], permissions: string[], isSuperAdmin: boolean): NavGroup[] {
  const granted = new Set(permissions);
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => isSuperAdmin || item.permissions.some((p) => granted.has(p))),
    }))
    .filter((group) => group.items.length > 0);
}
