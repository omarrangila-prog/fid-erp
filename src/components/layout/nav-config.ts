import {
  LayoutDashboard,
  FileText,
  Ship,
  ShoppingCart,
  Boxes,
  Layers,
  History,
  Package,
  ArrowDownToLine,
  ArrowUpFromLine,
  Receipt,
  Landmark,
  BookOpen,
  BookText,
  CircleDollarSign,
  HandCoins,
  Users,
  Truck,
  Coffee,
  Warehouse,
  Handshake,
  PackageCheck,
  ArrowLeftRight,
  Building2,
  UserCog,
  ShieldCheck,
  ScrollText,
  Settings,
  BarChart3,
  ClipboardList,
  TrendingUp,
  Compass,
  BookPlus,
  LineChart,
  RefreshCcw,
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
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, permissions: [PERMISSIONS.DASHBOARD_VIEW] },
      { label: 'Getting Started', href: '/getting-started', icon: Compass, permissions: [PERMISSIONS.DASHBOARD_VIEW] },
    ],
  },
  {
    label: 'Trading',
    items: [
      { label: 'Purchase Contracts', href: '/purchases', icon: FileText, permissions: [PERMISSIONS.PURCHASES_VIEW] },
      { label: 'Sales', href: '/sales', icon: ShoppingCart, permissions: [PERMISSIONS.SALES_VIEW] },
      { label: 'Goods Receipts', href: '/goods-receipts', icon: PackageCheck, permissions: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Shipments', href: '/shipments', icon: Ship, permissions: [PERMISSIONS.SHIPMENTS_VIEW] },
      { label: 'Loading Sheet', href: '/loading', icon: ClipboardList, permissions: [PERMISSIONS.SHIPMENTS_VIEW] },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Current Stock', href: '/inventory', icon: Boxes, permissions: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Shipment Stock', href: '/inventory/shipments', icon: Package, permissions: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Batch / Lot Stock', href: '/inventory/batches', icon: Layers, permissions: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Warehouse Transfers', href: '/inventory/transfers', icon: ArrowLeftRight, permissions: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Stock Movements', href: '/inventory/movements', icon: History, permissions: [PERMISSIONS.INVENTORY_VIEW] },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Receipts', href: '/finance/receipts', icon: ArrowDownToLine, permissions: [PERMISSIONS.RECEIPTS_VIEW] },
      { label: 'Payments', href: '/finance/payments', icon: ArrowUpFromLine, permissions: [PERMISSIONS.PAYMENTS_VIEW] },
      { label: 'Expenses', href: '/finance/expenses', icon: Receipt, permissions: [PERMISSIONS.EXPENSES_VIEW] },
      { label: 'Cheques', href: '/finance/cheques', icon: ScrollText, permissions: [PERMISSIONS.CHEQUES_VIEW] },
      { label: 'Cash & Bank', href: '/finance/cash-bank', icon: Landmark, permissions: [PERMISSIONS.CASHBANK_VIEW] },
      { label: 'Receivables', href: '/finance/receivables', icon: CircleDollarSign, permissions: [PERMISSIONS.RECEIVABLES_VIEW] },
      { label: 'Payables', href: '/finance/payables', icon: HandCoins, permissions: [PERMISSIONS.PAYABLES_VIEW] },
      { label: 'Customer Ledgers', href: '/ledgers/customers', icon: BookOpen, permissions: [PERMISSIONS.LEDGERS_VIEW] },
      { label: 'Vendor Ledgers', href: '/ledgers/vendors', icon: BookText, permissions: [PERMISSIONS.LEDGERS_VIEW] },
    ],
  },
  {
    label: 'Masters',
    items: [
      { label: 'Customers', href: '/customers', icon: Users, permissions: [PERMISSIONS.CUSTOMERS_VIEW] },
      { label: 'Vendors', href: '/vendors', icon: Truck, permissions: [PERMISSIONS.VENDORS_VIEW] },
      { label: 'Coffee Items', href: '/items', icon: Coffee, permissions: [PERMISSIONS.ITEMS_VIEW] },
      { label: 'Warehouses', href: '/warehouses', icon: Warehouse, permissions: [PERMISSIONS.WAREHOUSES_VIEW] },
      { label: 'Agents', href: '/agents', icon: Handshake, permissions: [PERMISSIONS.AGENTS_VIEW] },
      { label: 'Shipping Lines', href: '/shipping-lines', icon: Ship, permissions: [PERMISSIONS.SHIPPING_LINES_VIEW] },
      { label: 'Expense Categories', href: '/expense-categories', icon: Receipt, permissions: [PERMISSIONS.EXPENSE_CATEGORIES_VIEW] },
    ],
  },
  {
    label: 'Accounting',
    items: [
      { label: 'Journal Voucher', href: '/accounting/journal/new', icon: BookPlus, permissions: [PERMISSIONS.ACCOUNTING_POST] },
      { label: 'Journal', href: '/reports/journal', icon: LineChart, permissions: [PERMISSIONS.ACCOUNTING_VIEW] },
      { label: 'Currency Revaluation', href: '/accounting/revaluation', icon: RefreshCcw, permissions: [PERMISSIONS.ACCOUNTING_POST] },
      { label: 'Reconciliation', href: '/reports/reconciliation', icon: ShieldCheck, permissions: [PERMISSIONS.ACCOUNTING_VIEW] },
    ],
  },
  {
    label: 'Insight',
    items: [
      { label: 'Profitability', href: '/profitability', icon: TrendingUp, permissions: [PERMISSIONS.PROFITS_VIEW] },
      { label: 'Business Overview', href: '/reports/business-overview', icon: LayoutDashboard, permissions: [PERMISSIONS.REPORTS_VIEW] },
      { label: 'Reports', href: '/reports', icon: BarChart3, permissions: [PERMISSIONS.REPORTS_VIEW] },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Companies', href: '/admin/companies', icon: Building2, permissions: [PERMISSIONS.COMPANIES_MANAGE] },
      { label: 'Users', href: '/admin/users', icon: UserCog, permissions: [PERMISSIONS.USERS_MANAGE] },
      { label: 'Roles & Permissions', href: '/admin/roles', icon: ShieldCheck, permissions: [PERMISSIONS.ROLES_MANAGE] },
      { label: 'Audit Log', href: '/admin/audit', icon: ScrollText, permissions: [PERMISSIONS.AUDIT_VIEW] },
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
  { label: 'Coffee item', href: '/items?new=1', icon: Coffee, group: 'Records', hint: 'Origin, grade, screen, process', permission: PERMISSIONS.ITEMS_CREATE },
  { label: 'Journal voucher', href: '/accounting/journal/new', icon: BookPlus, group: 'Money', hint: 'A direct double-entry posting', permission: PERMISSIONS.ACCOUNTING_POST },
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
  { label: 'Receipts', href: '/finance/receipts', icon: ArrowDownToLine, permissions: [PERMISSIONS.RECEIPTS_VIEW] },
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
