import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract, removeContainerFromOrder, addContainerToOrder } from '@/lib/services/purchase';
import { receiveContainers } from '@/lib/services/goods-receipt';
import { markShipmentArrived, undoArrival } from '@/lib/services/shipment';
import { getLoadingSheet } from '@/lib/services/loading-sheet';

/**
 * Two corrections from the list: a container marked arrived by mistake goes
 * back to Not arrived, and a container that is not coming is taken off its
 * order.
 *
 * The order: three containers of 20,000 KG at USD 5.00 — USD 100,000 each,
 * USD 300,000 owed. Removing one leaves USD 200,000 owed, posted as its own
 * entry so the original posting and the correction both stay in the books,
 * and the container's row, shipment, batch and lot are gone from every list.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let orderId: string;
let shipments: string[] = [];

async function order(reference: string, containers: string[]) {
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-09-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0', contractReference: reference,
      lines: containers.map((container, i) => ({
        itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '5.00', bagWeightKg: '60',
        containerNumber: container, lotNumber: `${reference}-L${i + 1}`, batchNumber: `${reference}-B${i + 1}`,
      })),
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const rows = await prisma.shipment.findMany({ where: { purchaseContractId: contract.id }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  return { id: contract.id, shipments: rows.map((r) => r.id) };
}

/** USD booked against the order on one account: debits less credits, every posted entry. */
async function booked(contractId: string, key: 'ACCOUNTS_PAYABLE' | 'INVENTORY_IN_TRANSIT') {
  const [row] = await prisma.$queryRawUnsafe<Array<{ v: string | null }>>(
    `SELECT SUM(jl."debitUsd" - jl."creditUsd")::text v
       FROM journal_lines jl
       JOIN journal_entries je ON je."id" = jl."journalEntryId"
       JOIN accounts a ON a."id" = jl."accountId"
      WHERE je."companyId" = $1 AND je."status" = 'POSTED' AND jl."purchaseContractId" = $2 AND a."systemKey" = $3`,
    companyId,
    contractId,
    key,
  );
  return Number(row?.v ?? 0);
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  ({ id: orderId, shipments } = await order('ICUL/FID/CC/001', ['CCCU1000001', 'CCCU1000002', 'CCCU1000003']));
}, 300_000);

describe('undo arrival', () => {
  it('moves a container marked arrived by mistake back to Loaded, clears its arrival and keeps the history', async () => {
    await markShipmentArrived({ companyId, shipmentId: shipments[0], userId: ctx.admin.id, ataDate: utcDate('2026-10-14') });
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipments[0] } })).status).toBe('ARRIVED');

    await undoArrival({ companyId, shipmentId: shipments[0], userId: ctx.admin.id, reason: 'Wrong container ticked' });
    const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipments[0] }, select: { status: true, ataDate: true } });
    expect(after).toEqual({ status: 'LOADED', ataDate: null });

    const history = await prisma.shipmentStatusHistory.findMany({ where: { shipmentId: shipments[0] }, orderBy: { changedAt: 'desc' } });
    expect(history[0]).toMatchObject({ fromStatus: 'ARRIVED', toStatus: 'LOADED' });
    expect(history[0].notes).toMatch(/Wrong container ticked/);
    expect(await prisma.auditLog.count({ where: { entityId: shipments[0], action: 'SHIPMENT_ARRIVAL_UNDONE' } })).toBe(1);
  }, 120_000);

  it('is refused for a container that is not arrived, and once it has been received', async () => {
    await expect(undoArrival({ companyId, shipmentId: shipments[1], userId: ctx.admin.id })).rejects.toThrow(/not marked arrived/);

    await markShipmentArrived({ companyId, shipmentId: shipments[0], userId: ctx.admin.id, ataDate: utcDate('2026-10-14') });
    const batch = await prisma.batch.findFirstOrThrow({ where: { shipmentId: shipments[0], status: 'ACTIVE' } });
    await receiveContainers({
      companyId, purchaseContractId: orderId, receiptDate: utcDate('2026-10-15'), receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '20000', containerNumber: 'CCCU1000001', warehouseId: masters.warehouse.id } as never],
    });
    await expect(undoArrival({ companyId, shipmentId: shipments[0], userId: ctx.admin.id })).rejects.toThrow(/received/);
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipments[0] } })).status).toBe('ARRIVED');
  }, 180_000);

  it('never touches another company’s container', async () => {
    await expect(undoArrival({ companyId: ctx.dubai.id, shipmentId: shipments[0], userId: ctx.admin.id })).rejects.toThrow(/not found/i);
  }, 60_000);
});

