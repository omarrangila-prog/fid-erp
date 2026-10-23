import { ACCOUNT_KEYS, REPORT_GROUPS } from '@/lib/constants';

/**
 * The Balance Sheet's headings, exactly as the client's requirements
 * document lists them (FID_Morocco_Accounting_and_Reporting_Requirements,
 * section 6), in its order.
 *
 * These are reporting groups. An account is placed under one by what it is —
 * its system role, whether it is a cash drawer, whether loans were posted to
 * it — never by matching its name, and no account is created to fill a
 * heading. A heading no account belongs to is shown empty.
 */
export const BALANCE_SHEET_GROUPS = {
  ASSET: [
    'Cash and bank balances',
    'Customer receivables',
    'Inventory/stock',
    'Supplier and other advances',
    'Deposits and prepayments',
    'Fixed assets',
    'Other assets',
  ],
  LIABILITY: [
    'Supplier payables',
    'Loans and financing',
    'Unpaid/accrued expenses',
    'Taxes payable',
    'Customer advances',
    'Related-party balances',
    'Other liabilities',
  ],
  EQUITY: ['Share capital', 'Owner/current accounts', 'Retained earnings', 'Current-year profit or loss', 'Other reserves'],
} as const;

export type BalanceSheetGroup =
  | (typeof BALANCE_SHEET_GROUPS.ASSET)[number]
  | (typeof BALANCE_SHEET_GROUPS.LIABILITY)[number]
  | (typeof BALANCE_SHEET_GROUPS.EQUITY)[number];

/**
 * The heads the chart template seeds for these very groups (Prepayments,
 * Deposits Paid, Related Party Balances, Share Capital…), by their template
 * code — the chart's own numbering, not a guess from a name.
 */
const TEMPLATE_HEADS: Record<string, BalanceSheetGroup> = {
  '1400': 'Deposits and prepayments',
  '1450': 'Deposits and prepayments',
  '1500': 'Supplier and other advances',
  '1800': 'Fixed assets',
  '1850': 'Fixed assets',
  '1900': 'Other assets',
  '2300': 'Other liabilities',
  '2400': 'Related-party balances',
  '2500': 'Loans and financing',
  '3050': 'Share capital',
  '3060': 'Owner/current accounts',
  '3200': 'Other reserves',
};

export type BalanceSheetAccountFacts = {
  code?: string;
  type: string;
  reportGroup: string | null;
  systemKey: string | null;
  /** A cash drawer or bank account is kept on it. */
  isCashBank: boolean;
  /** Loans were posted to it (the loan forms, or a "Loan from / Loan to" account). */
  isLoan: boolean;
  /** Carries an entry posted in both FID companies at once: a balance with the other company. */
  isRelatedParty: boolean;
};

/**
 * Where one account sits. The choices the document leaves open, made here
 * once so every screen agrees:
 * - money customers paid to an agent and the agent still holds is "Other
 *   assets" (it is owed by the agent, not by a customer);
 * - a loan FID gave, to the other company or anyone else, is an advance;
 * - commission owed to an agent is an unpaid expense;
 * - opening-balance equity is part of retained earnings brought forward.
 */
export function balanceSheetGroup(a: BalanceSheetAccountFacts): BalanceSheetGroup {
  const key = a.systemKey;
  const head = !key && a.code ? TEMPLATE_HEADS[a.code] : undefined;
  if (head) return head;
  if (a.type === 'ASSET') {
    if (a.isCashBank || key === ACCOUNT_KEYS.CHEQUES_ON_HAND) return 'Cash and bank balances';
    if (key === ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE) return 'Customer receivables';
    if (key === ACCOUNT_KEYS.INVENTORY || key === ACCOUNT_KEYS.INVENTORY_IN_TRANSIT) return 'Inventory/stock';
    if (key === ACCOUNT_KEYS.SUPPLIER_ADVANCES || key === ACCOUNT_KEYS.INTERCOMPANY_LOAN_RECEIVABLE || a.isLoan || a.isRelatedParty) {
      return 'Supplier and other advances';
    }
    if (a.reportGroup === REPORT_GROUPS.NON_CURRENT_ASSET) return 'Fixed assets';
    return 'Other assets';
  }
  if (a.type === 'LIABILITY') {
    if (key === ACCOUNT_KEYS.ACCOUNTS_PAYABLE) return 'Supplier payables';
    if (key === ACCOUNT_KEYS.INTERCOMPANY_LOAN_PAYABLE || a.isRelatedParty) return 'Related-party balances';
    if (a.isLoan || a.reportGroup === REPORT_GROUPS.NON_CURRENT_LIABILITY) return 'Loans and financing';
    if (key === ACCOUNT_KEYS.ACCRUED_EXPENSES || key === ACCOUNT_KEYS.AGENT_COMMISSION_PAYABLE) return 'Unpaid/accrued expenses';
    if (key === ACCOUNT_KEYS.VAT_OUTPUT) return 'Taxes payable';
    if (key === ACCOUNT_KEYS.CUSTOMER_ADVANCES) return 'Customer advances';
    return 'Other liabilities';
  }
  if (key === ACCOUNT_KEYS.RETAINED_EARNINGS || key === ACCOUNT_KEYS.OPENING_BALANCE_EQUITY) return 'Retained earnings';
  return 'Other reserves';
}
