import { describe, expect, it } from 'vitest';
import {
  formatSalesInvoiceNumber,
  nextSequenceNumber,
  normalizeSalesInvoiceNumber,
  parseSalesInvoiceSequence,
} from '@/lib/services/numbering';

describe('nextSequenceNumber', () => {
  it('starts at 1 when nothing is occupied', () => {
    expect(nextSequenceNumber([])).toBe(1);
  });

  it('issues the next number after a contiguous run', () => {
    expect(nextSequenceNumber([1, 2, 3, 4])).toBe(5);
  });

  it('reuses a deleted number instead of skipping past it', () => {
    expect(nextSequenceNumber([1, 2, 3, 4])).toBe(5);
    expect(nextSequenceNumber([1, 2, 3, 4, 6])).toBe(5);
  });

  it('fills the first gap, not the number after the highest', () => {
    expect(nextSequenceNumber([1, 2, 4])).toBe(3);
  });
});

describe('sales invoice number formatting', () => {
  it('pads a sequential number to six digits', () => {
    expect(formatSalesInvoiceNumber('FID-DXB', 5)).toBe('FID-DXB-SI-000005');
    expect(parseSalesInvoiceSequence('FID-DXB', 'FID-DXB-SI-000005')).toBe(5);
  });

  it('accepts 5, 005 or SI-5 as the same document number', () => {
    expect(normalizeSalesInvoiceNumber('FID-MA', '5')).toBe('FID-MA-SI-000005');
    expect(normalizeSalesInvoiceNumber('FID-MA', '005')).toBe('FID-MA-SI-000005');
    expect(normalizeSalesInvoiceNumber('FID-MA', 'SI-5')).toBe('FID-MA-SI-000005');
    expect(normalizeSalesInvoiceNumber('FID-MA', 'FID-MA-SI-5')).toBe('FID-MA-SI-000005');
  });

  it('keeps a fully formed number as typed', () => {
    expect(normalizeSalesInvoiceNumber('FID-DXB', 'FID-DXB-SI-000004')).toBe('FID-DXB-SI-000004');
  });
});
