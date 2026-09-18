import { describe, expect, it } from 'vitest';
import { shortDocumentNumber } from '@/lib/short-number';

/**
 * "Invoice eight", not "FID-MA-SI-000008". The sequence is the part anybody
 * says out loud; the rest is there so the database can tell two companies'
 * invoices apart.
 */
describe('the short form of a document number', () => {
  it('keeps the sequence and drops the machinery', () => {
    expect(shortDocumentNumber('FID-MA-SI-000008')).toBe('INV 8');
    expect(shortDocumentNumber('FID-DXB-SI-000123')).toBe('INV 123');
  });

  it('takes the prefix it is given', () => {
    expect(shortDocumentNumber('FID-MA-RV-000002', 'RCPT')).toBe('RCPT 2');
    expect(shortDocumentNumber('FID-MA-PV-000011', 'PAY')).toBe('PAY 11');
  });

  it('does not invent one when there is nothing to shorten', () => {
    expect(shortDocumentNumber(null)).toBe('—');
    expect(shortDocumentNumber('')).toBe('—');
    expect(shortDocumentNumber('ICUL/FID/002')).toBe('INV 2');
  });

  it('leaves a number with no sequence alone', () => {
    expect(shortDocumentNumber('DRAFT')).toBe('DRAFT');
  });

  it('keeps a genuine zero rather than showing nothing', () => {
    expect(shortDocumentNumber('FID-MA-SI-000000')).toBe('INV 0');
  });
});
