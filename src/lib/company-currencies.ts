import { CURRENCIES, currencyName } from '@/lib/currencies';

/**
 * The currencies a company actually transacts in — what its money forms offer.
 *
 * Which ones is a company setting (`Company.transactionCurrencies`), chosen
 * from every currency in the world. A company that has not chosen yet keeps the
 * list the product shipped with: its own currency first, then the dollar, plus
 * the dirham pair FID has always used — so nothing changes for it.
 *
 * `keep` is the currency a record being edited already has: an old record in
 * a currency no longer offered still shows, and saves, as it was.
 */
const LEGACY = (local: string): string[] => (local === 'MAD' ? ['MAD', 'USD'] : ['USD', 'AED', 'MAD']);

export function transactionCurrencies(localCurrency: string, keep?: string | null, configured?: readonly string[] | null): string[] {
  const local = localCurrency.toUpperCase();
  let list: string[];
  if (configured && configured.length > 0) {
    // Offered in the order the company chose; its own currency is always
    // usable, so it is added at the end if it was left out.
    list = [...new Set([...configured.map((c) => c.toUpperCase()), local])];
  } else if (local === 'MAD' || local === 'AED') {
    list = LEGACY(local);
  } else {
    // A company outside the two legacy books: its own currency, then the dollar.
    list = [...new Set([local, 'USD'])];
  }
  return keep && !list.includes(keep) ? [...list, keep] : list;
}

/**
 * The currency a new customer's account starts in: the company's default sales
 * currency if it set one; otherwise what the product always did — dirhams for
 * Morocco, dollars for Dubai — and for any other company its own currency.
 */
export function defaultCustomerCurrency(company: { localCurrency: string; defaultSalesCurrency?: string | null }): string {
  if (company.defaultSalesCurrency) return company.defaultSalesCurrency.toUpperCase();
  const local = company.localCurrency.toUpperCase();
  return local === 'AED' ? 'USD' : local;
}

/** "US Dollar" by code; every ISO currency is known. */
export const CURRENCY_NAMES: Record<string, string> = Object.fromEntries(CURRENCIES.map((c) => [c.code, c.name]));

/** The same list as select options, "MAD — Moroccan Dirham" or just "MAD". */
export function currencyOptions(
  localCurrency: string,
  {
    keep,
    short = false,
    configured,
  }: { keep?: string | null; short?: boolean; configured?: readonly string[] | null } = {},
): Array<{ value: string; label: string }> {
  return transactionCurrencies(localCurrency, keep, configured).map((code) => ({
    value: code,
    label: short ? code : `${code} — ${currencyName(code)}`,
  }));
}
