import { ACCOUNT_KEYS, REPORT_GROUPS } from '@/lib/constants';

/**
 * The Balance Sheet's headings, exactly as the client's "Accounting Reports &
 * Rules" document lists them (section 4, Balance Sheet), in its order.
 *
 * These are reporting groups. An account is placed under one by what it is —
 * its system role, whether it is a cash drawer, whether loans were posted to
 * it — never by matching its name, and no account is created to fill a
 * heading. A heading no account belongs to is shown empty.
 */
export const BALANCE_SHEET_GROUPS = {
  ASSET: [
    'Cash and bank balances',
    'Accounts Receivable - customers who owe us',
    'Inventory / unsold coffee stock',
    'Advances and deposits paid',
    'Fixed assets, if any',
  ],
  LIABILITY: [
    'Accounts Payable - suppliers we owe',
    'Unpaid freight, warehouse, and other bills',
    'Customer advances received',
    'Loans and other liabilities',
  ],
  EQUITY: ["Owner's capital", 'Retained earnings / accumulated profit or loss', 'Current year profit or loss'],
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
  '1400': 'Advances and deposits paid',
  '1450': 'Advances and deposits paid',
  '1500': 'Advances and deposits paid',
  '1800': 'Fixed assets, if any',
  '1850': 'Fixed assets, if any',
  '1900': 'Advances and deposits paid',
  '2300': 'Loans and other liabilities',
  '2400': 'Loans and other liabilities',
  '2500': 'Loans and other liabilities',
  '3050': "Owner's capital",
  '3060': "Owner's capital",
  '3200': "Owner's capital",
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
 * Where one account sits. The document has no "other" heading, so every
 * account takes the nearest one it names, made here once so every screen
 * agrees:
 * - money customers paid to an agent and the agent still holds is still to
 *   come in from customers' sales, so it sits with Accounts Receivable;
 * - a loan FID gave, a trip advance, any other asset is an advance paid;
 * - commission owed to an agent and VAT owed are bills still to pay;
 * - loans received, the other company and any other liability are "Loans
 *   and other liabilities";
 * - share capital, owner's current account and reserves are owner's capital;
 * - opening-balance equity is part of retained earnings brought forward.
 */
export function balanceSheetGroup(a: BalanceSheetAccountFacts): BalanceSheetGroup {
  const key = a.systemKey;
  const head = !key && a.code ? TEMPLATE_HEADS[a.code] : undefined;
  if (head) return head;
  if (a.type === 'ASSET') {
    if (a.isCashBank || key === ACCOUNT_KEYS.CHEQUES_ON_HAND) return 'Cash and bank balances';
    if (key === ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE || key === ACCOUNT_KEYS.AGENT_CLEARING) return 'Accounts Receivable - customers who owe us';
    if (key === ACCOUNT_KEYS.INVENTORY || key === ACCOUNT_KEYS.INVENTORY_IN_TRANSIT) return 'Inventory / unsold coffee stock';
    if (a.reportGroup === REPORT_GROUPS.NON_CURRENT_ASSET && !a.isLoan && !a.isRelatedParty) return 'Fixed assets, if any';
    return 'Advances and deposits paid';
  }
  if (a.type === 'LIABILITY') {
    if (key === ACCOUNT_KEYS.ACCOUNTS_PAYABLE) return 'Accounts Payable - suppliers we owe';
    if (key === ACCOUNT_KEYS.CUSTOMER_ADVANCES) return 'Customer advances received';
    if (key === ACCOUNT_KEYS.INTERCOMPANY_LOAN_PAYABLE || a.isRelatedParty || a.isLoan) return 'Loans and other liabilities';
    if (key === ACCOUNT_KEYS.ACCRUED_EXPENSES || key === ACCOUNT_KEYS.AGENT_COMMISSION_PAYABLE || key === ACCOUNT_KEYS.VAT_OUTPUT) {
      return 'Unpaid freight, warehouse, and other bills';
    }
    return 'Loans and other liabilities';
  }
  if (key === ACCOUNT_KEYS.RETAINED_EARNINGS || key === ACCOUNT_KEYS.OPENING_BALANCE_EQUITY) return 'Retained earnings / accumulated profit or loss';
  return "Owner's capital";
}
