import { ACCOUNT_KEYS } from '@/lib/constants';
import { Decimal } from '@/lib/money';
import type { TrialBalanceRow } from '@/lib/services/reports';

/**
 * The trial balance in the client's words.
 *
 * The ledger keeps accounts the posting engine needs — an agent clearing
 * control, a coffee-stock control, the supplier sub-ledger's control — under
 * names that mean something to an accountant and little to the owner reading
 * the report. This gives those system accounts plain labels and puts accounts
 * that mean the same thing to the client on one line.
 *
 * Display only. No account is renamed, merged or touched: the ledger and the
 * detailed view are exactly as they were. Accounts the client created and
 * named keep their own names — they are already in the client's words.
 *
 * A grouped line adds its accounts' debits and credits up separately rather
 * than netting them, so the report's totals are the ledger's totals to the
 * cent. Netting would make both totals smaller, which reads as money that
 * vanished in the grouping.
 */

/** Plain labels for system accounts, by system key — never by account name. */
const LABELS: Partial<Record<string, string>> = {
  [ACCOUNT_KEYS.INVENTORY]: 'Inventory',
  [ACCOUNT_KEYS.INVENTORY_IN_TRANSIT]: 'Inventory in Transit',
  [ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE]: 'Customer Receivables',
  [ACCOUNT_KEYS.CUSTOMER_ADVANCES]: 'Customer Advances',
  [ACCOUNT_KEYS.ACCOUNTS_PAYABLE]: 'Supplier Payables',
  [ACCOUNT_KEYS.SUPPLIER_ADVANCES]: 'Supplier Advances',
  [ACCOUNT_KEYS.ACCRUED_EXPENSES]: 'Expenses Owed',
  [ACCOUNT_KEYS.AGENT_COMMISSION_PAYABLE]: 'Agent Payables',
  [ACCOUNT_KEYS.INTERCOMPANY_LOAN_RECEIVABLE]: 'Loans Receivable',
  [ACCOUNT_KEYS.INTERCOMPANY_LOAN_PAYABLE]: 'Loans Payable',
  [ACCOUNT_KEYS.CHEQUES_ON_HAND]: 'Cheques Received, Not Banked',
  [ACCOUNT_KEYS.CHEQUES_ISSUED]: 'Cheques Issued, Not Cleared',
  [ACCOUNT_KEYS.VAT_INPUT]: 'VAT Recoverable',
  [ACCOUNT_KEYS.VAT_OUTPUT]: 'VAT Payable',
  [ACCOUNT_KEYS.SALES_REVENUE]: 'Sales',
  [ACCOUNT_KEYS.SALES_RETURNS]: 'Sales Returns',
  [ACCOUNT_KEYS.COST_OF_GOODS_SOLD]: 'Cost of Goods Sold',
  [ACCOUNT_KEYS.FREIGHT_COST]: 'Shipment Expenses',
  [ACCOUNT_KEYS.INVENTORY_ADJUSTMENT]: 'Stock Adjustments',
  [ACCOUNT_KEYS.EXPENSE_DEFAULT]: 'General Expenses',
  [ACCOUNT_KEYS.FX_GAIN_LOSS]: 'Exchange Gain / Loss',
  [ACCOUNT_KEYS.OPENING_BALANCE_EQUITY]: 'Opening Balances',
  [ACCOUNT_KEYS.RETAINED_EARNINGS]: 'Retained Earnings',
};

export type TrialBalanceAccountMeta = { systemKey: string | null };

/** The label the client sees for one account. */
export function clientLabel(row: Pick<TrialBalanceRow, 'name' | 'debitLocal' | 'creditLocal'>, meta?: TrialBalanceAccountMeta): string {
  const key = meta?.systemKey ?? null;
  /*
   * Money customers paid to a collection agent: the agent owes it to the
   * company while it is a debit, the company owes the agent once it is a
   * credit. The control account's name says neither.
   */
  if (key === ACCOUNT_KEYS.AGENT_CLEARING) {
    return row.creditLocal.greaterThan(row.debitLocal) ? 'Agent Payables' : 'Agent Receivables';
  }
  return (key && LABELS[key]) ?? row.name;
}

export type TrialBalanceLine = Omit<TrialBalanceRow, 'accountId' | 'code' | 'name'> & {
  key: string;
  label: string;
  /** The ledger accounts behind the line, so nothing is hidden by grouping. */
  accounts: Array<{ accountId: string; code: string; name: string }>;
};

const SUMMED = [
  'debitUsd',
  'creditUsd',
  'debitLocal',
  'creditLocal',
  'openingDebitUsd',
  'openingCreditUsd',
  'periodDebitUsd',
  'periodCreditUsd',
  'openingDebitLocal',
  'openingCreditLocal',
  'periodDebitLocal',
  'periodCreditLocal',
] as const satisfies ReadonlyArray<keyof TrialBalanceRow>;

/** One line per client label, in the ledger's own order of first appearance. */
export function groupForClient(rows: TrialBalanceRow[], meta: Map<string, TrialBalanceAccountMeta>): TrialBalanceLine[] {
  const lines = new Map<string, TrialBalanceLine>();
  for (const row of rows) {
    const label = clientLabel(row, meta.get(row.accountId));
    // Same label and same kind of account: an asset and a liability that
    // happen to share a word stay apart.
    const key = `${row.type}|${label}`;
    const line = lines.get(key);
    if (!line) {
      const fresh = { key, label, type: row.type, accounts: [{ accountId: row.accountId, code: row.code, name: row.name }] } as TrialBalanceLine;
      for (const field of SUMMED) fresh[field] = new Decimal(row[field]);
      lines.set(key, fresh);
      continue;
    }
    line.accounts.push({ accountId: row.accountId, code: row.code, name: row.name });
    for (const field of SUMMED) line[field] = line[field].plus(row[field]);
  }
  return [...lines.values()];
}
