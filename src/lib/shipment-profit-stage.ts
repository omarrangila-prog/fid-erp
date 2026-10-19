import { dec, type DecimalInput } from '@/lib/money';

/**
 * Whether a shipment's profit is still being earned or is final.
 *
 * While coffee is left to sell — or customers still owe for what was sold —
 * the profit is profit to date: the remaining stock is still on the balance
 * sheet and the money is not all in. Only when nothing is left and every
 * invoice is settled is the net profit final. Calling a running figure
 * "final" is what the client asked never to see.
 */
export type ShipmentProfitStage = 'IN_PROGRESS' | 'COMPLETE';

export function shipmentProfitStage(params: { remainingKg: DecimalInput; outstanding: DecimalInput }): ShipmentProfitStage {
  const nothingLeft = dec(params.remainingKg).lessThanOrEqualTo(0);
  const allPaid = dec(params.outstanding).lessThan('0.01');
  return nothingLeft && allPaid ? 'COMPLETE' : 'IN_PROGRESS';
}
