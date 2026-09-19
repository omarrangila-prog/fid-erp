import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { changeShipmentStatus, getOrderOverview, markOrderArrived } from '@/lib/services/shipment';
import { getBatchCostings } from '@/lib/services/landed-cost';
import { reconcile } from '@/lib/services/reconciliation';
import { dec } from '@/lib/money';

/**
 * One purchase order, three shipments.
 *
 * A single contract routinely covers three containers of three coffees that
 * sail on different vessels and land on different days. Each has to be its
 * own shipment — its own item, container, lot, batch and arrival — and the
 * order is the parent that holds them. The order is "fully arrived" only
 * when the last one lands, and every total is a sum over the lines, never a
 * figure repeated per line.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let contractId: string;
let secondWarehouse: string;
let secondWarehouseName: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.85', effectiveDate: utcDate('2026-01-01') },
  });

  const [itemB, itemC] = await Promise.all([
    prisma.coffeeItem.create({
      data: { companyId, itemCode: 'ITM-S12', itemName: 'Robusta Screen 12', coffeeType: 'ROBUSTA', originCountry: 'Uganda', defaultUnit: 'KG', bagWeightKg: '60' },
    }),
    prisma.coffeeItem.create({
      data: { companyId, itemCode: 'ITM-S18', itemName: 'Robusta Screen 18', coffeeType: 'ROBUSTA', originCountry: 'Uganda', defaultUnit: 'KG', bagWeightKg: '60' },
    }),
  ]);
  const second =
    masters.warehouses[1] ??
    (await prisma.warehouse.create({ data: { companyId, code: 'WH-RAD', name: 'RADOUAN', location: 'Casablanca' } }));
  secondWarehouse = second.id;
  secondWarehouseName = second.name;

  // Three lines: three items, three containers, three lots, three batches.
  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-02-02'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      freightAmount: '0',
      contractReference: 'ICUL/FID/001',
      lines: [
        { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.116', bagWeightKg: '60', containerNumber: 'CONT-001', lotNumber: 'LOT-01', batchNumber: 'BATCH-01' },
        { itemId: itemB.id, quantity: '21000', unit: 'KG', unitPrice: '3.998', bagWeightKg: '60', containerNumber: 'CONT-002', lotNumber: 'LOT-02', batchNumber: 'BATCH-02' },
        { itemId: itemC.id, quantity: '19000', unit: 'KG', unitPrice: '4.250', bagWeightKg: '60', containerNumber: 'CONT-003', lotNumber: 'LOT-03', batchNumber: 'BATCH-03' },
      ],
    },
    ctx.admin.id,
  );
  contractId = contract.id;
  await postPurchaseContract({ id: contractId, companyId, userId: ctx.admin.id });
}, 300_000);

describe('posting the order', () => {
  it('opens three shipments, one per line, under the one order', async () => {
    const overview = await getOrderOverview(companyId, contractId);
    expect(overview.totalShipments).toBe(3);
    expect(overview.reference).toBe('ICUL/FID/001');

    const lines = overview.shipments;
    expect(lines.map((l) => l.itemName)).toEqual([
      masters.item.itemName,
      'Robusta Screen 12',
      'Robusta Screen 18',
    ]);
    expect(lines.map((l) => l.containerNumber)).toEqual(['CONT-001', 'CONT-002', 'CONT-003']);
    expect(lines.map((l) => l.lotNumber)).toEqual(['LOT-01', 'LOT-02', 'LOT-03']);
    expect(lines.map((l) => l.batchNumber)).toEqual(['BATCH-01', 'BATCH-02', 'BATCH-03']);
    expect(lines.map((l) => Number(l.orderedKg))).toEqual([20000, 21000, 19000]);
  }, 180_000);

  it('keeps each line its own purchase value, and adds them once', async () => {
    const overview = await getOrderOverview(companyId, contractId);
    const values = overview.shipments.map((l) => Number(l.purchaseUsd));
    expect(values[0]).toBeCloseTo(82_320, 0);
    expect(values[1]).toBeCloseTo(83_958, 0);
    expect(values[2]).toBeCloseTo(80_750, 0);
    // The order's total is the three added together — not one of them
    // repeated three times.
    expect(Number(overview.totalPurchaseUsd)).toBeCloseTo(82_320 + 83_958 + 80_750, 0);
    expect(Number(overview.totalKg)).toBe(60_000);
    expect(overview.containerCount).toBe(3);
  }, 180_000);

  it('links every shipment to its own contract line', async () => {
    const shipments = await prisma.shipment.findMany({
      where: { purchaseContractId: contractId },
      select: { purchaseContractLineId: true, itemId: true },
    });
    expect(shipments).toHaveLength(3);
    expect(new Set(shipments.map((s) => s.purchaseContractLineId)).size).toBe(3);
    expect(new Set(shipments.map((s) => s.itemId)).size).toBe(3);
  }, 120_000);
});

describe('arrival, one shipment at a time', () => {
  async function arrive(ordinal: number) {
    const overview = await getOrderOverview(companyId, contractId);
    const line = overview.shipments[ordinal - 1];
    await changeShipmentStatus({
      shipmentId: line.shipmentId,
      companyId,
      userId: ctx.admin.id,
      toStatus: 'LOADED',
      loadingDate: utcDate('2026-03-01'),
      etaDate: utcDate('2026-03-20'),
      shippingLineId: masters.shippingLine.id,
    });
    await changeShipmentStatus({
      shipmentId: line.shipmentId,
      companyId,
      userId: ctx.admin.id,
      toStatus: 'ARRIVED',
      ataDate: utcDate('2026-03-20'),
    });
  }

  it('says 1 of 3 arrived, and the order is partially arrived', async () => {
    await arrive(1);
    const overview = await getOrderOverview(companyId, contractId);
    expect(overview.arrivedCount).toBe(1);
    expect(overview.arrival).toBe('PARTIALLY_ARRIVED');
  }, 240_000);

  it('says 2 of 3 arrived, and is still partially arrived', async () => {
    await arrive(2);
    const overview = await getOrderOverview(companyId, contractId);
    expect(overview.arrivedCount).toBe(2);
    expect(overview.arrival).toBe('PARTIALLY_ARRIVED');
  }, 240_000);

  it('says 3 of 3, and only then is the order fully arrived', async () => {
    await arrive(3);
    const overview = await getOrderOverview(companyId, contractId);
    expect(overview.arrivedCount).toBe(3);
    expect(overview.arrival).toBe('FULLY_ARRIVED');
  }, 240_000);
});

describe('receiving the order', () => {
  it('lands each shipment into its own warehouse as its own stock', async () => {
    const overview = await getOrderOverview(companyId, contractId);
    const [a, b, c] = overview.shipments;

    // Two into the main warehouse, one into RADOUAN — one receipt for each
    // warehouse, and the order tracks them separately.
    const main = await createGoodsReceipt(
      {
        companyId,
        purchaseContractId: contractId,
        warehouseId: masters.warehouses[0].id,
        receiptDate: utcDate('2026-03-21'),
        receivedById: ctx.admin.id,
        lines: [
          { batchId: a.batchId!, quantityKg: '20000' },
          { batchId: b.batchId!, quantityKg: '21000' },
        ],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: main.id, companyId, userId: ctx.admin.id });

    const midway = await getOrderOverview(companyId, contractId);
    expect(midway.receivedCount).toBe(2);
    expect(midway.receipt).toBe('PARTIALLY_RECEIVED');
    expect(Number(midway.remainingKg)).toBe(19_000);

    const radouan = await createGoodsReceipt(
      {
        companyId,
        purchaseContractId: contractId,
        warehouseId: secondWarehouse,
        receiptDate: utcDate('2026-03-22'),
        receivedById: ctx.admin.id,
        lines: [{ batchId: c.batchId!, quantityKg: '19000' }],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: radouan.id, companyId, userId: ctx.admin.id });

    const done = await getOrderOverview(companyId, contractId);
    expect(done.receivedCount).toBe(3);
    expect(done.receipt).toBe('FULLY_RECEIVED');
    expect(Number(done.remainingKg)).toBe(0);
    expect(done.shipments.map((s) => s.warehouseName)).toEqual([
      masters.warehouses[0].name,
      masters.warehouses[0].name,
      secondWarehouseName,
    ]);
  }, 300_000);

  it('keeps three separate batches, lots and containers in stock', async () => {
    const balances = await prisma.inventoryBalance.findMany({
      where: { batch: { purchaseContractId: contractId } },
      include: { batch: { include: { lot: true, container: true } }, warehouse: true },
    });
    expect(balances).toHaveLength(3);
    expect(new Set(balances.map((b) => b.batch.batchNumber)).size).toBe(3);
    expect(new Set(balances.map((b) => b.batch.lot.lotNumber)).size).toBe(3);
    expect(new Set(balances.map((b) => b.batch.container?.containerNumber)).size).toBe(3);
    // 20,000 + 21,000 + 19,000, not three times anything.
    const onHand = balances.reduce((t, b) => t.plus(dec(b.onHandKg)), dec(0));
    expect(Number(onHand)).toBe(60_000);
  }, 180_000);

  it('costs each shipment on its own', async () => {
    const rows = await getBatchCostings({ companyId });
    const mine = rows.filter((r) => r.reference === 'ICUL/FID/001');
    expect(mine).toHaveLength(3);
    expect(new Set(mine.map((r) => r.shipmentId)).size).toBe(3);
    // Different coffees at different prices land at different costs per kilo.
    expect(new Set(mine.map((r) => r.landedPerKgUsd.toFixed(4))).size).toBe(3);
  }, 180_000);

  it('leaves the books reconciling', async () => {
    const health = await reconcile(companyId);
    expect(health.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);
});

describe('marking a whole order arrived at once', () => {
  it('moves every shipment that has not arrived, and leaves the rest alone', async () => {
    const itemD = await prisma.coffeeItem.create({
      data: { companyId, itemCode: 'ITM-S15B', itemName: 'Robusta Screen 15 second lot', coffeeType: 'ROBUSTA', originCountry: 'Uganda', defaultUnit: 'KG', bagWeightKg: '60' },
    });
    const contract = await createPurchaseContract(
      {
        companyId,
        contractDate: utcDate('2026-04-02'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '0',
        contractReference: 'ICUL/FID/002',
        lines: [
          { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'CONT-010', lotNumber: 'LOT-08', batchNumber: 'BATCH-08' },
          { itemId: itemD.id, quantity: '20000', unit: 'KG', unitPrice: '4.10', bagWeightKg: '60', containerNumber: 'CONT-011', lotNumber: 'LOT-09', batchNumber: 'BATCH-09' },
        ],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });

    const result = await markOrderArrived({
      companyId,
      contractId: contract.id,
      userId: ctx.admin.id,
      ataDate: utcDate('2026-05-01'),
    });
    expect(result).toEqual({ marked: 2, total: 2 });

    const overview = await getOrderOverview(companyId, contract.id);
    expect(overview.arrival).toBe('FULLY_ARRIVED');
    expect(overview.shipments.every((s) => s.arrived)).toBe(true);

    // Every shipment kept its own history.
    const history = await prisma.shipmentStatusHistory.count({
      where: { shipment: { purchaseContractId: contract.id }, toStatus: 'ARRIVED' },
    });
    expect(history).toBe(2);

    // Clicking it again does nothing and breaks nothing.
    const again = await markOrderArrived({ companyId, contractId: contract.id, userId: ctx.admin.id, ataDate: utcDate('2026-05-02') });
    expect(again.marked).toBe(0);
  }, 300_000);
});

describe('an order opened before shipments were split per line', () => {
  /**
   * The client's own live orders: two coffees in three containers on ONE
   * shipment, because the job was opened before each line got its own. The
   * overview must still show both coffees, all three containers and the
   * right totals — the second line cannot vanish behind the first.
   */
  it('shows every batch on the one shipment, and counts the shipment once', async () => {
    const itemE = await prisma.coffeeItem.create({
      data: { companyId, itemCode: 'LEGACY-18', itemName: 'Legacy Screen 18', coffeeType: 'ROBUSTA', originCountry: 'Uganda', defaultUnit: 'KG', bagWeightKg: '60' },
    });
    const contract = await createPurchaseContract(
      {
        companyId,
        vendorId: masters.vendor.id,
        contractDate: utcDate('2026-05-13'),
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '0',
        contractReference: 'ICUL/FID/LEGACY',
        containers: 3,
        lines: [
          { itemId: itemE.id, quantity: '40080', unit: 'KG', unitPrice: '4.20', bagWeightKg: '60', lotNumber: 'LOT-L1', batchNumber: 'BATCH-L1' },
          { itemId: masters.item.id, quantity: '21000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'LOT-L2', batchNumber: 'BATCH-L2' },
        ],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });

    // Collapse the two shipments into one, the way the older rule left them.
    const [keep, drop] = await prisma.shipment.findMany({
      where: { purchaseContractId: contract.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    await prisma.batch.updateMany({ where: { shipmentId: drop.id }, data: { shipmentId: keep.id } });
    await prisma.container.updateMany({ where: { shipmentId: drop.id }, data: { shipmentId: keep.id } });
    await prisma.shipmentStatusHistory.deleteMany({ where: { shipmentId: drop.id } });
    await prisma.shipment.delete({ where: { id: drop.id } });
    // The old rule put the order's whole container count on its one shipment.
    await prisma.shipment.update({ where: { id: keep.id }, data: { containers: 3 } });
    await prisma.container.create({
      data: { companyId, shipmentId: keep.id, purchaseContractId: contract.id, containerNumber: 'HASU-THIRD' },
    });

    const overview = await getOrderOverview(companyId, contract.id);
    expect(overview.totalShipments).toBe(1);
    expect(overview.shipments).toHaveLength(2);
    expect(overview.shipments.map((l) => l.ordinal)).toEqual([1, 1]);
    expect(overview.shipments.map((l) => l.batchOrdinal)).toEqual([1, 2]);
    expect(overview.shipments.map((l) => l.itemName)).toEqual(['Legacy Screen 18', masters.item.itemName]);
    expect(overview.shipments.map((l) => l.batchNumber)).toEqual(['BATCH-L1', 'BATCH-L2']);
    expect(overview.shipments.map((l) => Number(l.orderedKg))).toEqual([40080, 21000]);
    expect(Number(overview.totalKg)).toBe(61080);
    expect(overview.containerCount).toBe(3);
    expect(overview.arrival).toBe('NOT_ARRIVED');
    expect(overview.receipt).toBe('NOT_RECEIVED');
  }, 300_000);
});
