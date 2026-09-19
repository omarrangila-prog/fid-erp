import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt, receiveContainers } from '@/lib/services/goods-receipt';
import { getReceiptStatus, splitContractLine, correctPurchaseContract, editContainer, addContainerToOrder, reversePurchaseContract } from '@/lib/services/purchase';
import { transaction } from '@/lib/db';
import { changeShipmentStatus, getOrderOverview, markOrderArrived, undoLoading } from '@/lib/services/shipment';
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
    // Three numbered containers, as the client's job has: one on each batch
    // and a third nobody assigned.
    const batches = await prisma.batch.findMany({ where: { purchaseContractId: contract.id }, orderBy: { batchNumber: 'asc' }, select: { id: true } });
    for (const [i, number] of ['SUDU-FIRST', 'TCLU-SECOND'].entries()) {
      const container = await prisma.container.create({
        data: { companyId, shipmentId: keep.id, purchaseContractId: contract.id, containerNumber: number },
      });
      await prisma.batch.update({ where: { id: batches[i].id }, data: { containerId: container.id } });
    }
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
    expect(overview.arrivedContainers).toBe(0);
    expect(overview.shipments.map((l) => l.stage)).toEqual(['PENDING_LOADING', 'PENDING_LOADING']);

    // The receive screen gets one row per container: the third, unassigned
    // container goes with the 40,080 KG batch, so nothing is missing.
    const status = await transaction((tx) => getReceiptStatus(tx, contract.id));
    expect(status.map((r) => r.containerNumbers.length)).toEqual([2, 1]);
    expect(status[0].containerNumbers).toContain('HASU-THIRD');
    expect(status.flatMap((r) => r.containerNumbers)).toHaveLength(3);
  }, 300_000);
});

