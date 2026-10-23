import { ACCOUNT_KEYS } from '@/lib/constants';
import { Decimal } from '@/lib/money';
import type { TrialBalanceRow } from '@/lib/services/reports';

/**
 * The trial balance in the client's words.
 *
 * The ledger keeps accounts the posting engine needs — an agent clearing
 * control, the supplier sub-ledger's control — under names that mean
 * something to an accountant and little to the owner reading the report.
 * This gives those system accounts plain display names.
 *
 * Display only, one line per ledger account. No account is renamed, merged
 * or touched; the ledger name is shown beside the display name, and every
 * line opens its own ledger.
 */

/**
 * Display names for the accounts the system itself creates, by system key —
 * never by account name. Only where the ledger's name is a technical one;
 * accounts whose names are already plain (Coffee Sales, Inventory — Coffee
 * Stock, Customer Advances) and every account the client named keep their
 * own. Two different accounts never share a display name: agent collections,
 * agent commission and loans each keep a name of their own.
 */
const LABELS: Partial<Record<string, string>> = {
  [ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE]: 'Customer Receivables',
  [ACCOUNT_KEYS.ACCOUNTS_PAYABLE]: 'Supplier Payables',
  [ACCOUNT_KEYS.ACCRUED_EXPENSES]: 'Unpaid Expenses',
  [ACCOUNT_KEYS.AGENT_CLEARING]: 'Customer Collections Held by Agents',
  [ACCOUNT_KEYS.AGENT_COMMISSION_PAYABLE]: 'Agent Commission Payable',
  [ACCOUNT_KEYS.CHEQUES_ON_HAND]: 'Cheques Received, Not Banked',
  [ACCOUNT_KEYS.CHEQUES_ISSUED]: 'Cheques Issued, Not Cleared',
  [ACCOUNT_KEYS.FX_GAIN_LOSS]: 'Exchange Gain / Loss',
};

export type TrialBalanceAccountMeta = { systemKey: string | null };

/** The name the client sees for one account. The ledger's own name stays on the ledger. */
export function clientLabel(row: Pick<TrialBalanceRow, 'name'>, meta?: TrialBalanceAccountMeta): string {
  const key = meta?.systemKey ?? null;
  return (key && LABELS[key]) ?? row.name;
}

/**
 * Hidden by "Hide unused accounts": nothing brought forward, nothing moved in
 * the period, nothing left. An account with a movement that came back to
 * nil, or a balance carried in without new entries, is always shown.
 */
export function isUnusedInPeriod(row: Pick<TrialBalanceRow, 'openingDebitLocal' | 'openingCreditLocal' | 'periodDebitLocal' | 'periodCreditLocal' | 'debitLocal' | 'creditLocal' | 'openingDebitUsd' | 'openingCreditUsd' | 'periodDebitUsd' | 'periodCreditUsd' | 'debitUsd' | 'creditUsd'>): boolean {
  return [
    row.openingDebitLocal, row.openingCreditLocal, row.periodDebitLocal, row.periodCreditLocal, row.debitLocal, row.creditLocal,
    row.openingDebitUsd, row.openingCreditUsd, row.periodDebitUsd, row.periodCreditUsd, row.debitUsd, row.creditUsd,
  ].every((v) => v.isZero());
}

/**
 * Nothing left on the account at the closing date, in the books' currency.
 * A trial balance as at a date has nothing to say about it, so it is left
 * out — a crumb of USD equivalent from rounding does not make it a balance.
 */
export function isZeroAtClose(row: Pick<TrialBalanceRow, 'debitLocal' | 'creditLocal'>): boolean {
  return row.debitLocal.isZero() && row.creditLocal.isZero();
}

/** The id the combined operating-expenses line carries. */
export const OPERATING_ROW_ID = 'group-operating-expenses';

/**
 * Several accounts read as one line — the owner's operating expenses, all
 * together. The line's balance is their sum; the accounts themselves are
 * untouched and each still has its ledger. Totals are those of the lines
 * shown, so the balance check holds.
 */
export function combineTrialRows<
  R extends Pick<TrialBalanceRow, 'accountId' | 'code' | 'name' | 'type' | 'debitLocal' | 'creditLocal' | 'debitUsd' | 'creditUsd'>,
  T extends { rows: R[]; totals: { debitLocal: Decimal; creditLocal: Decimal; debitUsd: Decimal; creditUsd: Decimal } },
>(report: T, ids: Set<string>, line: { accountId: string; name: string }): T {
  const parts = report.rows.filter((r) => ids.has(r.accountId));
  if (parts.length === 0) return report;
  const net = (pick: (r: R) => Decimal) => parts.reduce((t, r) => t.plus(pick(r)), new Decimal(0));
  const local = net((r) => r.debitLocal).minus(net((r) => r.creditLocal));
  const usd = net((r) => r.debitUsd).minus(net((r) => r.creditUsd));
  const zero = new Decimal(0);
  const combined = {
    ...parts[0],
    ...line,
    debitLocal: local.greaterThan(0) ? local : zero,
    creditLocal: local.lessThan(0) ? local.negated() : zero,
    debitUsd: usd.greaterThan(0) ? usd : zero,
    creditUsd: usd.lessThan(0) ? usd.negated() : zero,
  } as R;
  const rows = [...report.rows.filter((r) => !ids.has(r.accountId)), combined].sort((a, b) => a.code.localeCompare(b.code));
  const total = (pick: (r: R) => Decimal) => rows.reduce((t, r) => t.plus(pick(r)), zero);
  return {
    ...report,
    rows,
    totals: { ...report.totals, debitLocal: total((r) => r.debitLocal), creditLocal: total((r) => r.creditLocal), debitUsd: total((r) => r.debitUsd), creditUsd: total((r) => r.creditUsd) },
  };
}

/**
 * The shipment expenses that went out with the coffee sold, shown with the
 * operating expenses rather than inside Cost of Goods Sold — the owner's
 * reading, as on the profit and loss. Both lines are debits, so the totals
 * do not move; in the ledger the expenses stay in the coffee's cost.
 */
export function moveIntoOperating<
  R extends Pick<TrialBalanceRow, 'accountId' | 'code' | 'name' | 'debitLocal' | 'creditLocal' | 'debitUsd' | 'creditUsd'>,
  T extends { rows: R[] },
>(report: T, cogsAccountId: string | null | undefined, amount: { local: Decimal; usd: Decimal }): T {
  const cogs = report.rows.find((r) => r.accountId === cogsAccountId);
  if (!cogs || amount.local.isZero()) return report;
  const existing = report.rows.find((r) => r.accountId === OPERATING_ROW_ID);
  const rows = report.rows.map((r) => {
    if (r.accountId === cogs.accountId) return { ...r, debitLocal: r.debitLocal.minus(amount.local), debitUsd: r.debitUsd.minus(amount.usd) };
    if (r.accountId === OPERATING_ROW_ID) return { ...r, debitLocal: r.debitLocal.plus(amount.local), debitUsd: r.debitUsd.plus(amount.usd) };
    return r;
  });
  if (!existing) {
    const zero = new Decimal(0);
    rows.push({ ...cogs, accountId: OPERATING_ROW_ID, name: 'Operating Expenses', code: `${cogs.code}~`, debitLocal: amount.local, debitUsd: amount.usd, creditLocal: zero, creditUsd: zero });
  }
  return { ...report, rows };
}