describe('remove one container from an order', () => {
  it('takes container 3 off: USD 100,000 less owed, the correction posted beside the original, its records gone', async () => {
    expect(await booked(orderId, 'ACCOUNTS_PAYABLE')).toBeCloseTo(-300_000, 2);
    // Container 1 is already received, so its USD 100,000 has moved from in transit into stock.
    const inTransitBefore = await booked(orderId, 'INVENTORY_IN_TRANSIT');
    expect(inTransitBefore).toBeCloseTo(200_000, 2);
    const entriesBefore = await prisma.journalEntry.count({ where: { companyId, sourceType: 'PURCHASE_CONTRACT', sourceId: orderId } });
    const third = await prisma.shipment.findUniqueOrThrow({ where: { id: shipments[2] }, include: { batches: true } });
    const lineId = third.purchaseContractLineId!;
    const batchId = third.batches[0].id;
    const lotId = third.batches[0].lotId;

    const result = await removeContainerFromOrder({ companyId, shipmentId: shipments[2], userId: ctx.admin.id, reason: 'Supplier is shipping only two' });
    expect(result.containerNumbers).toEqual(['CCCU1000003']);

    // The money: owed USD 200,000, and USD 100,000 less in transit — the correction its own entry.
    expect(await booked(orderId, 'ACCOUNTS_PAYABLE')).toBeCloseTo(-200_000, 2);
    expect(await booked(orderId, 'INVENTORY_IN_TRANSIT')).toBeCloseTo(inTransitBefore - 100_000, 2);
    expect(await prisma.journalEntry.count({ where: { companyId, sourceType: 'PURCHASE_CONTRACT', sourceId: orderId } })).toBe(entriesBefore + 1);
    const contract = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: orderId } });
    expect(Number(contract.totalValue)).toBeCloseTo(200_000, 2);
    expect(contract.status).toBe('POSTED');

    // Its own records are gone; the other two containers are untouched.
    expect(await prisma.shipment.findUnique({ where: { id: shipments[2] } })).toBeNull();
    expect(await prisma.batch.findUnique({ where: { id: batchId } })).toBeNull();
    expect(await prisma.lot.findUnique({ where: { id: lotId } })).toBeNull();
    expect(await prisma.purchaseContractLine.findUnique({ where: { id: lineId } })).toBeNull();
    expect(await prisma.container.findFirst({ where: { companyId, containerNumber: 'CCCU1000003' } })).toBeNull();

    // The sheet: two containers now, "Shipment 1 of 2" and "2 of 2".
    const rows = await getLoadingSheet(companyId, { contractId: orderId });
    expect(rows.map((r) => r.shipmentsOnOrder)).toEqual([2, 2]);
    expect(rows.flatMap((r) => r.containerNumbers).sort()).toEqual(['CCCU1000001', 'CCCU1000002']);

    // And the audit log keeps a full copy of what went, who and why.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: orderId, action: 'CONTAINER_REMOVED' } });
    expect(JSON.stringify(audit.before)).toMatch(/CCCU1000003/);
    expect(JSON.stringify(audit.after)).toMatch(/Supplier is shipping only two/);
  }, 180_000);

  it('is refused for a received container, the last container, costed coffee, and another company', async () => {
    await expect(removeContainerFromOrder({ companyId, shipmentId: shipments[0], userId: ctx.admin.id, reason: 'Try a received one' })).rejects.toThrow(/received/);

    // Costs spread onto a container keep it on the order.
    const second = await prisma.batch.findFirstOrThrow({ where: { shipmentId: shipments[1] } });
    await prisma.batch.update({ where: { id: second.id }, data: { capitalisedCostUsd: '10' } });
    await expect(removeContainerFromOrder({ companyId, shipmentId: shipments[1], userId: ctx.admin.id, reason: 'Try a costed one' })).rejects.toThrow(/Costs have been spread/);
    await prisma.batch.update({ where: { id: second.id }, data: { capitalisedCostUsd: '0' } });

    await expect(removeContainerFromOrder({ companyId: ctx.dubai.id, shipmentId: shipments[1], userId: ctx.admin.id, reason: 'Wrong company' })).rejects.toThrow(/not found/i);
    await expect(removeContainerFromOrder({ companyId, shipmentId: shipments[1], userId: ctx.admin.id, reason: '' })).rejects.toThrow(/why/i);

    // A two-container order: one can go, the last cannot — that is deleting the shipment.
    const two = await order('ICUL/FID/CC/002', ['CCCU2000001', 'CCCU2000002']);
    await removeContainerFromOrder({ companyId, shipmentId: two.shipments[1], userId: ctx.admin.id, reason: 'Only one coming' });
    await expect(removeContainerFromOrder({ companyId, shipmentId: two.shipments[0], userId: ctx.admin.id, reason: 'And this one' })).rejects.toThrow(/only container/);
    expect(await booked(two.id, 'ACCOUNTS_PAYABLE')).toBeCloseTo(-100_000, 2);
  }, 180_000);

  it('a container added after approval can be taken off again, and the books net to nothing for it', async () => {
    const before = await booked(orderId, 'ACCOUNTS_PAYABLE');
    const added = await addContainerToOrder({
      companyId, contractId: orderId, userId: ctx.admin.id, itemId: masters.item.id, quantityKg: '10000', unitPriceKg: '5.00',
      containerNumber: 'CCCU1000009', lotNumber: 'CC-L9', batchNumber: 'CC-B9', reason: 'Fourth box',
    });
    expect(await booked(orderId, 'ACCOUNTS_PAYABLE')).toBeCloseTo(before - 50_000, 2);
    // The addition's own entry names the new container.
    expect(await prisma.journalLine.count({ where: { shipmentId: added.shipmentId } })).toBeGreaterThan(0);

    await removeContainerFromOrder({ companyId, shipmentId: added.shipmentId, userId: ctx.admin.id, reason: 'Added by mistake' });
    expect(await booked(orderId, 'ACCOUNTS_PAYABLE')).toBeCloseTo(before, 2);
    expect(await prisma.shipment.findUnique({ where: { id: added.shipmentId } })).toBeNull();
    // Its entries keep their amounts and the order's tag; the audit log lists them.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: orderId, action: 'CONTAINER_REMOVED' }, orderBy: { createdAt: 'desc' } });
    expect((audit.before as { untaggedJournalLines: string[] }).untaggedJournalLines.length).toBeGreaterThan(0);
  }, 180_000);
});
