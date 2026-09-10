import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice } from '@/lib/services/sales';
import { getStockAgeing } from '@/lib/services/stock';
import { ensurePorts } from '@/lib/services/chart-of-accounts';
import { transaction } from '@/lib/db';

/**
 * Stock ageing, and the port master.
 *
 * Green coffee loses cup quality over months in a warehouse, so how long a
 * parcel has been sitting is a real commercial fact and not a curiosity.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let batchId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id);

  const contract = await createPurchaseContract(
    {
      companyId: ctx.dubai.id,
      contractReference: 'AGE-PO-1',
      contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '3.6725',
      freightAmount: '0',
      lines: [
        {
          itemId: masters.item.id,
          lotNumber: 'AGE-LOT',
          batchNumber: 'AGE-B001',
          quantity: '10000',
          unit: 'KG',
          unitPrice: '5.00',
          bagWeightKg: '60',
        },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

  // Landed a good while ago, so the age is unmistakable.
  await receiveEverything({
    companyId: ctx.dubai.id,
    purchaseContractId: contract.id,
    warehouseId: masters.warehouse.id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-01-20'),
  });

  batchId = (await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'AGE-B001' } })).id;
});

describe('stock ageing', () => {
  it('counts age from the day it landed, not the contract date', async () => {
    const rows = await getStockAgeing(ctx.dubai.id);
    const row = rows.find((entry) => entry.batchId === batchId)!;

    expect(row).toBeTruthy();
    expect(row.receivedAt?.toISOString().slice(0, 10)).toBe('2026-01-20');

    // Coffee contracted on the 5th but delivered on the 20th is fifteen days
    // younger than the contract suggests.
    const expected = Math.floor((Date.now() - Date.UTC(2026, 0, 20)) / 86_400_000);
    expect(row.daysInStock).toBe(expected);
  });

  it('puts a parcel in the right bucket', async () => {
    const rows = await getStockAgeing(ctx.dubai.id);
    const row = rows.find((entry) => entry.batchId === batchId)!;

    const days = row.daysInStock!;
    const expected =
      days <= 30 ? '0–30 days' : days <= 60 ? '31–60 days' : days <= 90 ? '61–90 days' : days <= 180 ? '91–180 days' : 'Over 180 days';
    expect(row.bucket).toBe(expected);
  });

  it('shows what a draft invoice has reserved, separately from what is free', async () => {
    await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-03-01'),
        customerId: masters.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [{ batchId, warehouseId: masters.warehouse.id, quantity: '4000', unit: 'KG', unitPrice: '7.00' }],
      },
      ctx.admin.id,
    );

    const row = (await getStockAgeing(ctx.dubai.id)).find((entry) => entry.batchId === batchId)!;

    // A parcel that looks old and idle may already be promised to somebody.
    expect(Number(row.onHandKg)).toBeCloseTo(10_000, 3);
    expect(Number(row.reservedKg)).toBeCloseTo(4_000, 3);
    expect(Number(row.availableKg)).toBeCloseTo(6_000, 3);
  });

  it('values the parcel at its landed cost', async () => {
    const row = (await getStockAgeing(ctx.dubai.id)).find((entry) => entry.batchId === batchId)!;
    expect(Number(row.unitCostUsd)).toBeCloseTo(5, 4);
    expect(Number(row.valueUsd)).toBeCloseTo(50_000, 2);
  });

  it('lists the oldest parcel first', async () => {
    const rows = await getStockAgeing(ctx.dubai.id);
    const dated = rows.filter((row) => row.receivedAt !== null);
    for (let i = 1; i < dated.length; i += 1) {
      expect(dated[i - 1].receivedAt!.getTime()).toBeLessThanOrEqual(dated[i].receivedAt!.getTime());
    }
  });

  it('leaves out anything with nothing on hand', async () => {
    const rows = await getStockAgeing(ctx.dubai.id);
    expect(rows.every((row) => Number(row.onHandKg) > 0)).toBe(true);
  });
});

describe('the port master', () => {
  it('seeds the company’s own ports and the origins it buys from', async () => {
    const ports = await prisma.port.findMany({ where: { companyId: ctx.dubai.id } });

    expect(ports.find((port) => port.code === 'AEJEA')?.name).toBe('Jebel Ali');
    expect(ports.find((port) => port.code === 'BRSSZ')?.name).toBe('Santos');
    // A Dubai company has no reason to be offered Casablanca as its own port.
    expect(ports.find((port) => port.code === 'MACAS')).toBeUndefined();
  });

  it('gives Morocco its own, and the same origins', async () => {
    const ports = await prisma.port.findMany({ where: { companyId: ctx.morocco.id } });
    expect(ports.find((port) => port.code === 'MACAS')?.name).toBe('Casablanca');
    expect(ports.find((port) => port.code === 'BRSSZ')).toBeTruthy();
    expect(ports.find((port) => port.code === 'AEJEA')).toBeUndefined();
  });

  it('is safe to re-run', async () => {
    const before = await prisma.port.count({ where: { companyId: ctx.dubai.id } });
    await transaction((tx) => ensurePorts(tx, ctx.dubai.id, 'United Arab Emirates'));
    expect(await prisma.port.count({ where: { companyId: ctx.dubai.id } })).toBe(before);
  });

  it('keeps one company’s ports out of the other', async () => {
    const dubaiPort = await prisma.port.findFirstOrThrow({ where: { companyId: ctx.dubai.id } });
    const fromMorocco = await prisma.port.findFirst({
      where: { id: dubaiPort.id, companyId: ctx.morocco.id },
    });
    expect(fromMorocco).toBeNull();
  });
});
