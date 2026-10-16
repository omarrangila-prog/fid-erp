import type { FeatureFlags } from '@/lib/features';

/**
 * Industry templates: sensible starting points, never separate products.
 *
 * Every template runs the same engine. A template only chooses which modules
 * start switched on, which words the screens use and which optional item
 * attributes are offered. Anything it decides can be changed afterwards in
 * Settings, so picking the wrong one on day one costs nothing.
 */

export const BUSINESS_TYPES = [
  { value: 'IMPORT', label: 'Import' },
  { value: 'EXPORT', label: 'Export' },
  { value: 'IMPORT_EXPORT', label: 'Import and export' },
  { value: 'LOCAL_TRADING', label: 'Local trading' },
  { value: 'DISTRIBUTION', label: 'Distribution' },
] as const;

export type TemplateKey =
  | 'GENERAL_TRADING'
  | 'IMPORT_BUSINESS'
  | 'EXPORT_BUSINESS'
  | 'IMPORT_EXPORT'
  | 'DISTRIBUTION'
  | 'COMMODITY_TRADING'
  | 'APPAREL_TEXTILE';

export type Template = {
  key: TemplateKey;
  label: string;
  description: string;
  businessType: (typeof BUSINESS_TYPES)[number]['value'];
  features: FeatureFlags;
  /** Words the screens use. Missing keys fall back to lib/terminology.ts. */
  terminology: Record<string, string>;
  /** Optional item-attribute set offered on the item form (lib/item-attributes.ts). */
  attributeSet: string;
};

const ALL_ON: FeatureFlags = {};

export const TEMPLATES: Record<TemplateKey, Template> = {
  GENERAL_TRADING: {
    key: 'GENERAL_TRADING',
    label: 'General trading',
    description: 'Buy and sell goods, import or local, with stock, sales and accounting.',
    businessType: 'IMPORT_EXPORT',
    features: { AGENTS: false, LOANS: false, CHEQUES: false },
    terminology: {},
    attributeSet: 'general',
  },
  IMPORT_BUSINESS: {
    key: 'IMPORT_BUSINESS',
    label: 'Import business',
    description: 'Import goods by sea, air or road with landed cost, then sell locally.',
    businessType: 'IMPORT',
    features: { AGENTS: false },
    terminology: {},
    attributeSet: 'general',
  },
  EXPORT_BUSINESS: {
    key: 'EXPORT_BUSINESS',
    label: 'Export business',
    description: 'Source goods locally and ship them to overseas buyers in foreign currency.',
    businessType: 'EXPORT',
    features: { AGENTS: false, LOANS: false },
    terminology: { customer: 'Buyer' },
    attributeSet: 'general',
  },
  IMPORT_EXPORT: {
    key: 'IMPORT_EXPORT',
    label: 'Import + export',
    description: 'The complete import and export workflow with every module available.',
    businessType: 'IMPORT_EXPORT',
    features: ALL_ON,
    terminology: {},
    attributeSet: 'general',
  },
  DISTRIBUTION: {
    key: 'DISTRIBUTION',
    label: 'Distribution',
    description: 'Buy from suppliers, stock several warehouses and sell through sales agents. No shipment tracking.',
    businessType: 'DISTRIBUTION',
    features: { SHIPMENTS: false, CONTAINERS: false },
    terminology: { warehouse: 'Store' },
    attributeSet: 'general',
  },
  COMMODITY_TRADING: {
    key: 'COMMODITY_TRADING',
    label: 'Commodity trading',
    description: 'Bulk commodities in containers: lots, batches, weights, landed cost per kilo or ton.',
    businessType: 'IMPORT_EXPORT',
    features: ALL_ON,
    terminology: {},
    attributeSet: 'coffee',
  },
  APPAREL_TEXTILE: {
    key: 'APPAREL_TEXTILE',
    label: 'Apparel / textile trading',
    description: 'Garments and fabric by the piece, carton or roll, with size, colour and fabric.',
    businessType: 'IMPORT_EXPORT',
    features: { LOANS: false },
    terminology: {},
    attributeSet: 'garments',
  },
};

export const TEMPLATE_LIST = Object.values(TEMPLATES);

export function isTemplateKey(value: string | null | undefined): value is TemplateKey {
  return !!value && value in TEMPLATES;
}

export function templateFeatureDefaults(template: string | null | undefined): FeatureFlags {
  return isTemplateKey(template) ? TEMPLATES[template].features : {};
}
