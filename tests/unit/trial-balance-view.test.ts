import { describe, expect, it } from 'vitest';
import { clientLabel, isUnusedInPeriod } from '@/lib/trial-balance-view';
import { dec } from '@/lib/money';
import type { TrialBalanceRow } from '@/lib/services/reports';

/**
 * The trial balance in the client's words — display only.
 *
 * The shape of the client's own books (15 Oct): an agent clearing control
 * with a credit balance, the stock and transit controls, accounts the client
 * named themselves, and two accounts on the same system key, as a currency
 * variant of a control would be.
 */

const row = (accountId: string, code: string, name: string, type: string, debit: string, credit: string): TrialBalanceRow => ({
  accountId,
  code,
  name,
  type,
  debitLocal: dec(debit),
  creditLocal: dec(credit),
  debitUsd: dec(debit).dividedBy(10),
  creditUsd: dec(credit).dividedBy(10),
  openingDebitUsd: dec(0),
  openingCreditUsd: dec(0),
  periodDebitUsd: dec(debit).dividedBy(10),
  periodCreditUsd: dec(credit).dividedBy(10),
  openingDebitLocal: dec(0),
  openingCreditLocal: dec(0),
  periodDebitLocal: dec(debit),
  periodCreditLocal: dec(credit),
});

const rows = [
  row('bank', '1002', 'ATIJJARI BANK (MAD)', 'ASSET', '3739099.17', '0'),
  row('ar', '1100', 'Accounts Receivable', 'ASSET', '1890920.00', '0'),
  row('agent', '1160', 'Agent Clearing — Collections Held', 'ASSET', '0', '220959.20'),
  row('stock', '1200', 'Inventory — Coffee Stock', 'ASSET', '7740740.71', '0'),
  row('ap', '2000', 'Accounts Payable', 'LIABILITY', '0', '12770522.62'),
  // A second account on the supplier control, in debit.
  row('ap2', '2001', 'Accounts Payable (USD)', 'LIABILITY', '5000.00', '0'),
  row('gift', '6500', 'GIFT EXP', 'EXPENSE', '3700.00', '0'),
  row('sales', '4000', 'Coffee Sales', 'INCOME', '0', '8713214.68'),
];
const meta = new Map<string, { systemKey: string | null }>([
  ['bank', { systemKey: null }],
  ['ar', { systemKey: 'ACCOUNTS_RECEIVABLE' }],
  ['agent', { systemKey: 'AGENT_CLEARING' }],
  ['stock', { systemKey: 'INVENTORY' }],
  ['ap', { systemKey: 'ACCOUNTS_PAYABLE' }],
  ['ap2', { systemKey: 'ACCOUNTS_PAYABLE' }],
  ['gift', { systemKey: null }],
  ['sales', { systemKey: 'SALES_REVENUE' }],
]);

describe('the trial balance in the client’s words', () => {
  it('gives technical system accounts plain names, by system key', () => {
    expect(clientLabel(rows[1], meta.get('ar'))).toBe('Customer Receivables');
    expect(clientLabel(rows[4], meta.get('ap'))).toBe('Supplier Payables');
    expect(clientLabel(rows[2], meta.get('agent'))).toBe('Customer Collections Held by Agents');
    expect(clientLabel({ name: 'Accrued Expenses' }, { systemKey: 'ACCRUED_EXPENSES' })).toBe('Unpaid Expenses');
  });

  it('never gives two different accounts the same name', () => {
    // Agent collections and agent commission are different money.
    expect(clientLabel({ name: 'Agent Commission Payable' }, { systemKey: 'AGENT_COMMISSION_PAYABLE' })).not.toBe(clientLabel(rows[2], meta.get('agent')));
    // Both supplier-control accounts keep a line each; names never merge lines.
    const labels = rows.map((r) => `${r.accountId}:${clientLabel(r, meta.get(r.accountId))}`);
    expect(new Set(labels).size).toBe(rows.length);
  });

  it('leaves the names that are already plain, and the names the client chose', () => {
    expect(clientLabel(rows[0], meta.get('bank'))).toBe('ATIJJARI BANK (MAD)');
    expect(clientLabel(rows[6], meta.get('gift'))).toBe('GIFT EXP');
    expect(clientLabel(rows[3], meta.get('stock'))).toBe('Inventory — Coffee Stock');
    expect(clientLabel(rows[7], meta.get('sales'))).toBe('Coffee Sales');
  });

  it('calls an account unused only with nothing brought forward, nothing moved and nothing left', () => {
    const blank = { ...row('x', '1', 'Prepayments', 'ASSET', '0', '0'), periodDebitLocal: dec(0), periodCreditLocal: dec(0), periodDebitUsd: dec(0), periodCreditUsd: dec(0) };
    expect(isUnusedInPeriod(blank)).toBe(true);
    // Moved in the period and back to nil: shown.
    expect(isUnusedInPeriod({ ...blank, periodDebitLocal: dec(100), periodCreditLocal: dec(100) })).toBe(false);
    // Brought forward, nothing new: shown.
    expect(isUnusedInPeriod({ ...blank, openingDebitLocal: dec(50), debitLocal: dec(50) })).toBe(false);
  });
});
