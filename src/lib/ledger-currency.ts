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
 *   4. USD — only for true multi-currency control accounts
 *
 * Pass ALL to list currencies separately without adding them together.
 */

/**
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
export const LEDGER_VIEW_CURRENCIES = ['REPORTING', 'ALL', 'USD', 'MAD', 'AED'] as const;
export type LedgerViewCurrency = (typeof LEDGER_VIEW_CURRENCIES)[number];

export function parseLedgerViewCurrency(value: string | null | undefined): LedgerViewCurrency | null {
  if (value === 'REPORTING' || value === 'ALL' || value === 'USD' || value === 'MAD' || value === 'AED') return value;
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
}): LedgerViewCurrency {
  return (
    parseLedgerViewCurrency(params.requested) ??
    parseLedgerViewCurrency(params.cashBankCurrency) ??
    parseLedgerViewCurrency(params.accountCurrency) ??
    'REPORTING'
  );
}

export function ledgerHref(accountId: string, currency?: string | null): string {
  const params = new URLSearchParams({ account: accountId });
  const view = parseLedgerViewCurrency(currency);
  if (view) params.set('currency', view);
  return `/reports/general-ledger?${params.toString()}`;
}

/** Human label for the GL header — never say "USD only" for a MAD cash head. */
export function ledgerCurrencyLabel(viewCurrency: string, mixed: boolean): string {
  if (mixed) return 'all currencies listed separately — USD and MAD are never added together';
  if (viewCurrency === 'REPORTING') return 'every line at its USD value';
  return `${viewCurrency} lines only, in ${viewCurrency}`;
}
