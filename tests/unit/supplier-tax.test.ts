import { describe, expect, it } from 'vitest';
import { supplierGrossPayable, supplierInvoiceIncludesInputTax } from '@/lib/services/tax';

describe('supplierInvoiceIncludesInputTax', () => {
  it('treats the same country as a billed tax invoice', () => {
    expect(supplierInvoiceIncludesInputTax('Morocco', 'Morocco')).toBe(true);
    expect(supplierInvoiceIncludesInputTax('United Arab Emirates', 'Dubai')).toBe(true);
    expect(supplierInvoiceIncludesInputTax('Maroc', 'ma')).toBe(true);
  });

  it('does not put the buyer country tax on a foreign coffee exporter', () => {
    expect(supplierInvoiceIncludesInputTax('Uganda', 'Morocco')).toBe(false);
    expect(supplierInvoiceIncludesInputTax('Brazil', 'United Arab Emirates')).toBe(false);
    expect(supplierInvoiceIncludesInputTax('Ideal commodities uganda', 'Morocco')).toBe(false);
  });

  it('treats a missing country as foreign', () => {
    expect(supplierInvoiceIncludesInputTax('', 'Morocco')).toBe(false);
    expect(supplierInvoiceIncludesInputTax(null, 'Morocco')).toBe(false);
    expect(supplierInvoiceIncludesInputTax('Uganda', '')).toBe(false);
  });
});

describe('supplierGrossPayable', () => {
  it('is the contract value for a Ugandan supplier selling to Morocco', () => {
    const payable = supplierGrossPayable({
      netAmount: '166282.32',
      taxAmount: '33256.464',
      netAmountUsd: '166282.32',
      taxAmountUsd: '33256.464',
      vendorCountry: 'Uganda',
      companyCountry: 'Morocco',
    });
    expect(payable.taxOnSupplierInvoice).toBe(false);
    expect(payable.amount.toString()).toBe('166282.32');
    expect(payable.amountUsd.toString()).toBe('166282.32');
  });

  it('includes tax when a Moroccan supplier billed TVA', () => {
    const payable = supplierGrossPayable({
      netAmount: '100000',
      taxAmount: '20000',
      netAmountUsd: '10152.2843',
      taxAmountUsd: '2030.4569',
      vendorCountry: 'Morocco',
      companyCountry: 'Morocco',
    });
    expect(payable.taxOnSupplierInvoice).toBe(true);
    expect(payable.amount.toString()).toBe('120000');
    expect(payable.amountUsd.toString()).toBe('12182.7412');
  });
});
