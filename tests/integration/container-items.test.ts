import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate, getCashAccount, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract, updatePurchaseContract } from '@/lib/services/purchase';
import { editApprovedPurchase } from '@/lib/services/purchase-edit';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import { createExpense, postExpense } from '@/lib/services/expense';
import { dec } from '@/lib/money';

/**
 * A container is a box; an item is a coffee in it.
 *
 * One container carrying two coffees is one container — on the order, on the
 * loading sheet, as a shipment and in the per-container costing — with a
 * batch for each coffee. Adding a coffee to a container on an approved order
 * leaves the container count where it was; adding a container adds one. The
 * same in every company: Morocco, Dubai and Pakistan.
 */
let ctx: Awaited<ReturnType<typeof getContext>>;
const companies: Array<{ code: string; id: string; local: string; masters: Awaited<ReturnType<typeof createMasters>>; item2: string; item3: string }> = [];

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  for (const code of ['FID-MA', 'FID-DXB', 'FID-PK']) {
    const company = await prisma.company.findUniqueOrThrow({ where: { code } });
    const masters = await createMasters(company.id);
    const extra = async (n: number) =>
      (
        await prisma.coffeeItem.create({
          data: { companyId: company.id, itemCode: `CI-${code}-${n}`, itemName: `Coffee ${n} ${code}`, coffeeType: 'ROBUSTA', originCountry: 'Uganda', bagWeightKg: '60', defaultUnit: 'KG' },
        })
      ).id;
    companies.push({ code, id: company.id, local: company.localCurrency, masters, item2: await extra(2), item3: await extra(3) });
  }
}, 600_000);

type Row = { item: string; kg: string; slot: number; container?: string };
const order = (c: (typeof companies)[number], reference: string, rows: Row[]) =>
  createPurchaseContract(
    {
      companyId: c.id, contractDate: utcDate('2026-11-01'), vendorId: c.masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10',
      freightAmount: '0', contractReference: reference,
      lines: rows.map((r) => ({ itemId: r.item, quantity: r.kg, unit: 'KG' as const, unitPrice: '2.00', bagWeightKg: '60', containerSlot: r.slot, containerNumber: r.container })),
    },
    ctx.admin.id,
  );

const shape = async (contractId: string) => {
  const contract = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contractId }, select: { containers: true } });
  const shipments = await prisma.shipment.findMany({ where: { purchaseContractId: contractId }, include: { batches: { where: { status: 'ACTIVE' } } } });
  return {
    containers: contract.containers,
    shipments: shipments.length,
    items: shipments.reduce((t, s) => t + s.batches.length, 0),
    kg: shipments.reduce((t, s) => t.plus(s.quantityKg), dec(0)).toFixed(0),
    shipmentContainers: shipments.reduce((t, s) => t + s.containers, 0),
  };
};

/** The approved order as it stands, ready to be edited and saved back. */
const asSaved = async (contractId: string) => {
  const o = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contractId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
  return {
    companyId: o.companyId, contractId: o.id, userId: ctx.admin.id, contractReference: o.contractReference, contractDate: o.contractDate, vendorId: o.vendorId,
    currency: o.currency, rateToUsd: o.rateToUsd.toString(), rateLocalPerUsd: o.rateLocalPerUsd.toString(), freightAmount: o.freightAmount.toString(),
    otherCharges: o.otherCharges.toString(), containers: o.containers, notes: o.notes, reason: 'Container correction',
    lines: o.lines.map((l) => ({
      id: l.id, itemId: l.itemId, lotNumber: l.lotNumber, batchNumber: l.batchNumber, containerNumber: l.containerNumber, containerSlot: l.containerSlot ?? l.lineNumber,
      quantity: l.quantity.toString(), unit: l.unit as 'KG', unitPrice: l.unitPrice.toString(), bags: l.bags, bagWeightKg: l.bagWeightKg.toString(),
    })),
  };
};

