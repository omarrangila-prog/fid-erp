import { describe, expect, it } from 'vitest';
import { CURRENCIES, currencyDigits, currencyName, isCurrencyCode } from '@/lib/currencies';
import { transactionCurrencies, currencyOptions } from '@/lib/company-currencies';
import { toCurrencyScale } from '@/lib/money';

describe('the world currency table', () => {
  it('covers the major trading currencies of every region', () => {
    for (const code of ['USD', 'EUR', 'GBP', 'AED', 'SAR', 'PKR', 'INR', 'MAD', 'EGP', 'TRY', 'CNY', 'JPY', 'ZAR', 'NGN', 'KES', 'BRL', 'MXN', 'AUD', 'CAD', 'CHF']) {
      expect(isCurrencyCode(code), code).toBe(true);
    }
  });

  it('has unique three-letter codes', () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^[A-Z]{3}$/.test(c))).toBe(true);
    expect(codes.length).toBeGreaterThan(150);
  });

  it('knows each currency’s minor units', () => {
    expect(currencyDigits('USD')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('KWD')).toBe(3);
    expect(currencyDigits('XXX')).toBe(2);
    expect(toCurrencyScale('1234.5678', 'JPY').toString()).toBe('1235');
    expect(toCurrencyScale('1234.5678', 'KWD').toString()).toBe('1234.568');
  });

  it('names a currency, falling back to its code', () => {
    expect(currencyName('eur')).toBe('Euro');
    expect(currencyName('ZZZ')).toBe('ZZZ');
  });
});

describe('what a company is offered on its money forms', () => {
  it('keeps FID’s lists exactly as they were when nothing is configured', () => {
    expect(transactionCurrencies('MAD')).toEqual(['MAD', 'USD']);
    expect(transactionCurrencies('AED')).toEqual(['USD', 'AED', 'MAD']);
  });

  it('keeps FID’s lists when the migration’s explicit arrays are used', () => {
    expect(transactionCurrencies('MAD', null, ['MAD', 'USD'])).toEqual(['MAD', 'USD']);
    expect(transactionCurrencies('AED', null, ['USD', 'AED', 'MAD'])).toEqual(['USD', 'AED', 'MAD']);
  });

  it('serves a company anywhere: its own currency and the dollar by default', () => {
    expect(transactionCurrencies('EUR')).toEqual(['EUR', 'USD']);
    expect(transactionCurrencies('PKR')).toEqual(['PKR', 'USD']);
  });

  it('offers exactly what the company chose, plus its own currency', () => {
    expect(transactionCurrencies('GBP', null, ['USD', 'EUR'])).toEqual(['USD', 'EUR', 'GBP']);
  });

  it('still shows an old record’s currency that is no longer offered', () => {
    expect(transactionCurrencies('MAD', 'AED')).toEqual(['MAD', 'USD', 'AED']);
  });

  it('builds select options with names', () => {
    expect(currencyOptions('EUR')[0]).toEqual({ value: 'EUR', label: 'EUR — Euro' });
    expect(currencyOptions('EUR', { short: true })[1]).toEqual({ value: 'USD', label: 'USD' });
  });
});