describe('containers arrive one at a time', () => {
  /**
   * One container arriving must not mark the others. The order counts
   * containers — "1 of 3 containers arrived" — and every row carries its own
   * stage: pending loading, loaded, arrived, received.
   */
  it('counts 1 of 3, then 2 of 3, and each row keeps its own stage', async () => {
    const contract = await createPurchaseContract(
      {
        companyId,
        vendorId: masters.vendor.id,
        contractDate: utcDate('2026-06-01'),
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '0',
        contractReference: 'ICUL/FID/STAGES',
        containers: 3,
        lines: [
          { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.10', bagWeightKg: '60', containerNumber: 'CONT-S1', lotNumber: 'LOT-S1', batchNumber: 'BATCH-S1' },
          { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.10', bagWeightKg: '60', containerNumber: 'CONT-S2', lotNumber: 'LOT-S2', batchNumber: 'BATCH-S2' },
          { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.10', bagWeightKg: '60', containerNumber: 'CONT-S3', lotNumber: 'LOT-S3', batchNumber: 'BATCH-S3' },
        ],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });

    let overview = await getOrderOverview(companyId, contract.id);
    expect(overview.containerCount).toBe(3);
    expect(overview.arrivedContainers).toBe(0);
    expect(overview.shipments.map((l) => l.stage)).toEqual(['PENDING_LOADING', 'PENDING_LOADING', 'PENDING_LOADING']);

    const [first, second] = overview.shipments;
    const land = async (shipmentId: string) => {
      await changeShipmentStatus({ shipmentId, companyId, userId: ctx.admin.id, toStatus: 'LOADED', etaDate: utcDate('2026-06-20'), loadingDate: utcDate('2026-06-10'), shippingLineId: masters.shippingLine.id });
      await changeShipmentStatus({ shipmentId, companyId, userId: ctx.admin.id, toStatus: 'ARRIVED', ataDate: utcDate('2026-06-21') });
    };

    await land(first.shipmentId);
    overview = await getOrderOverview(companyId, contract.id);
    expect(overview.arrivedContainers).toBe(1);
    expect(overview.arrival).toBe('PARTIALLY_ARRIVED');
    expect(overview.shipments.map((l) => l.stage)).toEqual(['ARRIVED', 'PENDING_LOADING', 'PENDING_LOADING']);

    await changeShipmentStatus({ shipmentId: second.shipmentId, companyId, userId: ctx.admin.id, toStatus: 'LOADED', etaDate: utcDate('2026-06-25'), loadingDate: utcDate('2026-06-12'), shippingLineId: masters.shippingLine.id });
    overview = await getOrderOverview(companyId, contract.id);
    expect(overview.arrivedContainers).toBe(1);
    expect(overview.shipments.map((l) => l.stage)).toEqual(['ARRIVED', 'LOADED', 'PENDING_LOADING']);

    await changeShipmentStatus({ shipmentId: second.shipmentId, companyId, userId: ctx.admin.id, toStatus: 'ARRIVED', ataDate: utcDate('2026-06-26') });
    overview = await getOrderOverview(companyId, contract.id);
    expect(overview.arrivedContainers).toBe(2);
    expect(overview.arrival).toBe('PARTIALLY_ARRIVED');
    expect(overview.shipments.map((l) => l.stage)).toEqual(['ARRIVED', 'ARRIVED', 'PENDING_LOADING']);
  }, 300_000);
});

describe('receiving container by container', () => {
  const order = async (reference: string, count: number, kgEach = '20000') => {
    const contract = await createPurchaseContract(
      {
        companyId,
        vendorId: masters.vendor.id,
        contractDate: utcDate('2026-07-01'),
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '0',
        contractReference: reference,
        containers: count,
        lines: Array.from({ length: count }, (_, i) => ({
          itemId: masters.item.id,
          quantity: kgEach,
          unit: 'KG' as const,
          unitPrice: '4.00',
          bagWeightKg: '60',
          containerNumber: `${reference.replace(/\W/g, '')}-C${i + 1}`,
        })),
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
    return contract;
  };
  const land = async (shipmentId: string) => {
    await changeShipmentStatus({ shipmentId, companyId, userId: ctx.admin.id, toStatus: 'LOADED', loadingDate: utcDate('2026-07-05'), etaDate: utcDate('2026-07-20'), shippingLineId: masters.shippingLine.id });
    await changeShipmentStatus({ shipmentId, companyId, userId: ctx.admin.id, toStatus: 'ARRIVED', ataDate: utcDate('2026-07-21') });
  };

  /** Test case A: three containers arrive together and are received in one go. */
  it('receives all three containers at once, each with its own lot, batch and warehouse', async () => {
    const contract = await order('ICUL/FID/A', 3);
    await markOrderArrived({ companyId, contractId: contract.id, userId: ctx.admin.id, ataDate: utcDate('2026-07-21') });

    // The receive screen offers every container, ticked because it arrived.
    const status = await transaction((tx) => getReceiptStatus(tx, contract.id));
    expect(status).toHaveLength(3);
    expect(status.every((r) => r.arrived)).toBe(true);
    expect(status.every((r) => r.traceabilityPending)).toBe(true);

    const receipts = await receiveContainers({
      companyId,
      purchaseContractId: contract.id,
      receiptDate: utcDate('2026-07-22'),
      receivedById: ctx.admin.id,
      lines: [
        { batchId: status[0].batchId, quantityKg: '20000', lotNumber: 'LOT-A1', batchNumber: 'BATCH-A1', containerNumber: status[0].containerNumbers[0], warehouseId: masters.warehouses[0].id },
        { batchId: status[1].batchId, quantityKg: '20000', lotNumber: 'LOT-A2', batchNumber: 'BATCH-A2', containerNumber: status[1].containerNumbers[0], warehouseId: masters.warehouses[0].id },
        { batchId: status[2].batchId, quantityKg: '20000', lotNumber: 'LOT-A3', batchNumber: 'BATCH-A3', containerNumber: status[2].containerNumbers[0], warehouseId: secondWarehouse },
      ],
    });
    // One receipt per warehouse, both posted in the same transaction.
    expect(receipts).toHaveLength(2);

    const overview = await getOrderOverview(companyId, contract.id);
    expect(overview.receivedContainers).toBe(3);
    expect(overview.receipt).toBe('FULLY_RECEIVED');
    expect(overview.shipments.map((l) => l.stage)).toEqual(['RECEIVED', 'RECEIVED', 'RECEIVED']);
    expect(overview.shipments.map((l) => l.lotNumber)).toEqual(['LOT-A1', 'LOT-A2', 'LOT-A3']);
    expect(overview.shipments.map((l) => l.batchNumber)).toEqual(['BATCH-A1', 'BATCH-A2', 'BATCH-A3']);
    expect(overview.shipments.map((l) => l.warehouseName)).toEqual([
      masters.warehouses[0].name,
      masters.warehouses[0].name,
      (await prisma.warehouse.findUniqueOrThrow({ where: { id: secondWarehouse } })).name,
    ]);

    // Three stock records, sellable, in the warehouses named.
    const balances = await prisma.inventoryBalance.findMany({
      where: { batch: { purchaseContractId: contract.id } },
      select: { warehouseId: true, availableKg: true, batch: { select: { batchNumber: true } } },
      orderBy: { batch: { batchNumber: 'asc' } },
    });
    expect(balances.map((b) => [b.batch.batchNumber, Number(b.availableKg)])).toEqual([
      ['BATCH-A1', 20000],
      ['BATCH-A2', 20000],
      ['BATCH-A3', 20000],
    ]);
    expect(balances[2].warehouseId).toBe(secondWarehouse);
  }, 300_000);

  /** Test case B: six containers, five arrive, three are received, the rest later. */
  it('keeps every container at its own stage through partial arrival and receipt', async () => {
    const contract = await order('ICUL/FID/B', 6);
    let overview = await getOrderOverview(companyId, contract.id);
    expect(overview.containerCount).toBe(6);

    for (const line of overview.shipments.slice(0, 5)) await land(line.shipmentId);
    overview = await getOrderOverview(companyId, contract.id);
    expect(overview.arrivedContainers).toBe(5);
    expect(overview.arrival).toBe('PARTIALLY_ARRIVED');

    const status = await transaction((tx) => getReceiptStatus(tx, contract.id));
    expect(status.map((r) => r.arrived)).toEqual([true, true, true, true, true, false]);

    await receiveContainers({
      companyId,
      purchaseContractId: contract.id,
      receiptDate: utcDate('2026-07-22'),
      receivedById: ctx.admin.id,
      lines: status.slice(0, 3).map((r, i) => ({
        batchId: r.batchId,
        quantityKg: '20000',
        lotNumber: `LOT-B${i + 1}`,
        batchNumber: `BATCH-B${i + 1}`,
        warehouseId: masters.warehouses[0].id,
      })),
    });
    overview = await getOrderOverview(companyId, contract.id);
    expect(overview.receivedContainers).toBe(3);
    expect(overview.arrivedContainers).toBe(5);
    expect(overview.receipt).toBe('PARTIALLY_RECEIVED');
    expect(overview.shipments.map((l) => l.stage)).toEqual([
      'RECEIVED', 'RECEIVED', 'RECEIVED', 'ARRIVED', 'ARRIVED', 'PENDING_LOADING',
    ]);
    // Pending arrival 1, pending receipt 3 (two landed, one still at sea).
    expect(overview.containerCount - overview.arrivedContainers).toBe(1);
    expect(overview.containerCount - overview.receivedContainers).toBe(3);

    // The other two landed containers, on their own day.
    const later = await transaction((tx) => getReceiptStatus(tx, contract.id));
    const outstanding = later.filter((r) => Number(r.outstandingKg) > 0 && r.arrived);
    expect(outstanding).toHaveLength(2);
    await receiveContainers({
      companyId,
      purchaseContractId: contract.id,
      receiptDate: utcDate('2026-07-23'),
      receivedById: ctx.admin.id,
      lines: outstanding.map((r, i) => ({
        batchId: r.batchId,
        quantityKg: '20000',
        lotNumber: `LOT-B${i + 4}`,
        warehouseId: secondWarehouse,
      })),
    });
    overview = await getOrderOverview(companyId, contract.id);
    expect(overview.receivedContainers).toBe(5);
    expect(overview.shipments[5].stage).toBe('PENDING_LOADING');

    // The last one lands and is received; the order is complete.
    await land(overview.shipments[5].shipmentId);
    const last = (await transaction((tx) => getReceiptStatus(tx, contract.id))).find((r) => Number(r.outstandingKg) > 0)!;
    await receiveContainers({
      companyId,
      purchaseContractId: contract.id,
      receiptDate: utcDate('2026-07-30'),
      receivedById: ctx.admin.id,
      lines: [{ batchId: last.batchId, quantityKg: '20000', lotNumber: 'LOT-B6', warehouseId: masters.warehouses[0].id }],
    });
    overview = await getOrderOverview(companyId, contract.id);
    expect(overview.arrival).toBe('FULLY_ARRIVED');
    expect(overview.receipt).toBe('FULLY_RECEIVED');
    expect(overview.receivedContainers).toBe(6);
  }, 300_000);

  it('receives nothing at all when one container of the batch is wrong', async () => {
    const contract = await order('ICUL/FID/ATOMIC', 2);
    await markOrderArrived({ companyId, contractId: contract.id, userId: ctx.admin.id, ataDate: utcDate('2026-07-21') });
    const status = await transaction((tx) => getReceiptStatus(tx, contract.id));

    await expect(
      receiveContainers({
        companyId,
        purchaseContractId: contract.id,
        receiptDate: utcDate('2026-07-22'),
        receivedById: ctx.admin.id,
        lines: [
          { batchId: status[0].batchId, quantityKg: '20000', lotNumber: 'LOT-OK', warehouseId: masters.warehouses[0].id },
          // More than the container has left — the second warehouse's receipt fails.
          { batchId: status[1].batchId, quantityKg: '25000', lotNumber: 'LOT-OVER', warehouseId: secondWarehouse },
        ],
      }),
    ).rejects.toThrow();

    const overview = await getOrderOverview(companyId, contract.id);
    expect(overview.receivedContainers).toBe(0);
    const balances = await prisma.inventoryBalance.count({ where: { batch: { purchaseContractId: contract.id } } });
    expect(balances).toBe(0);
  }, 300_000);
});

describe('dividing an approved order into containers', () => {
  it('turns one 40,080 KG row into two containers without moving the books', async () => {
    const contract = await createPurchaseContract(
      {
        companyId,
        vendorId: masters.vendor.id,
        contractDate: utcDate('2026-08-01'),
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '0',
        contractReference: 'ICUL/FID/DIVIDE',
        containers: 3,
        lines: [
          { itemId: masters.item.id, quantity: '40080', unit: 'KG', unitPrice: '4.329', bagWeightKg: '60' },
          { itemId: masters.item.id, quantity: '21000', unit: 'KG', unitPrice: '3.998', bagWeightKg: '60' },
        ],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
    const before = await prisma.purchaseContract.findUniqueOrThrow({
      where: { id: contract.id },
      select: { totalValue: true, totalValueUsd: true, lines: { select: { id: true, lineNumber: true } } },
    });
    const journalBefore = await prisma.journalLine.count({ where: { journalEntry: { sourceId: contract.id } } });

    const firstLine = before.lines.find((l) => l.lineNumber === 1)!;
    const parts = await splitContractLine({
      companyId,
      contractId: contract.id,
      lineId: firstLine.id,
      userId: ctx.admin.id,
      parts: [
        { quantityKg: '20040', containerNumber: 'SUDU1701982' },
        { quantityKg: '20040', containerNumber: 'HASU1001190' },
      ],
    });
    expect(parts).toHaveLength(2);

    const overview = await getOrderOverview(companyId, contract.id);
    expect(overview.totalShipments).toBe(3);
    expect(overview.containerCount).toBe(3);
    expect(overview.shipments.map((l) => Number(l.orderedKg))).toEqual([20040, 21000, 20040]);
    expect(overview.shipments.map((l) => l.containerNumber)).toEqual(['SUDU1701982', null, 'HASU1001190']);
    expect(Number(overview.totalKg)).toBe(61080);

    // The money is the line divided, to the cent.
    const lines = await prisma.purchaseContractLine.findMany({ where: { purchaseContractId: contract.id }, orderBy: { lineNumber: 'asc' } });
    const goods = lines.reduce((a, l) => a.plus(l.lineSubtotal), dec(0));
    expect(goods.toFixed(4)).toBe(dec('40080').times('4.329').plus(dec('21000').times('3.998')).toFixed(4));
    const after = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contract.id }, select: { totalValue: true, totalValueUsd: true } });
    expect(after.totalValue.toString()).toBe(before.totalValue.toString());
    expect(after.totalValueUsd.toString()).toBe(before.totalValueUsd.toString());
    expect(await prisma.journalLine.count({ where: { journalEntry: { sourceId: contract.id } } })).toBe(journalBefore);

    const batches = await prisma.batch.findMany({ where: { purchaseContractId: contract.id }, select: { purchaseCostUsd: true, orderedQuantityKg: true } });
    const purchase = batches.reduce((a, b) => a.plus(b.purchaseCostUsd), dec(0));
    expect(purchase.toFixed(2)).toBe(dec('40080').times('4.329').plus(dec('21000').times('3.998')).toFixed(2));

    // Each container now arrives on its own.
    await changeShipmentStatus({ shipmentId: overview.shipments[2].shipmentId, companyId, userId: ctx.admin.id, toStatus: 'LOADED', loadingDate: utcDate('2026-08-05'), etaDate: utcDate('2026-08-20'), shippingLineId: masters.shippingLine.id });
    await changeShipmentStatus({ shipmentId: overview.shipments[2].shipmentId, companyId, userId: ctx.admin.id, toStatus: 'ARRIVED', ataDate: utcDate('2026-08-21') });
    const later = await getOrderOverview(companyId, contract.id);
    expect(later.arrivedContainers).toBe(1);
    expect(later.shipments.map((l) => l.stage)).toEqual(['PENDING_LOADING', 'PENDING_LOADING', 'ARRIVED']);
  }, 300_000);

  it('refuses once the row has been received', async () => {
    const contract = await createPurchaseContract(
      {
        companyId, vendorId: masters.vendor.id, contractDate: utcDate('2026-08-01'), currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.85', freightAmount: '0',
        contractReference: 'ICUL/FID/DIVIDE-2',
        lines: [{ itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'LOT-D2' }],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
    const status = await transaction((tx) => getReceiptStatus(tx, contract.id));
    await receiveContainers({ companyId, purchaseContractId: contract.id, receiptDate: utcDate('2026-08-10'), receivedById: ctx.admin.id, lines: [{ batchId: status[0].batchId, quantityKg: '20000', warehouseId: masters.warehouses[0].id }] });
    await expect(
      splitContractLine({ companyId, contractId: contract.id, lineId: status[0].lineId, userId: ctx.admin.id, parts: [{ quantityKg: '10000' }, { quantityKg: '10000' }] }),
    ).rejects.toThrow(/already been received/);
  }, 300_000);
});

describe('correcting an approved order', () => {
  it('reverses it and opens a draft copy under the same reference', async () => {
    const contract = await createPurchaseContract(
      {
        companyId, vendorId: masters.vendor.id, contractDate: utcDate('2026-08-01'), currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.85', freightAmount: '0',
        contractReference: 'ICUL/FID/CORRECT', containers: 2,
        lines: [
          { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'CORR-1' },
          { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'CORR-2' },
        ],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });

    const draft = await correctPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id, reason: 'Third container missing' });
    const original = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contract.id }, select: { status: true } });
    expect(original.status).toBe('REVERSED');
    expect(draft.status).toBe('DRAFT');
    expect(draft.contractReference).toBe('ICUL/FID/CORRECT');
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines.map((l) => l.containerNumber)).toEqual(['CORR-1', 'CORR-2']);

    // The reversal is in the books, and the copy can be approved again.
    const reversal = await prisma.journalEntry.count({ where: { sourceId: contract.id } });
    expect(reversal).toBe(2);
    await postPurchaseContract({ id: draft.id, companyId, userId: ctx.admin.id });
    const overview = await getOrderOverview(companyId, draft.id);
    expect(overview.containerCount).toBe(2);
  }, 300_000);
});

