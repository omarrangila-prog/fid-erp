import { describe, expect, it } from 'vitest';
import { describeLedgerBalance } from '@/lib/ledger-meaning';

/**
 * The client opened the account they keep for Dubai, saw −50,000, and could
 * not tell whether that meant they owed Dubai or Dubai owed them. A ledger is
 * allowed to be signed; a summary shown to somebody who runs a coffee business
 * is not.
 */
describe('what a balance means', () => {
  it('reads a credit on a liability as money owed to them', () => {
    const m = describeLedgerBalance('-50000', 'LIABILITY', 'F I D TRADING LLC DUBAI');
    expect(m.label).toBe('Payable to F I D TRADING LLC DUBAI');
    expect(m.amount.toString()).toBe('50000');
    expect(m.normal).toBe(true);
    expect(m.sentence).toMatch(/company owes/i);
  });

  it('reads a debit on an asset as money they owe us', () => {
    const m = describeLedgerBalance('50000', 'ASSET', 'Loan to Karim');
    expect(m.label).toBe('Receivable from Loan to Karim');
    expect(m.amount.toString()).toBe('50000');
    expect(m.normal).toBe(true);
  });

  it('says so plainly when an account has gone the other way', () => {
    const m = describeLedgerBalance('-2000', 'ASSET', 'Ahmed');
    expect(m.label).toBe('Payable to Ahmed');
    expect(m.normal).toBe(false);
    expect(m.sentence).toMatch(/gone the other way/i);
  });

  it('calls an overpaid supplier what it is', () => {
    const m = describeLedgerBalance('300', 'LIABILITY', 'Ridwan');
    expect(m.label).toMatch(/Overpaid/);
    expect(m.normal).toBe(false);
  });

  it('never shows a negative figure', () => {
    for (const value of ['-1', '1', '-999999.99', '0']) {
      for (const type of ['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY'] as const) {
        const m = describeLedgerBalance(value, type, 'X');
        expect(m.amount.isNegative()).toBe(false);
      }
    }
  });

  it('says nothing is owed when the account is square', () => {
    const m = describeLedgerBalance('0', 'LIABILITY', 'Ahmed');
    expect(m.settled).toBe(true);
    expect(m.label).toBe('Settled');
    expect(m.sentence).toMatch(/Nothing is owed/i);
  });
});
