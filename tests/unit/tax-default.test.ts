import { describe, expect, it } from 'vitest';
import { preferZeroRateTax } from '@/lib/tax-default';

describe('preferZeroRateTax', () => {
  it('picks EXEMPT ahead of a 20% standard rate', () => {
    const chosen = preferZeroRateTax([
      { id: 'std', code: 'STD', ratePct: '20' },
      { id: 'exempt', code: 'EXEMPT', ratePct: '0' },
    ]);
    expect(chosen?.id).toBe('exempt');
  });

  it('falls back to any zero-rate code when EXEMPT is missing', () => {
    const chosen = preferZeroRateTax([
      { id: 'std', code: 'STD', ratePct: '20' },
      { id: 'zero', code: 'ZERO', ratePct: '0' },
    ]);
    expect(chosen?.id).toBe('zero');
  });
});
