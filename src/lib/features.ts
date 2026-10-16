/**
 * Feature flags: which parts of the product a company has switched on.
 *
 * One vocabulary, used everywhere — the menu, the dashboard, the server guards,
 * the plan entitlements and the industry templates all speak in these names.
 * Nothing else in the code asks "is this company a coffee trader" or "is this
 * the Moroccan company"; it asks `hasFeature(company, 'AGENTS')`.
 *
 * Resolution, most specific first:
 *   1. the company's own switch            (Company.features, set in Settings)
 *   2. the industry template's default     (lib/templates.ts)
 *   3. ON — so a company created before this layer existed loses nothing.
 *
 * A feature that is OFF is gone, not merely hidden: the permissions that
 * belong to it stop being granted (`featureBlocksPermission`, called from the
 * one `can()` every server guard goes through), so a hand-typed URL or a
 * direct action call is refused the same as a missing menu entry.
 */

import { templateFeatureDefaults } from '@/lib/templates';

export const FEATURES = [
  'SALES',
  'PURCHASES',
  'SHIPMENTS',
  'CONTAINERS',
  'INVENTORY',
  'CASH_BANK',
  'CHEQUES',
  'EXPENSES',
  'AGENTS',
  'LOANS',
  'REPORTS',
  'ADVANCED_ACCOUNTING',
  'MULTI_CURRENCY',
  'MULTI_COMPANY',
  'WHATSAPP_SHARING',
  'CUSTOM_REPORTS',
  'TAX',
] as const;

export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABELS: Record<Feature, { label: string; description: string }> = {
  SALES: { label: 'Sales', description: 'Sales invoices, credit notes and customer payments.' },
  PURCHASES: { label: 'Purchases', description: 'Purchase orders and supplier bills.' },
  SHIPMENTS: { label: 'Shipments', description: 'Track an order from supplier to warehouse, with costing.' },
  CONTAINERS: { label: 'Containers', description: 'Container numbers and per-container costing. Off for air, truck or bulk cargo.' },
  INVENTORY: { label: 'Inventory', description: 'Warehouses, stock on hand, transfers and stock counts.' },
  CASH_BANK: { label: 'Cash & bank', description: 'Cash drawers, bank accounts and reconciliation.' },
  CHEQUES: { label: 'Cheques', description: 'Post-dated cheques received and issued.' },
  EXPENSES: { label: 'Expenses', description: 'Shipment and general expenses, and unpaid expenses.' },
  AGENTS: { label: 'Agents', description: 'Sales agents, their collections and commission.' },
  LOANS: { label: 'Loans', description: 'Money borrowed or lent, with repayments.' },
  REPORTS: { label: 'Reports', description: 'Profit and loss, balance sheet, trial balance and more.' },
  ADVANCED_ACCOUNTING: { label: 'Accountant mode', description: 'Journal entries, period close and debit/credit views.' },
  MULTI_CURRENCY: { label: 'Multi-currency', description: 'Transact in several currencies with exchange rates.' },
  MULTI_COMPANY: { label: 'Multi-company', description: 'Several legal entities under one organization.' },
  WHATSAPP_SHARING: { label: 'WhatsApp sharing', description: 'Share invoices, statements and reports as secure links.' },
  CUSTOM_REPORTS: { label: 'Custom reports', description: 'Choose, reorder and save report columns.' },
  TAX: { label: 'Tax', description: 'VAT / GST / sales tax on documents, with returns.' },
};

export type FeatureFlags = Partial<Record<Feature, boolean>>;

export type FeatureSubject = {
  industryTemplate?: string | null;
  features?: Record<string, boolean> | null;
};

export function hasFeature(company: FeatureSubject | null | undefined, feature: Feature): boolean {
  if (!company) return true;
  const own = company.features?.[feature];
  if (typeof own === 'boolean') return own;
  const byTemplate = templateFeatureDefaults(company.industryTemplate)[feature];
  return typeof byTemplate === 'boolean' ? byTemplate : true;
}

/** Every flag, resolved — what a settings screen shows. */
export function resolveFeatures(company: FeatureSubject | null | undefined): Record<Feature, boolean> {
  return Object.fromEntries(FEATURES.map((f) => [f, hasFeature(company, f)])) as Record<Feature, boolean>;
}

/**
 * Which permission codes a feature owns. When the feature is off those codes
 * are not granted to anyone in that company — Super Admin included.
 */
const PERMISSION_OWNERS: Array<[Feature, RegExp]> = [
  ['SALES', /^(sales|creditnotes|receipts)\./],
  ['PURCHASES', /^purchases\./],
  ['SHIPMENTS', /^(shipments|shippinglines|ports)\./],
  ['CONTAINERS', /^containers\./],
  ['INVENTORY', /^(inventory|stockcount|warehouses)\./],
  ['CASH_BANK', /^(cashbank\.|bank\.)/],
  ['CHEQUES', /^cheques\./],
  ['EXPENSES', /^(expenses|expensecategories)\./],
  ['AGENTS', /^agents\./],
  ['REPORTS', /^(reports|profits)\./],
  ['ADVANCED_ACCOUNTING', /^accounting\.(post|periods\.close)$/],
];

export function featureBlocksPermission(company: FeatureSubject | null | undefined, permission: string): boolean {
  for (const [feature, pattern] of PERMISSION_OWNERS) {
    if (pattern.test(permission) && !hasFeature(company, feature)) return true;
  }
  return false;
}

/** The feature a menu route belongs to, so the menu can hide it. */
export const ROUTE_FEATURES: Array<[RegExp, Feature]> = [
  [/^\/agents/, 'AGENTS'],
  [/^\/ledgers\/agents/, 'AGENTS'],
  [/^\/finance\/agent-commission/, 'AGENTS'],
  [/^\/finance\/cheques/, 'CHEQUES'],
  [/^\/finance\/loans/, 'LOANS'],
  [/^\/finance\/reconciliation/, 'CASH_BANK'],
  [/^\/finance\/cash-bank/, 'CASH_BANK'],
  [/^\/reports\/cash-book/, 'CASH_BANK'],
  [/^\/shipments/, 'SHIPMENTS'],
  [/^\/loading/, 'SHIPMENTS'],
  [/^\/reports\/shipment-cost/, 'SHIPMENTS'],
  [/^\/profitability/, 'SHIPMENTS'],
  [/^\/shipping-lines/, 'SHIPMENTS'],
  [/^\/ports/, 'SHIPMENTS'],
  [/^\/goods-receipts/, 'INVENTORY'],
  [/^\/inventory/, 'INVENTORY'],
  [/^\/warehouses/, 'INVENTORY'],
  [/^\/trace/, 'INVENTORY'],
  [/^\/sales/, 'SALES'],
  [/^\/finance\/receipts/, 'SALES'],
  [/^\/purchases/, 'PURCHASES'],
  [/^\/finance\/payments/, 'PURCHASES'],
  [/^\/finance\/expenses/, 'EXPENSES'],
  [/^\/finance\/unpaid-expenses/, 'EXPENSES'],
  [/^\/expense-categories/, 'EXPENSES'],
  [/^\/accounting\/journal/, 'ADVANCED_ACCOUNTING'],
  [/^\/reports/, 'REPORTS'],
  [/^\/settings\/tax/, 'TAX'],
];

export function routeFeature(href: string): Feature | null {
  const path = href.split('?')[0];
  for (const [pattern, feature] of ROUTE_FEATURES) if (pattern.test(path)) return feature;
  return null;
}
