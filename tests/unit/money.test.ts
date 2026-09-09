import { describe, it, expect } from 'vitest';
import {
  dec,
  toMoney,
  convertToUsd,
  convertFromUsd,
  convertToLocal,
  quantityToKg,
  kgToUnit,
  unitPriceToPricePerKg,
  allocateProportionally,
  percentage,
  sum,
} from '@/lib/money';

describe('unit conversion', () => {
  it('converts metric tons to the canonical kilogram', () => {
    expect(quantityToKg('100', 'MT').toString()).toBe('100000');
    expect(quantityToKg('100', 'KG').toString()).toBe('100');
    expect(quantityToKg('12.5', 'MT').toString()).toBe('12500');
  });

  it('round-trips kilograms back to tons', () => {
    expect(kgToUnit('100000', 'MT').toString()).toBe('100');
    expect(kgToUnit('1500', 'MT').toString()).toBe('1.5');
  });

  it('restates a per-ton price as a per-kilogram price', () => {
    expect(unitPriceToPricePerKg('900', 'MT').toString()).toBe('0.9');
    expect(unitPriceToPricePerKg('0.9', 'KG').toString()).toBe('0.9');
  });
});

describe('currency conversion', () => {
  it('converts AED to USD using the "units per 1 USD" convention', () => {
    // The worked example from the specification: AED 100,000 at 3.678.
    expect(convertToUsd('100000', '3.678', 'AED').toString()).toBe('27188.6895');
  });

  it('treats USD as an identity regardless of the rate supplied', () => {
    expect(convertToUsd('100000', '3.678', 'USD').toString()).toBe('100000');
    expect(convertFromUsd('12345.67', '9.85', 'USD').toString()).toBe('12345.67');
  });

  it('converts USD back into a local currency', () => {
    // 27,188.6895 x 3.678 = 99,999.999981, which rounds back to the original.
    expect(convertFromUsd('27188.6895', '3.678', 'AED').toString()).toBe('100000');
  });

  it('does not route a local-currency amount through USD and back', () => {
    // Short-circuiting guarantees the original amount survives untouched even
    // where the USD round trip would not land exactly back on it.
    const local = convertToLocal({
      amount: '100000',
      currency: 'AED',
      rateToUsd: '3.678',
      localCurrency: 'AED',
      rateLocalPerUsd: '3.678',
    });
    expect(local.toString()).toBe('100000');
  });

  it('rejects a zero or negative rate', () => {
    expect(() => convertToUsd('100', '0', 'AED')).toThrow(/greater than zero/);
    expect(() => convertToUsd('100', '-1', 'AED')).toThrow(/greater than zero/);
  });

  it('keeps full precision instead of drifting like binary floating point', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
    expect(toMoney(dec('0.1').plus(dec('0.2'))).toString()).toBe('0.3');
    expect(sum(['0.1', '0.2', '0.3']).toString()).toBe('0.6');
  });
});

describe('proportional allocation', () => {
  it('splits freight in proportion to line value', () => {
    const result = allocateProportionally('1000', ['3000', '1000']);
    expect(result.map(String)).toEqual(['750', '250']);
  });

  it('never loses or invents money when the split does not divide evenly', () => {
    const total = '100';
    const parts = allocateProportionally(total, ['1', '1', '1']);
    expect(sum(parts).toString()).toBe('100');
    // The rounding remainder lands on one line rather than vanishing.
    expect(parts.map(String).sort()).toEqual(['33.3333', '33.3333', '33.3334'].sort());
  });

  it('splits evenly when there are no meaningful weights', () => {
    const parts = allocateProportionally('90', ['0', '0', '0']);
    expect(sum(parts).toString()).toBe('90');
  });

  it('returns zeros for a zero total', () => {
    expect(allocateProportionally('0', ['5', '5']).map(String)).toEqual(['0', '0']);
  });
});

describe('percentage', () => {
  it('computes a margin', () => {
    expect(percentage('25', '100').toString()).toBe('25');
  });

  it('returns zero rather than NaN when the base is zero', () => {
    expect(percentage('25', '0').toString()).toBe('0');
  });
});
