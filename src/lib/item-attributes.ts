/**
 * Optional industry attributes for items.
 *
 * The core item record is the same for every business (name, SKU, category,
 * units, HS code, tax category…). A company then opts into one *attribute set*
 * through its industry template, which adds the few extra fields that industry
 * actually quotes — and no other company sees them. Values are stored in
 * `CoffeeItem.attributes` as JSON, keyed by `key`.
 *
 * The coffee set is special only in that FID's existing data lives in dedicated
 * columns (type, origin, process…); the form and pages treat it as a set like
 * any other.
 */

export type AttributeDef = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'date';
  options?: string[];
  placeholder?: string;
  hint?: string;
};

export type AttributeSet = { key: string; label: string; attributes: AttributeDef[] };

export const ATTRIBUTE_SETS: Record<string, AttributeSet> = {
  general: { key: 'general', label: 'General', attributes: [] },
  // Coffee keeps its dedicated columns; no JSON attributes.
  coffee: { key: 'coffee', label: 'Coffee', attributes: [] },
  garments: {
    key: 'garments',
    label: 'Garments / textiles',
    attributes: [
      { key: 'size', label: 'Size', type: 'text', placeholder: 'S, M, L / 42' },
      { key: 'color', label: 'Colour', type: 'text', placeholder: 'Navy' },
      { key: 'fabric', label: 'Fabric', type: 'text', placeholder: '100% cotton' },
      { key: 'gsm', label: 'GSM', type: 'number', placeholder: '180', hint: 'Fabric weight, grams per square metre.' },
    ],
  },
  chemicals: {
    key: 'chemicals',
    label: 'Chemicals',
    attributes: [
      { key: 'grade', label: 'Grade', type: 'text', placeholder: 'Technical' },
      { key: 'purity', label: 'Purity %', type: 'number', placeholder: '99.5' },
      { key: 'batch', label: 'Batch', type: 'text' },
      { key: 'expiry', label: 'Expiry', type: 'date' },
    ],
  },
  electronics: {
    key: 'electronics',
    label: 'Electronics',
    attributes: [
      { key: 'model', label: 'Model', type: 'text' },
      { key: 'serial', label: 'Serial number', type: 'text', hint: 'For a single serialised unit; leave blank for stock items.' },
    ],
  },
  food: {
    key: 'food',
    label: 'Food',
    attributes: [
      { key: 'grade', label: 'Grade', type: 'text' },
      { key: 'origin', label: 'Origin', type: 'text' },
      { key: 'shelfLife', label: 'Shelf life (months)', type: 'number' },
      { key: 'storage', label: 'Storage', type: 'select', options: ['Ambient', 'Chilled', 'Frozen'] },
    ],
  },
};

export function attributeSetFor(key: string | null | undefined): AttributeSet {
  return ATTRIBUTE_SETS[key ?? ''] ?? ATTRIBUTE_SETS.general;
}

/** The form-field name an attribute is posted under. */
export const attributeFieldName = (key: string) => `attr_${key}`;

/** Turns posted `attr_*` fields into the stored JSON, keeping only this set's keys. */
export function collectAttributes(setKey: string, posted: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of attributeSetFor(setKey).attributes) {
    const raw = posted[attributeFieldName(def.key)];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value) out[def.key] = value.slice(0, 200);
  }
  return out;
}
