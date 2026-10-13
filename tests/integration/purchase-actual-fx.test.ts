import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { setPurchaseActualFx } from '@/lib/services/purchase-edit';
import { getShipmentCostSheet, getBatchCostings } from '@/lib/services/landed-cost';
import { effectiveLocalRate, purchaseFxSource } from '@/lib/purchase-fx';
import { dec } from '@/lib/money';

/**
 * The rate actually paid for the dollars, once it is known.
 *
 * An order is placed in dollars at the best rate available that day — an
 * estimate. The real rate appears later, when the dollars are bought to pay
 * the supplier, and until then every local figure derived from the order is
 * stated at a rate nobody paid.
 *
 * Confirming it must move the local costing everywhere at once and leave the
 * dollars alone: the supplier is owed USD 160,000 whatever the dirhams cost.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let contractId: string;
let shipmentId: string;

const ESTIMATE = '9.60';
const ACTUAL = '9.90';

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  // USD 160,000: 40,000 KG at USD 4.00, the client's own example.
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-07-01'), vendorId: masters.vendor.id,
      currency: 'USD', rateToUsd: '1', rateLocalPerUsd: ESTIMATE, freightAmount: '0',
      contractReference: 'ICUL/FX/1',
      lines: [{ itemId: masters.item.id, quantity: '40000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'FX-1', batchNumber: 'FX-B1', containerNumber: 'FXBOX01' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  contractId = contract.id;
  await receiveEverything({
    companyId, purchaseContractId: contractId, warehouseId: masters.warehouses[0].id,
    userId: ctx.admin.id, receiptDate: utcDate('2026-07-20'),
  });
  shipmentId = (await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contractId } })).shipmentId!;
}, 300_000);

const sheet = () => getShipmentCostSheet(companyId, shipmentId);
const contract = () =>
  prisma.purchaseContract.findUniqueOrThrow({
    where: { id: contractId },
    select: { totalValueUsd: true, rateLocalPerUsd: true, actualRateLocalPerUsd: true },
  });

describe('the rate actually paid for the dollars', () => {
  it('starts as the estimate the order was placed at', async () => {
    const c = await contract();
    expect(purchaseFxSource(c)).toBe('ESTIMATED');
    expect(effectiveLocalRate(c).toFixed(2)).toBe('9.60');

    const s = await sheet();
    expect(s.fxSource).toBe('ESTIMATED');
    // USD 160,000 at 9.60 is MAD 1,536,000.
    expect(dec(s.goodsUsd).toFixed(2)).toBe('160000.00');
    expect(dec(s.goodsLocal).toFixed(2)).toBe('1536000.00');
  }, 180_000);

  it('restates the local cost when the real rate is confirmed, and leaves the dollars alone', async () => {
    await setPurchaseActualFx({
      companyId, contractId, userId: ctx.admin.id,
      actualRateLocalPerUsd: ACTUAL, note: 'Bank advice 4471',
    });

    const c = await contract();
    expect(purchaseFxSource(c)).toBe('ACTUAL');
    // The supplier is still owed the same dollars.
    expect(dec(c.totalValueUsd).toFixed(2)).toBe('160000.00');
    // And the estimate is kept, not overwritten.
    expect(dec(c.rateLocalPerUsd).toFixed(2)).toBe('9.60');

    const s = await sheet();
    expect(s.fxSource).toBe('ACTUAL');
    expect(dec(s.goodsUsd).toFixed(2)).toBe('160000.00');
    // USD 160,000 at 9.90 is MAD 1,584,000 — MAD 48,000 more, as the client's
    // own example says.
    expect(dec(s.goodsLocal).toFixed(2)).toBe('1584000.00');
    expect(dec(s.goodsLocal).minus(1536000).toFixed(2)).toBe('48000.00');
  }, 180_000);

  it('keeps the purchase price and the landed cost apart', async () => {
    const s = await sheet();
    // No charges on this order, so the two agree — but they are two figures,
    // and the purchase one is the supplier's price alone.
    expect(dec(s.purchasePerKgUsd).toFixed(4)).toBe('4.0000');
    expect(dec(s.purchasePerKgLocal).toFixed(4)).toBe('39.6000');
    expect(dec(s.costPerKgUsd).toFixed(4)).toBe('4.0000');
  }, 180_000);

  it('values what is left in the warehouse at the confirmed rate', async () => {
    const s = await sheet();
    // Nothing sold yet: all 40,000 KG remain.
    expect(dec(s.remainingKg).toFixed(3)).toBe('40000.000');
    expect(dec(s.remainingPurchaseUsd).toFixed(2)).toBe('160000.00');
    expect(dec(s.remainingPurchaseLocal).toFixed(2)).toBe('1584000.00');
    expect(dec(s.remainingLandedLocal).toFixed(2)).toBe('1584000.00');
  }, 180_000);

  it('refuses a rate a long way from the estimate, which is a typo', async () => {
    await expect(
      setPurchaseActualFx({ companyId, contractId, userId: ctx.admin.id, actualRateLocalPerUsd: '99.0' }),
    ).rejects.toThrow(/long way from/i);
    // And the good rate is still in place.
    expect(effectiveLocalRate(await contract()).toFixed(2)).toBe('9.90');
  }, 180_000);

  it('goes back to the estimate when the actual rate is cleared', async () => {
    await setPurchaseActualFx({ companyId, contractId, userId: ctx.admin.id, actualRateLocalPerUsd: null });
    const s = await sheet();
    expect(s.fxSource).toBe('ESTIMATED');
    expect(dec(s.goodsLocal).toFixed(2)).toBe('1536000.00');
  }, 180_000);

  it('moves the stock figures with it, so no page keeps the old rate', async () => {
    // §34: the cost sheet and the stock costing must agree. They read the same
    // rate, so confirming it moves both.
    await setPurchaseActualFx({
      companyId, contractId, userId: ctx.admin.id, actualRateLocalPerUsd: ACTUAL,
    });

    const batches = await getBatchCostings({ companyId, purchaseContractId: contractId });
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch.fxSource).toBe('ACTUAL');
    expect(dec(batch.rateLocalPerUsd).toFixed(2)).toBe('9.90');
    // USD 4.00 a kilo at 9.90 is MAD 39.60.
    expect(dec(batch.purchasePerKgUsd).toFixed(4)).toBe('4.0000');
    expect(dec(batch.remainingPurchaseUsd).toFixed(2)).toBe('160000.00');
    expect(dec(batch.remainingPurchaseLocal).toFixed(2)).toBe('1584000.00');

    // And the shipment sheet says the same.
    const s = await sheet();
    expect(dec(s.remainingPurchaseLocal).toFixed(2)).toBe(dec(batch.remainingPurchaseLocal).toFixed(2));

    // Back to the estimate and both follow, together.
    await setPurchaseActualFx({ companyId, contractId, userId: ctx.admin.id, actualRateLocalPerUsd: null });
    const afterClear = (await getBatchCostings({ companyId, purchaseContractId: contractId }))[0];
    expect(afterClear.fxSource).toBe('ESTIMATED');
    expect(dec(afterClear.remainingPurchaseLocal).toFixed(2)).toBe('1536000.00');
    expect(dec((await sheet()).remainingPurchaseLocal).toFixed(2)).toBe('1536000.00');
  }, 180_000);

  it('records who changed it, and what the change was worth', async () => {
    await setPurchaseActualFx({
      companyId, contractId, userId: ctx.admin.id,
      actualRateLocalPerUsd: ACTUAL, note: 'Bank advice 4471',
    });
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { companyId, action: 'PURCHASE_ACTUAL_FX_SET' },
      orderBy: { createdAt: 'desc' },
    });
    const after = entry.after as Record<string, unknown>;
    expect(after.estimatedRate).toBe('9.6');
    expect(after.actualRate).toBe('9.9');
    expect(after.purchaseUsd).toBe('160000.00');
    expect(after.difference).toBe('48000.00');
    expect(after.note).toBe('Bank advice 4471');
  }, 180_000);
});
