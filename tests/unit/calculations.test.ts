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
  it('permits the normal forward path', () => {
    expect(() => assertTransitionAllowed('CONTRACT_CREATED', 'AWAITING_LOADING')).not.toThrow();
    expect(() => assertTransitionAllowed('AWAITING_LOADING', 'LOADED')).not.toThrow();
    expect(() => assertTransitionAllowed('LOADED', 'IN_TRANSIT')).not.toThrow();
    expect(() => assertTransitionAllowed('IN_TRANSIT', 'ARRIVED')).not.toThrow();
    expect(() => assertTransitionAllowed('ARRIVED', 'CUSTOMS_CLEARING')).not.toThrow();
    expect(() => assertTransitionAllowed('CUSTOMS_CLEARING', 'CLEARED')).not.toThrow();
    expect(() => assertTransitionAllowed('CLEARED', 'DELIVERED')).not.toThrow();
    expect(() => assertTransitionAllowed('DELIVERED', 'CLOSED')).not.toThrow();
  });

  it('refuses to skip the middle of the workflow', () => {
    expect(() => assertTransitionAllowed('CONTRACT_CREATED', 'ARRIVED')).toThrow(/cannot move directly/);
    expect(() => assertTransitionAllowed('AWAITING_LOADING', 'IN_TRANSIT')).toThrow(/cannot move directly/);
  });

  it('refuses a no-op transition', () => {
    expect(() => assertTransitionAllowed('LOADED', 'LOADED')).toThrow(/already in that status/);
  });

  it('will not mark a shipment loaded without the full booking data', () => {
    expect(() => assertStatusDataComplete('LOADED', { loadingDate: new Date() })).toThrow(
      /Booking Number, Shipping Line, Vessel Name, Port of Loading, Port of Discharge, ETD, ETA/,
    );
    expect(() =>
      assertStatusDataComplete('LOADED', {
        loadingDate: new Date(),
        bookingNumber: 'BK-1',
        shippingLineId: 'sl-1',
        vesselName: 'MSC Aurora',
        portOfLoading: 'Santos',
        portOfDischarge: 'Jebel Ali',
        etdDate: new Date(),
        etaDate: new Date(),
      }),
    ).not.toThrow();
  });

  it('requires a bill of lading before the cargo can sail', () => {
    expect(() => assertStatusDataComplete('IN_TRANSIT', { etaDate: new Date() })).toThrow(/Bill of Lading/);
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
