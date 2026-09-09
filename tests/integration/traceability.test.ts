import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { computePurchaseTotals } from '@/lib/calc/purchase';
import { purchaseContractSchema } from '@/lib/validation/trading';

/**
 * A lot, or a batch, or both.
 *
 * Suppliers label consignments differently — some quote a lot, some a batch
 * mark, some both — and demanding both meant somebody inventing the missing
 * one. An invented reference is worse than none: it looks authoritative and
 * matches nothing on the supplier's paperwork.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let sequence = 0;

function line(overrides: Record<string, unknown>) {
  sequence += 1;
  return {
    itemId: masters.item.id,
    quantity: '1000',
    unit: 'KG' as const,
    unitPrice: '5.00',
    bagWeightKg: '60',
    ...overrides,
  };
}

async function contractWith(lines: Array<Record<string, unknown>>) {
  sequence += 1;
  return createPurchaseContract(
    {
      companyId: ctx.dubai.id,
      contractReference: `TRACE-${sequence}`,
      contractDate: utcDate('2026-01-10'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '3.6725',
      freightAmount: '0',
      lines: lines as never,
    },
    ctx.admin.id,
  );
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id);
});

describe('lot or batch', () => {
  it('accepts a lot on its own and mirrors it into the batch', async () => {
    const contract = await contractWith([line({ lotNumber: 'LOT-ONLY-1' })]);
    expect(contract.lines[0].lotNumber).toBe('LOT-ONLY-1');
    // The inventory ledger moves stock against a batch, so it still needs one.
    expect(contract.lines[0].batchNumber).toBe('LOT-ONLY-1');

    await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    const batch = await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'LOT-ONLY-1' } });
    expect(batch.id).toBeTruthy();
  });

  it('accepts a batch on its own and mirrors it into the lot', async () => {
    const contract = await contractWith([line({ batchNumber: 'BATCH-ONLY-1' })]);
    expect(contract.lines[0].batchNumber).toBe('BATCH-ONLY-1');
    expect(contract.lines[0].lotNumber).toBe('BATCH-ONLY-1');
  });

  it('keeps both when both are given', async () => {
    const contract = await contractWith([line({ lotNumber: 'L-77', batchNumber: 'B-77' })]);
    expect(contract.lines[0].lotNumber).toBe('L-77');
    expect(contract.lines[0].batchNumber).toBe('B-77');
  });

  it('refuses a line with neither, in the words the client asked for', () => {
    expect(() =>
      computePurchaseTotals({
        lines: [{ itemId: 'x', quantity: '1000', unit: 'KG', unitPrice: '5' }],
        freightAmount: '0',
        currency: 'USD',
        rateToUsd: '1',
      }),
    ).toThrow(/either a lot number or a batch number/i);
  });

  it('refuses it at the form boundary too, not only in the engine', () => {
    const parsed = purchaseContractSchema.safeParse({
      contractReference: 'TRACE-X',
      contractDate: '2026-01-10',
      vendorId: 'c'.repeat(25),
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '3.6725',
      freightAmount: '0',
      otherCharges: '0',
      paymentTermDays: 30,
      lines: [{ itemId: 'c'.repeat(25), quantity: '1000', unit: 'KG', unitPrice: '5', lotNumber: '', batchNumber: '' }],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message)).toContain(
        'Please enter either a Lot Number or a Batch Number.',
      );
    }
  });

  it('still refuses the same reference twice on one contract', async () => {
    await expect(
      contractWith([line({ lotNumber: 'DUP-1' }), line({ batchNumber: 'DUP-1' })]),
    ).rejects.toThrow(/appears more than once|used on more than one line/i);
  });

  it('still refuses a batch number another contract already owns', async () => {
    await expect(contractWith([line({ batchNumber: 'LOT-ONLY-1' })])).rejects.toThrow(/already used by/i);
  });
});

describe('the purchase order no longer asks for what nobody knows yet', () => {
  it('saves without an expected shipment date', () => {
    const parsed = purchaseContractSchema.safeParse({
      contractReference: 'TRACE-NO-ETA',
      contractDate: '2026-01-10',
      vendorId: 'c'.repeat(25),
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '3.6725',
      freightAmount: '0',
      otherCharges: '0',
      paymentTermDays: 30,
      lines: [{ itemId: 'c'.repeat(25), quantity: '1000', unit: 'KG', unitPrice: '5', lotNumber: 'L-1' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('saves without a container, an incoterm or a destination', async () => {
    const contract = await contractWith([line({ lotNumber: 'BARE-1' })]);
    expect(contract.containers).toBe(0);
    // Defaults stand in rather than blocking the save.
    expect(contract.incoterm).toBe('FOB');
    expect(contract.destination).toBeNull();
  });
});
