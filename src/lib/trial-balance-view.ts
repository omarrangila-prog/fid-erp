import { ACCOUNT_KEYS } from '@/lib/constants';
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
