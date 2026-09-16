import type { AccountType } from '@prisma/client';
import { REPORT_GROUPS } from '@/lib/constants';

/**
 * Simple buckets on the journal "Add account" dialog.
 *
 * The chart still stores ASSET / LIABILITY / … — these labels are what a
 * person picking "Ahmed" as a current account should see, not the statutory
 * type. Personal / loan / other-asset heads land on the Balance Sheet, never
 * the Profit & Loss, so lending Ahmed money does not look like an expense.
 */

export const JOURNAL_ACCOUNT_KINDS = [
  {
    value: 'PERSONAL',
    label: 'Personal / Current Account',
    hint: 'One ledger that can go either way — Ahmed owes us, or we owe Ahmed.',
    type: 'ASSET' as AccountType,
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    series: 1400,
  },
  {
    value: 'LOAN',
    label: 'Loan / Advance',
    hint: 'Money given or received to be repaid. Balance sheet, not profit.',
    type: 'ASSET' as AccountType,
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    series: 1500,
  },
  {
    value: 'CASH_BANK',
    label: 'Cash / Bank',
    hint: 'A cash or bank head for journal entries.',
    type: 'ASSET' as AccountType,
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    series: 1180,
  },
  {
    value: 'CUSTOMER',
    label: 'Customer / Receivable',
    hint: 'Money a customer owes. Prefer the customer master for ordinary sales.',
    type: 'ASSET' as AccountType,
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    series: 1190,
  },
  {
    value: 'SUPPLIER',
    label: 'Supplier / Payable',
    hint: 'Money owed to a supplier. Prefer the supplier master for ordinary purchases.',
    type: 'LIABILITY' as AccountType,
    reportGroup: REPORT_GROUPS.CURRENT_LIABILITY,
    series: 2200,
  },
  {
    value: 'OTHER_ASSET',
    label: 'Other Asset',
    hint: 'A named asset on the balance sheet.',
    type: 'ASSET' as AccountType,
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    series: 1600,
  },
  {
    value: 'OTHER_LIABILITY',
    label: 'Other Liability',
    hint: 'A named liability on the balance sheet.',
    type: 'LIABILITY' as AccountType,
    reportGroup: REPORT_GROUPS.CURRENT_LIABILITY,
    series: 2300,
  },
  {
    value: 'INCOME',
    label: 'Income',
    hint: 'Goes to the Profit & Loss as income.',
    type: 'INCOME' as AccountType,
    reportGroup: REPORT_GROUPS.OTHER_INCOME,
    series: 4500,
  },
  {
    value: 'EXPENSE',
    label: 'Expense',
    hint: 'Goes to the Profit & Loss as an expense.',
    type: 'EXPENSE' as AccountType,
    reportGroup: REPORT_GROUPS.OPERATING,
    series: 6500,
  },
  {
    value: 'EQUITY',
    label: 'Equity',
    hint: 'Owners’ funds on the balance sheet.',
    type: 'EQUITY' as AccountType,
    reportGroup: REPORT_GROUPS.EQUITY,
    series: 3200,
  },
  {
    value: 'OTHER',
    label: 'Other',
    hint: 'Use when none of the types above fit.',
    type: 'ASSET' as AccountType,
    reportGroup: REPORT_GROUPS.CURRENT_ASSET,
    series: 1900,
  },
] as const;

export type JournalAccountKind = (typeof JOURNAL_ACCOUNT_KINDS)[number]['value'];

export function resolveJournalAccountKind(kind: string) {
  const found = JOURNAL_ACCOUNT_KINDS.find((option) => option.value === kind);
  if (!found) return null;
  return found;
}
