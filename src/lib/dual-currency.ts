import { Decimal, dec, toMoney, type DecimalInput } from '@/lib/money';

/**
 * The other currency's equivalent of an amount, for display only.
 *
 * One formula for every screen, so no two convert differently. The rate is
 * the transaction's own, stored when it was entered — never today's rate,
 * never a shipment's average — expressed as units of the company's currency
 * per 1 USD (1 USD = 9.6000 MAD):
 *
 *   USD → local   amount × rate
 *   local → USD   amount ÷ rate
 *
 * An equivalent the transaction already stored is used as it is. With no rate
 * and nothing stored, there is no equivalent: an invented rate would be an
 * invented number. Nothing here posts or changes a figure in the books.
 */
export type Equivalent = { amount: Decimal; currency: string; rate: Decimal | null } | null;

export function equivalentOf(params: {
  amount: DecimalInput;
  currency: string;
  localCurrency: string;
  /** The transaction's own rate: local units per 1 USD. */
  rateLocalPerUsd?: DecimalInput | null;
  /** What the transaction stored, when it stored it. */
  amountUsd?: DecimalInput | null;
  amountLocal?: DecimalInput | null;
}): Equivalent {
  const currency = params.currency.toUpperCase();
  const local = params.localCurrency.toUpperCase();
  const amount = dec(params.amount);
  const rate = params.rateLocalPerUsd != null && dec(params.rateLocalPerUsd).greaterThan(0) ? dec(params.rateLocalPerUsd) : null;

  if (local === 'USD' && currency === 'USD') return null;
  if (currency === 'USD') {
    if (params.amountLocal != null) return { amount: toMoney(params.amountLocal), currency: local, rate };
    return rate ? { amount: toMoney(amount.times(rate)), currency: local, rate } : null;
  }
  if (currency === local) {
    if (params.amountUsd != null) return { amount: toMoney(params.amountUsd), currency: 'USD', rate };
    return rate ? { amount: toMoney(amount.dividedBy(rate)), currency: 'USD', rate } : null;
  }
  // A third currency (AED in the Moroccan books): the company's currency if
  // stored, else dollars.
  if (params.amountLocal != null) return { amount: toMoney(params.amountLocal), currency: local, rate };
  if (params.amountUsd != null) return { amount: toMoney(params.amountUsd), currency: 'USD', rate };
  return null;
}

/** "1 USD = 9.6000 MAD" — the rate a conversion used, for its tooltip. */
export function rateLabel(rate: Decimal | null | undefined, localCurrency: string): string | null {
  return rate && rate.greaterThan(0) ? `1 USD = ${rate.toFixed(4)} ${localCurrency}` : null;
}

export { Decimal };

/**
 * The same equivalent as text, for lists built on the server and drawn in the
 * browser: "≈ USD 4,791.67", and the rate it used for a tooltip.
 */
export function equivalentText(
  params: Parameters<typeof equivalentOf>[0],
): { text: string; title: string } | null {
  const e = equivalentOf(params);
  if (!e) return null;
  const amount = e.amount.toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    text: `≈ ${e.currency} ${amount}`,
    title: rateLabel(e.rate, params.localCurrency.toUpperCase()) ?? 'At the transaction’s own rate',
  };
}
