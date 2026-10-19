import { describe, expect, it } from 'vitest';
import { shipmentProfitStage } from '@/lib/shipment-profit-stage';

describe('shipment profit stage', () => {
  it('is profit to date while coffee is left to sell', () => {
    expect(shipmentProfitStage({ remainingKg: '10640.46', outstanding: '0' })).toBe('IN_PROGRESS');
  });
  it('is profit to date when sold out but customers still owe', () => {
    expect(shipmentProfitStage({ remainingKg: '0', outstanding: '126000' })).toBe('IN_PROGRESS');
  });
  it('is final only when sold out and paid for', () => {
    expect(shipmentProfitStage({ remainingKg: '0', outstanding: '0' })).toBe('COMPLETE');
    expect(shipmentProfitStage({ remainingKg: '0', outstanding: '0.004' })).toBe('COMPLETE');
  });
});
