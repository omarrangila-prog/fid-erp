/**
 * The currencies a company actually transacts in — what its money forms offer.
 *
 * FID Trading International SARL (Morocco) pays and receives only in dirhams
 * and dollars; offering the UAE dirham there invited a Moroccan payment to be
 * booked in the wrong currency. The company's own currency comes first, then
 * the dollar. The Dubai company keeps the full list it has always had.
 *
 * `keep` is the currency a record being edited already has: an old record in
 * a currency no longer offered still shows, and saves, as it was.
 */
export function transactionCurrencies(localCurrency: string, keep?: string | null): string[] {
  const local = localCurrency.toUpperCase();
  const list = local === 'MAD' ? ['MAD', 'USD'] : ['USD', 'AED', 'MAD'];
  return keep && !list.includes(keep) ? [...list, keep] : list;
}

export const CURRENCY_NAMES: Record<string, string> = {
  USD: 'US Dollar',
  AED: 'UAE Dirham',
  MAD: 'Moroccan Dirham',
  EUR: 'Euro',
};

/** The same list as select options, "MAD — Moroccan Dirham" or just "MAD". */
export function currencyOptions(
  localCurrency: string,
  { keep, short = false }: { keep?: string | null; short?: boolean } = {},
): Array<{ value: string; label: string }> {
  return transactionCurrencies(localCurrency, keep).map((code) => ({
    value: code,
    label: short ? code : `${code} — ${CURRENCY_NAMES[code] ?? code}`,
  }));
}
