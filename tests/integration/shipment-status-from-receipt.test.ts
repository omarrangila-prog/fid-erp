import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { getOrderOverview } from '@/lib/services/shipment';

/**
 * Coffee in the warehouse means the shipment arrived.
 *
 * The status somebody sets by hand and the fact of the goods being counted
 * in were two separate records with nothing keeping them in step. A client
 * who received a container without first pressing "Mark arrived" left the
 * shipment at "contract created", so the order read "0 of 2 arrived" while
 * the stock was on the shelf, and the shipment stayed "Pending" after it had
 * been received in full. That is what these tests are about.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let contractId: string;
let batchIds: string[] = [];

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.6', effectiveDate: utcDate('2026-01-01') },
  });

  // One order, two containers, never marked loaded or arrived.
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0', contractReference: 'HRCC/099/26-27',
      containers: 2,
      lines: [
        { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'MEDU1111111' },
        { itemId: masters.item.id, quantity: '21000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'MSDU2222222' },
      ],
    },
    ctx.admin.id,
  );
  contractId = contract.id;
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const batches = await prisma.batch.findMany({
    where: { purchaseContractId: contract.id },
    orderBy: { batchNumber: 'asc' },
    select: { id: true },
  });
  batchIds = batches.map((b) => b.id);
  expect(batchIds.length).toBeGreaterThanOrEqual(2);
}, 300_000);

describe('a container received without ever being marked arrived', () => {
  it('starts at nothing arrived, which is honest', async () => {
    const order = await getOrderOverview(companyId, contractId);
    expect(order.arrivedContainers).toBe(0);
    expect(order.arrival).toBe('NOT_ARRIVED');
  }, 300_000);

  it('counts as arrived once the goods are counted into a warehouse', async () => {
    const grn = await createGoodsReceipt(
      {
        companyId, purchaseContractId: contractId, warehouseId: masters.warehouses[0].id,
        receiptDate: utcDate('2026-09-10'), receivedById: ctx.admin.id,
        lines: [{ batchId: batchIds[0], quantityKg: '20000', lotNumber: 'LOT-A' }],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

    const order = await getOrderOverview(companyId, contractId);
    // The shipment carrying that batch is arrived; the other is not.
    expect(order.arrivedContainers).toBeGreaterThan(0);
    expect(order.arrival).not.toBe('NOT_ARRIVED');
    expect(order.receivedContainers).toBeGreaterThan(0);
  }, 300_000);

  it('records why the status moved, rather than moving it silently', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { companyId, action: 'SHIPMENT_ARRIVED_ON_RECEIPT' },
      orderBy: { createdAt: 'desc' },
      select: { after: true },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.after)).toMatch(/goods received on/i);
  }, 300_000);

  it('reads fully arrived and fully received once both containers are in', async () => {
    const grn = await createGoodsReceipt(
      {
        companyId, purchaseContractId: contractId, warehouseId: masters.warehouses[0].id,
        receiptDate: utcDate('2026-09-12'), receivedById: ctx.admin.id,
        lines: [{ batchId: batchIds[1], quantityKg: '21000', lotNumber: 'LOT-B' }],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

    const order = await getOrderOverview(companyId, contractId);
    expect(order.arrivedContainers).toBe(order.containerCount);
    expect(order.receivedContainers).toBe(order.containerCount);
    expect(order.arrival).toBe('FULLY_ARRIVED');
    expect(order.receipt).toBe('FULLY_RECEIVED');

    // And no shipment on the order is left sitting in transit.
    const stranded = await prisma.shipment.count({
      where: { purchaseContractId: contractId, status: { in: ['CONTRACT_CREATED', 'AWAITING_LOADING', 'LOADED', 'IN_TRANSIT'] } },
    });
    expect(stranded).toBe(0);
  }, 300_000);

  it('does not drag a shipment backwards that is already further ahead', async () => {
    const shipment = await prisma.shipment.findFirstOrThrow({
      where: { purchaseContractId: contractId },
      select: { id: true },
    });
    await prisma.shipment.update({ where: { id: shipment.id }, data: { status: 'DELIVERED' } });

    const grn = await createGoodsReceipt(
      {
        companyId, purchaseContractId: contractId, warehouseId: masters.warehouses[0].id,
        receiptDate: utcDate('2026-09-14'), receivedById: ctx.admin.id,
        lines: [{ batchId: batchIds[0], quantityKg: '1', lotNumber: 'LOT-A' }],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

    const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: { status: true } });
    expect(after.status).toBe('DELIVERED');
  }, 300_000);
});