describe.each(['FID-MA', 'FID-DXB', 'FID-PK'])('%s: containers and items', (code) => {
  const c = () => companies.find((x) => x.code === code)!;
  let oneTwoId = '';

  it('1 container, 1 item → 1 container, 1 item', async () => {
    const po = await order(c(), `${code}/C1I1`, [{ item: c().masters.item.id, kg: '20000', slot: 1 }]);
    await postPurchaseContract({ id: po.id, companyId: c().id, userId: ctx.admin.id });
    expect(await shape(po.id)).toEqual({ containers: 1, shipments: 1, items: 1, kg: '20000', shipmentContainers: 1 });
  }, 120_000);

  it('1 container, 2 items → 1 container, 2 items, on the order, the shipment and the loading sheet', async () => {
    const po = await order(c(), `${code}/C1I2`, [
      { item: c().masters.item.id, kg: '12000', slot: 1, container: `${code.slice(4)}AB1234567` },
      { item: c().item2, kg: '8000', slot: 1, container: `${code.slice(4)}AB1234567` },
    ]);
    // Saved and reopened: both coffees, one box.
    const draft = await prisma.purchaseContractLine.findMany({ where: { purchaseContractId: po.id }, orderBy: { lineNumber: 'asc' } });
    expect(draft.map((l) => l.containerSlot)).toEqual([1, 1]);
    await postPurchaseContract({ id: po.id, companyId: c().id, userId: ctx.admin.id });
    expect(await shape(po.id)).toEqual({ containers: 1, shipments: 1, items: 2, kg: '20000', shipmentContainers: 1 });
    // One physical container record, shared by both coffees.
    const containerIds = new Set((await prisma.batch.findMany({ where: { purchaseContractId: po.id } })).map((b) => b.containerId));
    expect(containerIds.size).toBe(1);
    expect([...containerIds][0]).not.toBeNull();
    const sheet = (await getLoadingSheet(c().id, { contractId: po.id }));
    expect(sheet).toHaveLength(1);
    expect(sheet[0].containers).toBe(1);
    expect(sheet[0].lines).toHaveLength(2);
    expect(sheet[0].quantityKg.toFixed(0)).toBe('20000');
    oneTwoId = po.id;
  }, 120_000);

  it('1 container, 5 items → 1 container, 5 items', async () => {
    const items = [c().masters.item.id, c().item2, c().item3, c().masters.item.id, c().item2];
    const po = await order(c(), `${code}/C1I5`, items.map((item) => ({ item, kg: '4000', slot: 1 })));
    await postPurchaseContract({ id: po.id, companyId: c().id, userId: ctx.admin.id });
    expect(await shape(po.id)).toEqual({ containers: 1, shipments: 1, items: 5, kg: '20000', shipmentContainers: 1 });
  }, 120_000);

  it('2 containers, 4 items → 2 containers, 4 items', async () => {
    const po = await order(c(), `${code}/C2I4`, [
      { item: c().masters.item.id, kg: '10000', slot: 1 },
      { item: c().item2, kg: '10000', slot: 1 },
      { item: c().item3, kg: '10000', slot: 2 },
      { item: c().masters.item.id, kg: '10000', slot: 2 },
    ]);
    await postPurchaseContract({ id: po.id, companyId: c().id, userId: ctx.admin.id });
    expect(await shape(po.id)).toEqual({ containers: 2, shipments: 2, items: 4, kg: '40000', shipmentContainers: 2 });
  }, 120_000);

  it('a draft keeps its containers through edit and save', async () => {
    const po = await order(c(), `${code}/DRAFT`, [{ item: c().masters.item.id, kg: '5000', slot: 1 }]);
    await updatePurchaseContract(
      po.id,
      {
        companyId: c().id, contractDate: utcDate('2026-11-01'), vendorId: c().masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10',
        freightAmount: '0', contractReference: `${code}/DRAFT`,
        lines: [
          { itemId: c().masters.item.id, quantity: '5000', unit: 'KG', unitPrice: '2', bagWeightKg: '60', containerSlot: 1 },
          { itemId: c().item2, quantity: '5000', unit: 'KG', unitPrice: '2', bagWeightKg: '60', containerSlot: 1 },
        ],
      },
      ctx.admin.id,
    );
    const saved = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
    expect(saved.containers).toBe(1);
    expect(saved.lines.map((l) => l.containerSlot)).toEqual([1, 1]);
  }, 120_000);

  it('editing an approved order: an item added to a container leaves the count; a container added adds one', async () => {
    const before = await shape(oneTwoId);
    const edit = await asSaved(oneTwoId);
    await editApprovedPurchase({
      ...edit,
      lines: [...edit.lines, { itemId: c().item3, quantity: '2000', unit: 'KG', unitPrice: '2.00', bagWeightKg: '60', containerSlot: 1, containerNumber: edit.lines[0].containerNumber } as never],
    });
    const added = await shape(oneTwoId);
    expect(added).toEqual({ ...before, items: before.items + 1, kg: '22000' });
    // The new coffee is in the same physical container record.
    expect(new Set((await prisma.batch.findMany({ where: { purchaseContractId: oneTwoId } })).map((b) => b.containerId)).size).toBe(1);

    const again = await asSaved(oneTwoId);
    await editApprovedPurchase({ ...again, lines: [...again.lines, { itemId: c().item2, quantity: '3000', unit: 'KG', unitPrice: '2.00', bagWeightKg: '60', containerSlot: 2 } as never] });
    expect(await shape(oneTwoId)).toEqual({ containers: 2, shipments: 2, items: 4, kg: '25000', shipmentContainers: 2 });
  }, 180_000);

  it('a per-container cost is shared once per container, not once per item', async () => {
    const po = await order(c(), `${code}/COST`, [
      { item: c().masters.item.id, kg: '12000', slot: 1 },
      { item: c().item2, kg: '8000', slot: 1 },
      { item: c().item3, kg: '10000', slot: 2 },
    ]);
    await postPurchaseContract({ id: po.id, companyId: c().id, userId: ctx.admin.id });
    const shipments = await prisma.shipment.findMany({ where: { purchaseContractId: po.id } });
    const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId: c().id, kind: 'SHIPMENT' } });
    const bank = await getCashAccount(c().id, c().local);
    // One cost for the whole order, per container: 2 containers, so 300 each.
    const expense = await createExpense(
      {
        companyId: c().id, expenseDate: utcDate('2026-11-05'), expenseCategoryId: category.id, kind: 'SHIPMENT', shipmentId: shipments[0].id,
        currency: c().local, amount: '6000', rateToUsd: '10', rateLocalPerUsd: '10', paymentMethod: 'BANK_TRANSFER', cashBankAccountId: bank.id,
        capitaliseToLandedCost: true, allocationMethod: 'PER_CONTAINER', applyToOrder: true, description: 'Unloading per container',
      } as never,
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId: c().id, userId: ctx.admin.id });
    const shares = await prisma.expenseBatchShare.findMany({ where: { expenseId: expense.id }, include: { batch: { select: { shipmentId: true } } } });
    const byShipment = new Map<string, number>();
    for (const s of shares) byShipment.set(s.batch.shipmentId, (byShipment.get(s.batch.shipmentId) ?? 0) + Number(s.amountUsd));
    const total = [...byShipment.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(600, 2);
    // Each box carries its own share; the two-item box does not carry two.
    if (byShipment.size === 2) for (const v of byShipment.values()) expect(v).toBeCloseTo(300, 2);
  }, 180_000);

  it('receiving a two-item container puts each coffee in stock once, by item', async () => {
    const po = await order(c(), `${code}/RCV`, [
      { item: c().masters.item.id, kg: '12000', slot: 1 },
      { item: c().item2, kg: '8000', slot: 1 },
    ]);
    await postPurchaseContract({ id: po.id, companyId: c().id, userId: ctx.admin.id });
    await receiveEverything({ companyId: c().id, purchaseContractId: po.id, warehouseId: c().masters.warehouse.id, userId: ctx.admin.id, receiptDate: utcDate('2026-11-10') });
    const batches = await prisma.batch.findMany({ where: { purchaseContractId: po.id }, include: { balances: true } });
    const onHand = (itemId: string) =>
      batches.filter((b) => b.itemId === itemId).reduce((t, b) => t + b.balances.reduce((u, r) => u + Number(r.onHandKg), 0), 0);
    expect(onHand(c().masters.item.id)).toBe(12000);
    expect(onHand(c().item2)).toBe(8000);
  }, 180_000);
});

