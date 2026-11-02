import { describe, expect, it } from 'vitest';
import { transactionCurrencies } from '@/lib/company-currencies';
import { ledgerCurrencyTabs, isBookCurrency } from '@/lib/services/ledger';
import { parseLedgerViewCurrency } from '@/lib/ledger-currency';
import { taxRegimeFor } from '@/lib/services/tax';

describe('FID Pakistan: rupees and dollars', () => {
  it('trades in PKR and USD only, rupees first', () => {
    expect(transactionCurrencies('PKR')).toEqual(['PKR', 'USD']);
  });
  it('keeps Morocco and Dubai as they were', () => {
    expect(transactionCurrencies('MAD')).toEqual(['MAD', 'USD']);
    expect(transactionCurrencies('AED')).toEqual(['USD', 'AED', 'MAD']);
    expect(ledgerCurrencyTabs('MAD')).toEqual(['USD', 'MAD']);
    expect(ledgerCurrencyTabs('AED')).toEqual(['USD', 'AED', 'MAD']);
  });
  it('opens ledgers in USD and PKR', () => {
    expect(ledgerCurrencyTabs('PKR')).toEqual(['USD', 'PKR']);
    expect(isBookCurrency('PKR')).toBe(true);
    expect(parseLedgerViewCurrency('PKR')).toBe('PKR');
  });
  it('knows Pakistan sales tax, off until a registration number is entered', () => {
    expect(taxRegimeFor('Pakistan')).toMatchObject({ label: 'Sales Tax', standardRatePct: 18 });
  });
});
