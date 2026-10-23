import { describe, expect, it } from 'vitest';
import { clientLabel, isUnusedInPeriod, isZeroAtClose } from '@/lib/trial-balance-view';
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

  it('leaves out an account with nothing left in the books\u2019 currency, whatever USD crumb remains', () => {
    // Inventory in Transit once everything has arrived.
    expect(isZeroAtClose({ debitLocal: dec(0), creditLocal: dec(0) })).toBe(true);
    expect(isZeroAtClose({ debitLocal: dec('0.01'), creditLocal: dec(0) })).toBe(false);
    expect(isZeroAtClose({ debitLocal: dec(0), creditLocal: dec(429640) })).toBe(false);
  });
});

describe('the operating expenses on one line', () => {
  it('adds them into one line and keeps the trial balance balanced', async () => {
    const { combineTrialRows } = await import('@/lib/trial-balance-view');
    const r = (accountId: string, code: string, debit: number, credit: number) => ({
      accountId, code, name: accountId, type: 'EXPENSE',
      debitLocal: dec(debit), creditLocal: dec(credit), debitUsd: dec(0), creditUsd: dec(0),
    });
    const report = {
      rows: [r('sales', '4000', 0, 11276.32), r('fuel', '5211', 350, 0), r('bank', '6103', 1156.32, 0), r('general', '6201', 9770, 0)],
      totals: { debitLocal: dec(11276.32), creditLocal: dec(11276.32), debitUsd: dec(0), creditUsd: dec(0) },
    };
    const out = combineTrialRows(report, new Set(['fuel', 'bank', 'general']), { accountId: 'op', name: 'Operating Expenses' });
    expect(out.rows.map((x) => x.accountId)).toEqual(['sales', 'op']);
    expect(out.rows[1].debitLocal.toFixed(2)).toBe('11276.32');
    expect(out.totals.debitLocal.toFixed(2)).toBe(out.totals.creditLocal.toFixed(2));
  });
});

describe('shipment expenses on the coffee sold, with the operating expenses', () => {
  it('moves them from Cost of Goods Sold to Operating Expenses without moving the totals', async () => {
    const { moveIntoOperating, OPERATING_ROW_ID } = await import('@/lib/trial-balance-view');
    const r = (accountId: string, code: string, debit: number, credit: number) => ({
      accountId, code, name: accountId, debitLocal: dec(debit), creditLocal: dec(credit), debitUsd: dec(0), creditUsd: dec(0),
    });
    const report = { rows: [r('sales', '4000', 0, 9000), r('cogs', '5000', 8000, 0), r(OPERATING_ROW_ID, '5211', 1000, 0)] };
    const out = moveIntoOperating(report, 'cogs', { local: dec(1500), usd: dec(0) });
    expect(out.rows.find((x) => x.accountId === 'cogs')!.debitLocal.toFixed(2)).toBe('6500.00');
    expect(out.rows.find((x) => x.accountId === OPERATING_ROW_ID)!.debitLocal.toFixed(2)).toBe('2500.00');
    const dr = out.rows.reduce((t, x) => t.plus(x.debitLocal), dec(0));
    expect(dr.toFixed(2)).toBe('9000.00');
  });
});
