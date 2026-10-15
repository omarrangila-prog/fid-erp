import { describe, expect, it } from 'vitest';
import { clientLabel, groupForClient } from '@/lib/trial-balance-view';
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

const total = (list: Array<Pick<TrialBalanceRow, 'debitLocal' | 'creditLocal' | 'debitUsd' | 'creditUsd'>>) => ({
  debitLocal: list.reduce((t, r) => t.plus(r.debitLocal), dec(0)).toFixed(4),
  creditLocal: list.reduce((t, r) => t.plus(r.creditLocal), dec(0)).toFixed(4),
  debitUsd: list.reduce((t, r) => t.plus(r.debitUsd), dec(0)).toFixed(4),
  creditUsd: list.reduce((t, r) => t.plus(r.creditUsd), dec(0)).toFixed(4),
});

describe('the trial balance in the client’s words', () => {
  it('names system accounts plainly, by system key', () => {
    expect(clientLabel(rows[1], meta.get('ar'))).toBe('Customer Receivables');
    expect(clientLabel(rows[3], meta.get('stock'))).toBe('Inventory');
    expect(clientLabel(rows[4], meta.get('ap'))).toBe('Supplier Payables');
    expect(clientLabel(rows[7], meta.get('sales'))).toBe('Sales');
  });

  it('reads the agent control by its side: owed to the agent when in credit', () => {
    expect(clientLabel(rows[2], meta.get('agent'))).toBe('Agent Payables');
    expect(clientLabel({ ...rows[2], debitLocal: dec(500), creditLocal: dec(0) }, meta.get('agent'))).toBe('Agent Receivables');
  });

  it('leaves the names the client chose', () => {
    expect(clientLabel(rows[0], meta.get('bank'))).toBe('ATIJJARI BANK (MAD)');
    expect(clientLabel(rows[6], meta.get('gift'))).toBe('GIFT EXP');
  });

  it('puts accounts meaning the same thing on one line, naming every account behind it', () => {
    const lines = groupForClient(rows, meta);
    const payables = lines.find((l) => l.label === 'Supplier Payables')!;
    expect(payables.accounts.map((a) => a.code)).toEqual(['2000', '2001']);
    // Debits and credits added separately, not netted.
    expect(payables.creditLocal.toFixed(2)).toBe('12770522.62');
    expect(payables.debitLocal.toFixed(2)).toBe('5000.00');
    expect(lines).toHaveLength(rows.length - 1);
  });

  it('never moves a total: the grouped report is the ledger to the cent', () => {
    expect(total(groupForClient(rows, meta))).toEqual(total(rows));
  });

  it('keeps an asset and a liability apart even if they share a label', () => {
    const odd = [row('x', '1', 'Suspense', 'ASSET', '10', '0'), row('y', '2', 'Suspense', 'LIABILITY', '0', '10')];
    const lines = groupForClient(odd, new Map());
    expect(lines).toHaveLength(2);
  });
});