describe('receiving a little more than was ordered', () => {
  it('accepts the weighbridge figure up to a tenth over, at no extra cost', async () => {
    const contract = await createPurchaseContract(
      {
        companyId, vendorId: masters.vendor.id, contractDate: utcDate('2026-08-01'), currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.85', freightAmount: '0',
        contractReference: 'ICUL/FID/OVER',
        lines: [{ itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'LOT-OVER' }],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
    const status = await transaction((tx) => getReceiptStatus(tx, contract.id));

    // 25% over is a typo, and is refused with the allowance spelled out.
    await expect(
      receiveContainers({ companyId, purchaseContractId: contract.id, receiptDate: utcDate('2026-08-10'), receivedById: ctx.admin.id, lines: [{ batchId: status[0].batchId, quantityKg: '25000', warehouseId: masters.warehouses[0].id }] }),
    ).rejects.toThrow(/more than ordered/);

    // 5% over is the weighbridge, and goes through.
    await receiveContainers({ companyId, purchaseContractId: contract.id, receiptDate: utcDate('2026-08-10'), receivedById: ctx.admin.id, lines: [{ batchId: status[0].batchId, quantityKg: '21000', warehouseId: masters.warehouses[0].id }] });

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: status[0].batchId } });
    expect(Number(batch.receivedQuantityKg)).toBe(21000);
    expect(Number(batch.inTransitQuantityKg)).toBe(0);
    expect(Number(batch.availableQuantityKg)).toBe(21000);

    // Inventory holds exactly the purchase value — 80,000 — not 84,000.
    const movement = await prisma.inventoryTransaction.findFirstOrThrow({ where: { batchId: batch.id, transactionType: 'RECEIPT' } });
    expect(dec(movement.quantityKg).times(movement.unitCost).toFixed(2)).toBe('80000.00');
    const overview = await getOrderOverview(companyId, contract.id);
    expect(overview.receipt).toBe('FULLY_RECEIVED');
  }, 300_000);
});

