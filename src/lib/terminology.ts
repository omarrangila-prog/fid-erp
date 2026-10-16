/**
 * The words a company uses for things.
 *
 * Accounting internals never change — a "customer" is a receivable account to
 * the ledger whatever the screen calls them. This only changes the label, so a
 * coffee exporter can say "Buyer" and "Consignment" while a distributor says
 * "Store". Company terminology (Company.terminology) overrides the template's,
 * which overrides these defaults.
 */

export const DEFAULT_TERMS = {
  item: 'Item',
  items: 'Items',
  /** What the product is, in running text: "Stock on hand by {product}". */
  product: 'Item',
  customer: 'Customer',
  customers: 'Customers',
  supplier: 'Supplier',
  suppliers: 'Suppliers',
  shipment: 'Shipment',
  shipments: 'Shipments',
  warehouse: 'Warehouse',
  warehouses: 'Warehouses',
  /** The unit stock is counted in, as printed after a quantity: KG, PCS, M… */
  unit: 'KG',
  purchaseOrder: 'Purchase order',
  /** The business's own reference on a purchase order — FID calls it its ICUL/FID reference. */
  orderRef: 'Order ref',
  orderReference: 'Order reference',
} as const;

export type TermKey = keyof typeof DEFAULT_TERMS;

/** Plural for the keys that are a singular/plural pair. */
const PLURAL_OF: Partial<Record<TermKey, TermKey>> = {
  item: 'items',
  customer: 'customers',
  supplier: 'suppliers',
  shipment: 'shipments',
  warehouse: 'warehouses',
};

export type Terms = {
  (key: TermKey): string;
  /** Lower-case, for the middle of a sentence. */
  lower(key: TermKey): string;
};

export function makeTerms(overrides: Record<string, string> | null | undefined): Terms {
  const custom = overrides ?? {};
  const pluralize = (w: string) => (/[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : /(s|x|ch|sh)$/i.test(w) ? `${w}es` : `${w}s`);
  const get = (key: TermKey): string => {
    const given = custom[key];
    if (given) return given;
    // "Buyer" set for `customer` should read "Buyers" for `customers`, not "Customers".
    for (const [singular, plural] of Object.entries(PLURAL_OF) as Array<[TermKey, TermKey]>) {
      if (key === plural && custom[singular]) return pluralize(custom[singular]);
    }
    if (key === 'product' && custom.item) return custom.item;
    return DEFAULT_TERMS[key];
  };
  const terms = ((key: TermKey) => get(key)) as Terms;
  terms.lower = (key) => get(key).toLowerCase();
  return terms;
}