describe('an order entered before containers and items were told apart', () => {
  it('two coffees opened as two shipments are put back into one container by editing the order', async () => {
    const c = companies.find((x) => x.code === 'FID-PK')!;
    // As the client's Pakistan order was saved: two rows, no container stated.
    const po = await createPurchaseContract(
      {
        companyId: c.id, contractDate: utcDate('2026-11-01'), vendorId: c.masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '280',
        freightAmount: '0', contractReference: 'LEGACY/PK/1', containers: 1,
        lines: [
          { itemId: c.masters.item.id, quantity: '6000', unit: 'KG', unitPrice: '2', bagWeightKg: '60' },
          { itemId: c.item2, quantity: '6000', unit: 'KG', unitPrice: '2', bagWeightKg: '60' },
        ],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: po.id, companyId: c.id, userId: ctx.admin.id });
    expect((await shape(po.id)).shipments).toBe(2);

    const edit = await asSaved(po.id);
    await editApprovedPurchase({ ...edit, lines: edit.lines.map((l) => ({ ...l, containerSlot: 1 })) });
    expect(await shape(po.id)).toEqual({ containers: 1, shipments: 1, items: 2, kg: '12000', shipmentContainers: 1 });
    const sheet = await getLoadingSheet(c.id, { contractId: po.id });
    expect(sheet).toHaveLength(1);
    expect(sheet[0].containers).toBe(1);
    expect(sheet[0].lines).toHaveLength(2);
  }, 180_000);
});
