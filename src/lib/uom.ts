/**
 * Units of measure.
 *
 * Stock is held in one *base unit* per item (KG for coffee, PCS for garments,
 * M for fabric…); the `*Kg` columns hold that base quantity whatever it is.
 * What staff type is an *entry unit* converted to the base unit on the way in:
 *
 *   KG item    KG, MT (×1000), and the pack (BAG of 60 KG, say)
 *   PCS item   PCS, DOZ (×12), and the pack (CTN of 24 PCS, say)
 *   M, L item  the base unit and the pack (ROLL of 50 M, DRUM of 200 L…)
 *
 * Costing is "per base unit" (cost / KG, / piece, / metre) and can be shown per
 * pack or per ton by conversion, never by a different stored number.
 */

export type UomKind = 'weight' | 'count' | 'length' | 'volume' | 'pack';

export type UomInfo = { code: string; name: string; plural: string; kind: UomKind };

export const UOMS: Record<string, UomInfo> = {
  KG: { code: 'KG', name: 'Kilogram', plural: 'Kilograms', kind: 'weight' },
  MT: { code: 'MT', name: 'Metric ton', plural: 'Metric tons', kind: 'weight' },
  PCS: { code: 'PCS', name: 'Piece', plural: 'Pieces', kind: 'count' },
  DOZ: { code: 'DOZ', name: 'Dozen', plural: 'Dozens', kind: 'count' },
  M: { code: 'M', name: 'Metre', plural: 'Metres', kind: 'length' },
  L: { code: 'L', name: 'Litre', plural: 'Litres', kind: 'volume' },
  BAG: { code: 'BAG', name: 'Bag', plural: 'Bags', kind: 'pack' },
  CTN: { code: 'CTN', name: 'Carton', plural: 'Cartons', kind: 'pack' },
  BOX: { code: 'BOX', name: 'Box', plural: 'Boxes', kind: 'pack' },
  ROLL: { code: 'ROLL', name: 'Roll', plural: 'Rolls', kind: 'pack' },
  PLT: { code: 'PLT', name: 'Pallet', plural: 'Pallets', kind: 'pack' },
  PACK: { code: 'PACK', name: 'Pack', plural: 'Packs', kind: 'pack' },
};

/** What an item can be counted in. */
export const BASE_UOMS = ['KG', 'PCS', 'M', 'L'] as const;
/** What a pack can be called. */
export const PACK_UOMS = ['BAG', 'CTN', 'BOX', 'ROLL', 'PLT', 'PACK'] as const;

export const uomName = (code: string, plural = false) =>
  UOMS[code.toUpperCase()] ? (plural ? UOMS[code.toUpperCase()].plural : UOMS[code.toUpperCase()].name) : code;

export function isPackUom(code: string): boolean {
  return UOMS[code.toUpperCase()]?.kind === 'pack';
}

/** Units staff may type a quantity in for an item. The first is the default. */
export function entryUnitsFor(item: { baseUom?: string | null; packUom?: string | null }): string[] {
  const base = (item.baseUom || 'KG').toUpperCase();
  const pack = (item.packUom || 'BAG').toUpperCase();
  const units: string[] = [base];
  if (base === 'KG') units.push('MT');
  if (base === 'PCS') units.push('DOZ');
  units.push(pack);
  return [...new Set(units)];
}

/** "KG — kilograms" style label for a select. */
export const uomOptionLabel = (code: string) => `${code} — ${uomName(code, true).toLowerCase()}`;