describe('correcting a mistake without deleting anything', () => {
  const freshOrder = async (reference: string) => {
    const contract = await createPurchaseContract(
      {
        companyId, vendorId: masters.vendor.id, contractDate: utcDate('2026-09-01'), currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.85', freightAmount: '0',
        contractReference: reference, containers: 2,
        lines: [
          { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: `${reference.replace(/\W/g, '')}-1` },
          { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: `${reference.replace(/\W/g, '')}-2` },
        ],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
    return contract;
  };

  it('undoes Loaded, lets the KG be corrected, and marks it loaded again', async () => {
    const contract = await freshOrder('ICUL/FID/UNDO');
    let overview = await getOrderOverview(companyId, contract.id);
    const first = overview.shipments[0];
    await changeShipmentStatus({ shipmentId: first.shipmentId, companyId, userId: ctx.admin.id, toStatus: 'LOADED', loadingDate: utcDate('2026-09-05'), etaDate: utcDate('2026-09-20'), shippingLineId: masters.shippingLine.id });
    overview = await getOrderOverview(companyId, contract.id);
    expect(overview.shipments[0].stage).toBe('LOADED');

    await undoLoading({ companyId, shipmentId: first.shipmentId, userId: ctx.admin.id, reason: 'KG was wrong' });
    overview = await getOrderOverview(companyId, contract.id);
    expect(overview.shipments[0].stage).toBe('PENDING_LOADING');
    // The other container was not touched.
    expect(overview.shipments[1].stage).toBe('PENDING_LOADING');

    // 20,000 → 19,500: the row, the batch, the order and the payable follow.
    const payableBefore = await prisma.journalLine.aggregate({ where: { purchaseContractId: contract.id, account: { systemKey: 'ACCOUNTS_PAYABLE' } }, _sum: { creditUsd: true, debitUsd: true } });
    const result = await editContainer({ companyId, shipmentId: first.shipmentId, userId: ctx.admin.id, quantityKg: '19500', reason: 'Correction before final receipt' });
    expect(result.before.quantityKg).toBe('20000');
    expect(result.after.quantityKg).toBe('19500');

    overview = await getOrderOverview(companyId, contract.id);
    expect(Number(overview.shipments[0].orderedKg)).toBe(19500);
    expect(Number(overview.totalKg)).toBe(39500);
    const order = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(order.totalValue.toFixed(2)).toBe('158000.00');
    const payableAfter = await prisma.journalLine.aggregate({ where: { purchaseContractId: contract.id, account: { systemKey: 'ACCOUNTS_PAYABLE' } }, _sum: { creditUsd: true, debitUsd: true } });
    const owedBefore = dec(payableBefore._sum.creditUsd ?? 0).minus(payableBefore._sum.debitUsd ?? 0);
    const owedAfter = dec(payableAfter._sum.creditUsd ?? 0).minus(payableAfter._sum.debitUsd ?? 0);
    expect(owedBefore.minus(owedAfter).toFixed(2)).toBe('2000.00');

    // Old value, new value, who, why — kept.
    const audit = await prisma.auditLog.findFirst({ where: { action: 'CONTAINER_CORRECTED', entityId: first.shipmentId }, orderBy: { createdAt: 'desc' } });
    expect(audit?.before).toMatchObject({ quantityKg: '20000' });
    expect(audit?.after).toMatchObject({ quantityKg: '19500', reason: 'Correction before final receipt' });

    // And it can be marked loaded again.
    await changeShipmentStatus({ shipmentId: first.shipmentId, companyId, userId: ctx.admin.id, toStatus: 'LOADED', loadingDate: utcDate('2026-09-06'), etaDate: utcDate('2026-09-21'), shippingLineId: masters.shippingLine.id });
    overview = await getOrderOverview(companyId, contract.id);
    expect(overview.shipments[0].stage).toBe('LOADED');
  }, 300_000);

  it('refuses to undo or edit a container that is already stock', async () => {
    const contract = await freshOrder('ICUL/FID/UNDO-2');
    await markOrderArrived({ companyId, contractId: contract.id, userId: ctx.admin.id, ataDate: utcDate('2026-09-10') });
    const status = await transaction((tx) => getReceiptStatus(tx, contract.id));
    await receiveContainers({ companyId, purchaseContractId: contract.id, receiptDate: utcDate('2026-09-11'), receivedById: ctx.admin.id, lines: [{ batchId: status[0].batchId, quantityKg: '20000', lotNumber: 'LOT-U1', warehouseId: masters.warehouses[0].id }] });
    const overview = await getOrderOverview(companyId, contract.id);
    await expect(undoLoading({ companyId, shipmentId: overview.shipments[0].shipmentId, userId: ctx.admin.id })).rejects.toThrow(/arrived|already created stock/);
    await expect(editContainer({ companyId, shipmentId: overview.shipments[0].shipmentId, userId: ctx.admin.id, quantityKg: '19000' })).rejects.toThrow(/already been received/);
    // The unreceived one can still be corrected.
    await editContainer({ companyId, shipmentId: overview.shipments[1].shipmentId, userId: ctx.admin.id, containerNumber: 'FIXED-2', lotNumber: 'LOT-U2' });
    const after = await getOrderOverview(companyId, contract.id);
    expect(after.shipments[1].containerNumber).toBe('FIXED-2');
    expect(after.shipments[1].lotNumber).toBe('LOT-U2');
  }, 300_000);
});

describe('adding a container to an approved order', () => {
  it('puts a fourth container on the same order and owes the supplier its value', async () => {
    const contract = await createPurchaseContract(
      {
        companyId, vendorId: masters.vendor.id, contractDate: utcDate('2026-09-01'), currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.85', freightAmount: '0',
        contractReference: 'ICUL/FID/FOURTH', containers: 3,
        lines: [1, 2, 3].map((n) => ({ itemId: masters.item.id, quantity: '20000', unit: 'KG' as const, unitPrice: '4.00', bagWeightKg: '60', containerNumber: `FOURTH-${n}` })),
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
    const owed = async () => {
      const sums = await prisma.journalLine.aggregate({ where: { purchaseContractId: contract.id, account: { systemKey: 'ACCOUNTS_PAYABLE' } }, _sum: { creditUsd: true, debitUsd: true } });
      return dec(sums._sum.creditUsd ?? 0).minus(sums._sum.debitUsd ?? 0);
    };
    const before = await owed();

    const added = await addContainerToOrder({
      companyId, contractId: contract.id, userId: ctx.admin.id,
      itemId: masters.item.id, quantityKg: '19500', unitPriceKg: '4.10', containerNumber: 'FOURTH-4', reason: 'Fourth container confirmed',
    });
    expect(added.lineNumber).toBe(4);

    const overview = await getOrderOverview(companyId, contract.id);
    expect(overview.containerCount).toBe(4);
    expect(overview.totalShipments).toBe(4);
    expect(overview.shipments[3].containerNumber).toBe('FOURTH-4');
    expect(overview.shipments[3].stage).toBe('PENDING_LOADING');
    expect(Number(overview.totalKg)).toBe(79500);

    const order = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(order.totalValue.toFixed(2)).toBe('319950.00');
    expect(order.containers).toBe(4);
    expect((await owed()).minus(before).toFixed(2)).toBe('79950.00');

    // It arrives and is received like any other.
    await changeShipmentStatus({ shipmentId: overview.shipments[3].shipmentId, companyId, userId: ctx.admin.id, toStatus: 'LOADED', loadingDate: utcDate('2026-09-05'), etaDate: utcDate('2026-09-20'), shippingLineId: masters.shippingLine.id });
    await changeShipmentStatus({ shipmentId: overview.shipments[3].shipmentId, companyId, userId: ctx.admin.id, toStatus: 'ARRIVED', ataDate: utcDate('2026-09-21') });
    const status = await transaction((tx) => getReceiptStatus(tx, contract.id));
    const fourth = status.find((r) => r.lineNumber === 4)!;
    await receiveContainers({ companyId, purchaseContractId: contract.id, receiptDate: utcDate('2026-09-22'), receivedById: ctx.admin.id, lines: [{ batchId: fourth.batchId, quantityKg: '19500', lotNumber: 'LOT-4', warehouseId: masters.warehouses[0].id }] });
    const after = await getOrderOverview(companyId, contract.id);
    expect(after.receivedContainers).toBe(1);
    expect(after.shipments[3].stage).toBe('RECEIVED');
  }, 300_000);
});

describe('a reversed order gives its reference back', () => {
  it('lets the same reference be entered again after a reversal', async () => {
    const make = () =>
      createPurchaseContract(
        {
          companyId, vendorId: masters.vendor.id, contractDate: utcDate('2026-09-01'), currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.85', freightAmount: '0',
          contractReference: 'ICUL/FID/AGAIN', containers: 1,
          lines: [{ itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
        },
        ctx.admin.id,
      );
    const first = await make();
    await postPurchaseContract({ id: first.id, companyId, userId: ctx.admin.id });
    await expect(make()).rejects.toThrow(/already used/);

    await reversePurchaseContract({ id: first.id, companyId, userId: ctx.admin.id, reason: 'Entered wrongly' });
    const gone = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: first.id }, select: { contractReference: true, status: true } });
    expect(gone.status).toBe('REVERSED');
    expect(gone.contractReference).toMatch(/^ICUL\/FID\/AGAIN \(reversed /);

    const second = await make();
    expect(second.contractReference).toBe('ICUL/FID/AGAIN');
    await postPurchaseContract({ id: second.id, companyId, userId: ctx.admin.id });
    const overview = await getOrderOverview(companyId, second.id);
    expect(overview.containerCount).toBe(1);
  }, 300_000);
});
