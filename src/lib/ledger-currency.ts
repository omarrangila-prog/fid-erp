/**
 * Which currency a general-ledger screen should open in.
 *
 * Cash and bank GL heads store their own currency. Opening those accounts as
 * "USD only" hid every MAD cash line and made Cash in Hand look like a dollar
 * account. A named native currency always wins over the old USD default.
 *
 * Priority:
 *   1. Explicit URL / picker choice (including ALL)
 *   2. Cash/bank account currency (the drawer the user opened)
 *   3. Account.currency on the GL head
 *   4. The single currency every posting on the account is in
 *   5. USD — only for accounts that genuinely carry several currencies
 *
 * Pass ALL to list currencies separately without adding them together.
 */

/**
 * LOCAL    — every line at its value in the company's own currency (MAD for
 *             Morocco), with a running balance in it. The figure the trial
 *             balance and the balance sheet are kept in, so this is the view
 *             that agrees with them. The default for an account that carries
 *             several currencies in a company that does not keep its books in
 *             USD: Morocco's inventory, payables and cost of sales opened at
 *             their USD value while every statement beside them said MAD.
 * REPORTING — every line at its USD value, with a running USD balance. The
 *             default for a control account that carries several currencies
 *             (receivables, payables, sales): every line has a USD value, so
 *             every line is shown.
 * USD, MAD, AED — only the lines in that currency, in that currency, with a
 *             native running balance. For a MAD cash drawer this is the only
 *             sensible view; for a personal account it keeps the dirhams and
 *             the dollars apart, as the client asked.
 * ALL      — every line in its own currency, no running balance, because
 *             dirhams and dollars are never added together.
 */
export const LEDGER_VIEW_CURRENCIES = ['LOCAL', 'REPORTING', 'ALL', 'USD', 'MAD', 'AED'] as const;
export type LedgerViewCurrency = (typeof LEDGER_VIEW_CURRENCIES)[number];

export function parseLedgerViewCurrency(value: string | null | undefined): LedgerViewCurrency | null {
  if (value === 'LOCAL' || value === 'REPORTING' || value === 'ALL' || value === 'USD' || value === 'MAD' || value === 'AED') return value;
  return null;
}

/**
 * Prefer the cash/bank drawer currency over a stale Account.currency, and never
 * let an unrelated USD cash drawer attached to the same GL head steal the view
 * when a MAD drawer was what the user opened.
 */
export function pickCashBankCurrency(
  drawers: Array<{ currency: string }> | null | undefined,
  prefer?: string | null,
): string | null {
  if (!drawers?.length) return null;
  const preferred = prefer?.toUpperCase();
  if (preferred) {
    const match = drawers.find((row) => row.currency.toUpperCase() === preferred);
    if (match) return match.currency;
  }
  // Prefer a non-USD drawer when several map to one head — MAD Cash in Hand
  // must not open as USD because a USD drawer shares the same GL id.
  const local = drawers.find((row) => row.currency.toUpperCase() !== 'USD');
  return (local ?? drawers[0]).currency;
}

export function resolveLedgerViewCurrency(params: {
  requested?: string | null;
  accountCurrency?: string | null;
  cashBankCurrency?: string | null;
  /**
   * The only currency the account's own postings are in, when they are all in
   * one. An account is not "multi-currency" because the reports are kept in
   * USD: Agent Clearing in Morocco holds nothing but dirhams, and opening it
   * at its USD value made a MAD 46,000 cheque read as USD 4,791.67 under a
   * USD heading. When every line agrees, that currency is the view.
   */
  onlyPostedCurrency?: string | null;
  /** The currency the company keeps its books in; not USD means mixed accounts open in it. */
  companyCurrency?: string | null;
}): LedgerViewCurrency {
  return (
    parseLedgerViewCurrency(params.requested) ??
    parseLedgerViewCurrency(params.cashBankCurrency) ??
    parseLedgerViewCurrency(params.accountCurrency) ??
    parseLedgerViewCurrency(params.onlyPostedCurrency) ??
    (params.companyCurrency && params.companyCurrency.toUpperCase() !== 'USD' ? 'LOCAL' : 'REPORTING')
  );
}

export function ledgerHref(accountId: string, currency?: string | null): string {
  const params = new URLSearchParams({ account: accountId });
  const view = parseLedgerViewCurrency(currency);
  if (view) params.set('currency', view);
  return `/reports/general-ledger?${params.toString()}`;
}

/** Human label for the GL header — never say "USD only" for a MAD cash head. */
/**
 * The currency to print an amount in for a given view.
 *
 * "REPORTING" and "ALL" are ways of looking at a ledger, not currencies, and
 * handing either to a money formatter printed "REPORTING 50,000.00" on the
 * screen. The reporting view states every line at its USD value, so USD is
 * what those figures are in; the company view is in the company's currency.
 */
export function ledgerDisplayCurrency(viewCurrency: string, fallback = 'USD'): string {
  if (viewCurrency === 'REPORTING') return 'USD';
  if (viewCurrency === 'ALL' || viewCurrency === 'LOCAL') return fallback;
  return viewCurrency;
}

export function ledgerCurrencyLabel(viewCurrency: string, mixed: boolean, localCurrency = 'MAD'): string {
  if (mixed) return 'all currencies listed separately — USD and MAD are never added together';
  if (viewCurrency === 'REPORTING') return 'every line at its USD value';
  if (viewCurrency === 'LOCAL') return `every line at its ${localCurrency} value, as in the trial balance`;
  return `${viewCurrency} lines only, in ${viewCurrency}`;
}
