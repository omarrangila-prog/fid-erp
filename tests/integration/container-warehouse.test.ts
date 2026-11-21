import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { changeContainerWarehouse } from '@/lib/services/container-warehouse';

/**
 * Change warehouse, from the shipment page.
 *
 * Six containers arrive and one is booked into the wrong warehouse. Moving it
 * puts every coffee in that container in the right one — and only that
 * container: the others stay where they are, the company's stock does not
 * change, a transfer is recorded, and nothing is posted to the books.
 */
let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let wrong: string;
let right: string;
let contractId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId);
  wrong = masters.warehouse.id;
  right = (await prisma.warehouse.create({ data: { companyId, code: 'WH-RIGHT', name: 'Right Warehouse' } })).id;
  const item2 = (
    await prisma.coffeeItem.create({
      data: { companyId, itemCode: 'CI-WH-2', itemName: 'Coffee WH 2', coffeeType: 'ROBUSTA', originCountry: 'Uganda', bagWeightKg: '60', defaultUnit: 'KG' },
    })
  ).id;
  // Container 1 carries two coffees; container 2 one.
  const po = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-11-01'), vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10',
      freightAmount: '0', contractReference: 'WH/MOVE/1',
      lines: [
        { itemId: masters.item.id, quantity: '12000', unit: 'KG' as const, unitPrice: '2.00', bagWeightKg: '60', containerSlot: 1, containerNumber: 'MOVE0000001' },
        { itemId: item2, quantity: '6000', unit: 'KG' as const, unitPrice: '2.00', bagWeightKg: '60', containerSlot: 1, containerNumber: 'MOVE0000001' },
        { itemId: masters.item.id, quantity: '19200', unit: 'KG' as const, unitPrice: '2.00', bagWeightKg: '60', containerSlot: 2, containerNumber: 'MOVE0000002' },
      ],
    },
    ctx.admin.id,
  );
  contractId = po.id;
  await postPurchaseContract({ id: po.id, companyId, userId: ctx.admin.id });
  await receiveEverything({ companyId, purchaseContractId: po.id, warehouseId: wrong, userId: ctx.admin.id, receiptDate: utcDate('2026-11-10') });
}, 300_000);

const where = async () => {
  const batches = await prisma.batch.findMany({
    where: { purchaseContractId: contractId },
    include: { container: { select: { containerNumber: true } }, balances: true },
  });
  return batches.map((b) => ({
    container: b.container?.containerNumber,
    kg: Object.fromEntries(b.balances.filter((r) => Number(r.onHandKg) !== 0).map((r) => [r.warehouseId === right ? 'right' : 'wrong', Number(r.onHandKg)])),
    bags: b.balances.reduce((t, r) => t + r.bags, 0),
  }));
};

describe('change warehouse for one container', () => {
  it('moves every coffee in that container, and only that container', async () => {
    const entriesBefore = await prisma.journalEntry.count({ where: { companyId } });
    const first = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contractId, container: { containerNumber: 'MOVE0000001' } } });
    const result = await changeContainerWarehouse({ companyId, batchId: first.id, toWarehouseId: right, transferDate: utcDate('2026-11-11'), userId: ctx.admin.id });

    expect(result.transfers).toHaveLength(1);
    expect(Number(result.movedKg)).toBe(18000);
    const now = await where();
    for (const row of now.filter((r) => r.container === 'MOVE0000001')) expect(Object.keys(row.kg)).toEqual(['right']);
    expect(now.find((r) => r.container === 'MOVE0000002')!.kg).toEqual({ wrong: 19200 });
    // Bags travel with the coffee: 200 + 100 in the moved box, 320 left.
    expect(now.filter((r) => r.container === 'MOVE0000001').reduce((t, r) => t + r.bags, 0)).toBe(300);

    // A move between the company's own warehouses posts nothing.
    expect(await prisma.journalEntry.count({ where: { companyId } })).toBe(entriesBefore);
    const transfer = await prisma.stockTransfer.findFirstOrThrow({ where: { companyId, transferNumber: result.transfers[0] } });
    expect(transfer.workflowState).toBe('RECEIVED');
  }, 180_000);

  it('says so when the container is already there', async () => {
    const first = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contractId, container: { containerNumber: 'MOVE0000001' } } });
    await expect(
      changeContainerWarehouse({ companyId, batchId: first.id, toWarehouseId: right, transferDate: utcDate('2026-11-11'), userId: ctx.admin.id }),
    ).rejects.toThrow(/already all in Right Warehouse/);
  }, 60_000);

  it('keeps the company total the same', async () => {
    const total = (await where()).reduce((t, r) => t + Object.values(r.kg).reduce((a, b) => a + b, 0), 0);
    expect(total).toBe(37200);
  }, 60_000);
});
