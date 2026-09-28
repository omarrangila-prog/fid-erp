import { dec, toMoney } from '@/lib/money';

/**
 * What of a ledger is sent to the browser.
 *
 * The server works out every running balance over the whole history — that
 * is what makes a balance right — but a phone should not be handed thousands
 * of rows to page through. So the rows are cut to the dates asked for, and
 * then to the latest few hundred of those; everything before the first row
 * sent arrives as one "brought forward" balance. The period's own opening,
 * totals and closing are worked out here from every row in the period, so the
 * summary is right however many rows actually travel.
 */

export const LEDGER_WINDOW_ROWS = 500;

type WindowRow = { date: string; debit: string; credit: string; balance: string };

export type LedgerWindow = {
  /** Balance before the selected period. */
  opening: string;
  totalDebit: string;
  totalCredit: string;
  /** Balance at the end of the selected period. */
  closing: string;
  /** Entries in the period, and how many of them were sent. */
  total: number;
  sent: number;
  /** True when only the latest entries of the period were sent. */
  trimmed: boolean;
  from?: string;
  to?: string;
};

const isDay = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);

/**
 * Rows must be in date order, each carrying the running balance after it,
 * and `opening` the balance before the first of them.
 */
export function windowLedger<T extends WindowRow>(
  rows: T[],
  opening: string,
  options: { from?: string; to?: string; maxRows?: number } = {},
): { rows: T[]; opening: string; window: LedgerWindow } {
  const from = isDay(options.from);
  const to = isDay(options.to);
  const max = options.maxRows ?? LEDGER_WINDOW_ROWS;

  const before = from ? rows.filter((r) => r.date < from) : [];
  const periodOpening = before.length ? before[before.length - 1].balance : opening;
  const period = rows.filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
  const closing = period.length ? period[period.length - 1].balance : periodOpening;
  const totalDebit = toMoney(period.reduce((t, r) => t.plus(dec(r.debit)), dec(0))).toString();
  const totalCredit = toMoney(period.reduce((t, r) => t.plus(dec(r.credit)), dec(0))).toString();

  const trimmed = period.length > max;
  const sent = trimmed ? period.slice(period.length - max) : period;
  // The balance just before the first row sent: the period's opening, or what the unsent rows brought forward.
  const sentOpening = trimmed ? period[period.length - max - 1].balance : periodOpening;

  return {
    rows: sent,
    opening: sentOpening,
    window: { opening: periodOpening, totalDebit, totalCredit, closing, total: period.length, sent: sent.length, trimmed, from, to },
  };
}
