import { describe, expect, it } from 'vitest';
import { journalSourceEditHref, journalSourceHref } from '@/lib/journal-source';

describe('journalSourceHref', () => {
  it('opens the expense voucher, not a derived ledger line', () => {
    expect(journalSourceHref('EXPENSE', 'exp_1')).toBe('/finance/expenses/exp_1');
    expect(journalSourceEditHref('EXPENSE', 'exp_1')).toBe('/finance/expenses/exp_1/edit');
  });

  it('opens sales, purchases and cash documents from their source ids', () => {
    expect(journalSourceHref('SALES_INVOICE', 'inv_1')).toBe('/sales/inv_1');
    expect(journalSourceHref('PURCHASE_CONTRACT', 'po_1')).toBe('/purchases/po_1');
    expect(journalSourceHref('RECEIPT', 'rc_1')).toBe('/finance/receipts/rc_1');
    expect(journalSourceHref('PAYMENT', 'py_1')).toBe('/finance/payments/py_1');
  });

  it('falls back to the journal for a manual cash/bank transfer', () => {
    expect(journalSourceHref('MANUAL', 'XFER-1', { entryNumber: 'JV-9' })).toBe('/reports/journal?q=JV-9');
  });
});
