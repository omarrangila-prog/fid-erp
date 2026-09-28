import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { windowLedger, LEDGER_WINDOW_ROWS } from '@/lib/ledger-window';

/**
 * A long ledger sends only its latest entries to the browser, and nothing
 * about the figures changes: what is not sent is brought forward, and the
 * period's opening, totals and closing are worked out over every entry.
 */

// 1,200 entries over 1,200 days: 100.10 in every day, 40.05 out every third.
function ledger(opening = '1000') {
  let balance = new Decimal(opening);
  const start = Date.UTC(2023, 0, 1);
  return Array.from({ length: 1200 }, (_, i) => {
    const debit = new Decimal('100.10');
    const credit = i % 3 === 0 ? new Decimal('40.05') : new Decimal(0);
    balance = balance.plus(debit).minus(credit);
    return {
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      debit: debit.toString(),
      credit: credit.toString(),
      balance: balance.toString(),
    };
  });
}

describe('sending a long ledger to a phone', () => {
  it('sends the latest entries only, with the rest brought forward', () => {
    const rows = ledger();
    const { rows: sent, opening, window } = windowLedger(rows, '1000');
    expect(sent).toHaveLength(LEDGER_WINDOW_ROWS);
    expect(sent[sent.length - 1]).toBe(rows[rows.length - 1]);
    expect(window).toMatchObject({ total: 1200, sent: LEDGER_WINDOW_ROWS, trimmed: true, opening: '1000' });
    // Brought forward is the balance just before the first row sent.
    expect(opening).toBe(rows[1200 - LEDGER_WINDOW_ROWS - 1].balance);
    // And the brought-forward balance plus what was sent comes to the closing balance, to the cent.
    const moved = sent.reduce((t, r) => t.plus(r.debit).minus(r.credit), new Decimal(0));
    expect(new Decimal(opening).plus(moved).toString()).toBe(window.closing);
  });

  it('works out the period totals over every entry, not only those sent', () => {
    const { window } = windowLedger(ledger(), '1000');
    expect(new Decimal(window.totalDebit).equals(new Decimal('100.10').times(1200))).toBe(true);
    expect(new Decimal(window.totalCredit).equals(new Decimal('40.05').times(400))).toBe(true);
    expect(new Decimal(window.opening).plus(window.totalDebit).minus(window.totalCredit).equals(new Decimal(window.closing))).toBe(true);
  });

  it('cuts to the dates asked for first: the opening is the balance before them', () => {
    const rows = ledger();
    const { rows: sent, opening, window } = windowLedger(rows, '1000', { from: '2024-01-01', to: '2024-03-31' });
    expect(window.trimmed).toBe(false);
    expect(sent.every((r) => r.date >= '2024-01-01' && r.date <= '2024-03-31')).toBe(true);
    expect(sent).toHaveLength(91);
    const before = rows.filter((r) => r.date < '2024-01-01');
    expect(opening).toBe(before[before.length - 1].balance);
    expect(window.opening).toBe(opening);
    expect(window.closing).toBe(sent[sent.length - 1].balance);
  });

  it('a short ledger is sent whole, and nonsense dates are ignored', () => {
    const rows = ledger().slice(0, 20);
    const { rows: sent, window } = windowLedger(rows, '1000', { from: 'not-a-date' });
    expect(sent).toHaveLength(20);
    expect(window.trimmed).toBe(false);
    expect(window.from).toBeUndefined();
  });

  it('dates with nothing in them keep the balance where it stood', () => {
    const rows = ledger();
    const { rows: sent, window } = windowLedger(rows, '1000', { from: '2030-01-01' });
    expect(sent).toHaveLength(0);
    expect(window.opening).toBe(rows[rows.length - 1].balance);
    expect(window.closing).toBe(window.opening);
  });
});
