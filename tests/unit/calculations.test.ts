import { describe, it, expect } from 'vitest';
import { computePurchaseTotals } from '@/lib/services/purchase';
import { computeSalesLine } from '@/lib/services/sales';
import { assertTransitionAllowed, assertStatusDataComplete } from '@/lib/services/shipment';
import { bucketFor } from '@/lib/services/receivables';
import { resolveSubledgerLeg } from '@/lib/services/subledger';
import { sum } from '@/lib/money';

describe('purchase contract totals', () => {
  const base = {
    currency: 'USD',
    rateToUsd: '1',
    lines: [
      {
        itemId: 'item-1',
        lotNumber: 'BR-001',
        batchNumber: 'B001',
        quantity: '100',
        unit: 'MT' as const,
        unitPrice: '900',
      },
    ],
  };

  it('computes subtotal, freight and landed cost per kilogram', () => {
    const totals = computePurchaseTotals({ ...base, freightAmount: '5000' });

    expect(totals.subtotal.toString()).toBe('90000');
    expect(totals.totalValue.toString()).toBe('95000');
    expect(totals.totalQuantityKg.toString()).toBe('100000');
    // Freight is folded into the cost of a kilogram: 95,000 / 100,000.
    expect(totals.lines[0].unitCostKg.toString()).toBe('0.95');
  });

  it('allows zero freight', () => {
    const totals = computePurchaseTotals({ ...base, freightAmount: '0' });
    expect(totals.totalValue.toString()).toBe('90000');
    expect(totals.lines[0].unitCostKg.toString()).toBe('0.9');
  });

  it('spreads freight across lines by value and keeps the total exact', () => {
    const totals = computePurchaseTotals({
      currency: 'USD',
      rateToUsd: '1',
      freightAmount: '1000',
      lines: [
        { itemId: 'a', lotNumber: 'L1', batchNumber: 'B1', quantity: '30', unit: 'MT', unitPrice: '1000' },
        { itemId: 'b', lotNumber: 'L2', batchNumber: 'B2', quantity: '10', unit: 'MT', unitPrice: '1000' },
      ],
    });

    expect(totals.lines.map((l) => l.freightAllocated.toString())).toEqual(['750', '250']);
    expect(sum(totals.lines.map((l) => l.lineTotal)).toString()).toBe(totals.totalValue.toString());
  });

  it('converts the contract value to USD when priced in another currency', () => {
    const totals = computePurchaseTotals({
      currency: 'AED',
      rateToUsd: '3.678',
      freightAmount: '0',
      lines: [{ itemId: 'a', lotNumber: 'L1', batchNumber: 'B1', quantity: '1', unit: 'KG', unitPrice: '3678' }],
    });
    expect(totals.totalValueUsd.toString()).toBe('1000');
  });

  it('rejects an empty contract, a zero quantity and negative freight', () => {
    expect(() => computePurchaseTotals({ ...base, lines: [], freightAmount: '0' })).toThrow(/at least one line/);
    expect(() =>
      computePurchaseTotals({
        ...base,
        freightAmount: '0',
        lines: [{ itemId: 'a', lotNumber: 'L1', batchNumber: 'B1', quantity: '0', unit: 'MT', unitPrice: '900' }],
      }),
    ).toThrow(/greater than zero/);
    expect(() => computePurchaseTotals({ ...base, freightAmount: '-1' })).toThrow(/negative/);
  });
});

describe('sales line calculation', () => {
  it('computes line value and its USD equivalent', () => {
    const line = computeSalesLine({ quantity: '20', unit: 'MT', unitPrice: '1100', currency: 'USD', rateToUsd: '1' });
    expect(line.quantityKg.toString()).toBe('20000');
    expect(line.lineTotal.toString()).toBe('22000');
    expect(line.unitPriceKg.toString()).toBe('1.1');
  });

  it('converts a MAD sale to USD', () => {
    const line = computeSalesLine({ quantity: '10', unit: 'MT', unitPrice: '9850', currency: 'MAD', rateToUsd: '9.85' });
    expect(line.lineTotal.toString()).toBe('98500');
    expect(line.lineTotalUsd.toString()).toBe('10000');
  });

  it('rejects a zero quantity and a negative price', () => {
    expect(() => computeSalesLine({ quantity: '0', unit: 'MT', unitPrice: '1', currency: 'USD', rateToUsd: '1' })).toThrow();
    expect(() => computeSalesLine({ quantity: '1', unit: 'MT', unitPrice: '-1', currency: 'USD', rateToUsd: '1' })).toThrow();
  });
});

