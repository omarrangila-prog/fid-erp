import { describe, it, expect } from 'vitest';
import { getInvoicePaymentStatus, isInvoiceOutstanding, paymentFilterOf, parsePaymentFilter } from '@/lib/invoice-payment';

/**
 * The client's rule: if any money is still due on an invoice it is Unpaid for
 * filtering, whatever its detailed status. The brief's own three invoices.
 */
const invoices = [
  { name: 'Invoice 1', total: '100000', paid: '0', outstanding: '100000', status: 'UNPAID' },
  { name: 'Invoice 2', total: '100000', paid: '40000', outstanding: '60000', status: 'PARTIAL' },
  { name: 'Invoice 3', total: '100000', paid: '100000', outstanding: '0', status: 'PAID' },
] as const;

describe('invoice payment status', () => {
  it('gives each invoice its detailed status from what is left to pay', () => {
    for (const inv of invoices) expect(getInvoicePaymentStatus(inv), inv.name).toBe(inv.status);
  });

  it('puts the unpaid and the part-paid under Unpaid, and only the settled under Paid', () => {
    const under = (filter: 'unpaid' | 'paid') => invoices.filter((i) => paymentFilterOf(i.outstanding) === filter).map((i) => i.name);
    expect(under('unpaid')).toEqual(['Invoice 1', 'Invoice 2']);
    expect(under('paid')).toEqual(['Invoice 3']);
  });

  it('never calls an invoice Paid because a payment exists while money is still due', () => {
    expect(getInvoicePaymentStatus({ paid: '25000', outstanding: '75000' })).toBe('PARTIAL');
    expect(paymentFilterOf('75000')).toBe('unpaid');
  });

  it('treats a rounding remainder as settled, and a real cent as owed', () => {
    expect(isInvoiceOutstanding('0.004')).toBe(false);
    expect(getInvoicePaymentStatus({ paid: '99999.996', outstanding: '0.004' })).toBe('PAID');
    expect(isInvoiceOutstanding('0.01')).toBe(true);
    // Overpaid is settled, not owing.
    expect(isInvoiceOutstanding('-5')).toBe(false);
  });

  it('reads a link as one of two filters; every older unpaid, partial or outstanding link means Unpaid', () => {
    expect(parsePaymentFilter({ paymentStatus: 'unpaid' })).toBe('unpaid');
    expect(parsePaymentFilter({ paymentStatus: 'paid' })).toBe('paid');
    expect(parsePaymentFilter({ standing: 'OUTSTANDING' })).toBe('unpaid');
    expect(parsePaymentFilter({ standing: 'PARTIAL' })).toBe('unpaid');
    expect(parsePaymentFilter({ standing: 'UNPAID' })).toBe('unpaid');
    expect(parsePaymentFilter({ standing: 'PAID' })).toBe('paid');
    expect(parsePaymentFilter({})).toBeNull();
    expect(parsePaymentFilter({ paymentStatus: 'done' })).toBeNull();
  });
});