describe('shipment status rules', () => {
  /*
   * Three steps, because three is what the business tracks:
   *
   *   Pending Loading → Loaded → Arrived
   *
   * and then the goods receipt, which is a document rather than a status. The
   * client was explicit that booked, in transit, customs clearing, cleared and
   * delivered were stages nobody updated and everybody scrolled past — and a
   * status somebody has to maintain and nobody reads makes the ones that
   * matter look unreliable too.
   */
  it('permits the whole forward path, which is now three steps', () => {
    expect(() => assertTransitionAllowed('CONTRACT_CREATED', 'LOADED')).not.toThrow();
    expect(() => assertTransitionAllowed('LOADED', 'ARRIVED')).not.toThrow();
  });

  it('allows one step back, so a mis-click can be undone', () => {
    expect(() => assertTransitionAllowed('LOADED', 'CONTRACT_CREATED')).not.toThrow();
    expect(() => assertTransitionAllowed('ARRIVED', 'LOADED')).not.toThrow();
  });

  it('still refuses to skip loading', () => {
    expect(() => assertTransitionAllowed('CONTRACT_CREATED', 'ARRIVED')).toThrow(/cannot move directly/);
  });

  it('leaves a consignment recorded under an old status a way forward', () => {
    // The removed values stay in the database; anything sitting in one can
    // still be moved on rather than being stuck with no exit.
    expect(() => assertTransitionAllowed('IN_TRANSIT', 'ARRIVED')).not.toThrow();
    expect(() => assertTransitionAllowed('AWAITING_LOADING', 'LOADED')).not.toThrow();
  });

  it('refuses a no-op transition', () => {
    expect(() => assertTransitionAllowed('LOADED', 'LOADED')).toThrow(/already in that status/);
  });

  it('will not mark a shipment loaded without a carrier and an arrival date', () => {
    // Who is carrying it and when it lands: the two things the loading sheet
    // is read to find out. The vessel name, the voyage and the ETD used to be
    // required as well, and a consignment nobody could mark loaded because the
    // vessel was not named yet is a status that stays wrong.
    expect(() => assertStatusDataComplete('LOADED', { loadingDate: new Date() })).toThrow(
      /Shipping Line, ETA/,
    );
    expect(() =>
      assertStatusDataComplete('LOADED', {
        loadingDate: new Date(),
        shippingLineId: 'sl-1',
        etaDate: new Date(),
      }),
    ).not.toThrow();
  });

  it('requires an actual arrival date on arrival', () => {
    expect(() => assertStatusDataComplete('ARRIVED', {})).toThrow(/Actual Arrival Date/);
  });
});

describe('ageing buckets', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  it('classifies by how long a due date has passed', () => {
    expect(bucketFor(null)).toBe('CURRENT');
    expect(bucketFor(new Date(Date.now() + 86_400_000))).toBe('CURRENT');
    expect(bucketFor(daysAgo(10))).toBe('D1_30');
    expect(bucketFor(daysAgo(45))).toBe('D31_60');
    expect(bucketFor(daysAgo(75))).toBe('D61_90');
    expect(bucketFor(daysAgo(200))).toBe('D90_PLUS');
  });
});

describe('subledger leg resolution', () => {
  const common = {
    voucherAmount: '100000',
    voucherRateToUsd: '3.678',
    voucherAmountUsd: '27188.6895',
    localCurrency: 'AED',
    rateLocalPerUsd: '3.678',
    partyLabel: 'Test Customer',
  };

  it('credits a USD customer with the USD equivalent of an AED receipt', () => {
    const leg = resolveSubledgerLeg({ ...common, partyCurrency: 'USD', voucherCurrency: 'AED' });
    expect(leg.currency).toBe('USD');
    expect(leg.amount.toString()).toBe('27188.6895');
    expect(leg.rateToUsd.toString()).toBe('1');
  });

  it('uses the voucher rate when the party is billed in the voucher currency', () => {
    const leg = resolveSubledgerLeg({ ...common, partyCurrency: 'AED', voucherCurrency: 'AED' });
    expect(leg.currency).toBe('AED');
    expect(leg.amount.toString()).toBe('100000');
    expect(leg.rateToUsd.toString()).toBe('3.678');
  });

  it('rejects a combination it cannot represent exactly', () => {
    expect(() =>
      resolveSubledgerLeg({ ...common, partyCurrency: 'MAD', voucherCurrency: 'AED' }),
    ).toThrow(/cannot be settled/);
  });
});
