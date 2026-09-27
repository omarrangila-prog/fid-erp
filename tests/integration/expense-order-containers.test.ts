import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createExpense, postExpense } from '@/lib/services/expense';
import { loadExpenseFormOptions } from '@/app/(app)/finance/expenses/load-expense-form';

/**
 * The shipment expense form offers the order, and every container on it.
 *
 * An order holds one shipment record per container. The form used to offer
 * each record and, once one was chosen, only that record's container — a
 * three-container order showed one. Now the order is offered once with all
 * three; a cost named to container 2 lands on container 2 only, and a cost
 * for the whole shipment is one expense spread across all three — equally,
 * as each carries a different coffee.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let threeId: string;
let twoId: string;
let categoryId: string;

async function order(reference: string, containers: string[]) {
  // A different coffee in each container: the whole-shipment split is equal
  // between coffees (and by weight between containers of the same coffee).
  const items = await Promise.all(
    containers.map((_, i) =>
      prisma.coffeeItem.create({
        data: {
          companyId, itemCode: `${reference}-ITM-${i + 1}`, itemName: `Robusta Screen ${12 + i * 3} ${reference}`,
          coffeeType: 'ROBUSTA', originCountry: 'Uganda', defaultUnit: 'KG', bagWeightKg: '60',
        },
      }),
    ),
  );
  const vendor = await prisma.vendor.findFirstOrThrow({ where: { companyId } });
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-09-01'), vendorId: vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10',
      freightAmount: '0', contractReference: reference,
      lines: containers.map((containerNumber, i) => ({
        itemId: items[i].id, quantity: String(20000 + i * 1000), unit: 'KG' as const, unitPrice: '4.00', bagWeightKg: '60',
        containerNumber, lotNumber: `${reference}-LOT-${i + 1}`, batchNumber: `${reference}-B-${i + 1}`,
      })),
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  return contract.id;
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  await createMasters(companyId, { currency: 'MAD' });
  threeId = await order('ICUL/FID/3C', ['TCLU0000001', 'TCLU0000002', 'TCLU0000003']);
  twoId = await order('HRCC/2C', ['CAAU0000001', 'CAAU0000002']);
  categoryId = (
    await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', status: 'ACTIVE', capitaliseByDefault: true }, orderBy: { code: 'asc' } })
  ).id;
}, 300_000);

describe('the form offers the order and all its containers', () => {
  it('three containers on three records: one entry, three containers, from whichever record', async () => {
    const options = await loadExpenseFormOptions(companyId);
    const records = await prisma.shipment.findMany({ where: { purchaseContractId: threeId }, select: { id: true } });
    expect(records).toHaveLength(3);
    expect(options.shipments.filter((s) => s.label === 'ICUL/FID/3C')).toHaveLength(1);
    const entry = options.shipments.find((s) => s.label === 'ICUL/FID/3C')!;
    expect(entry.hint).toMatch(/^3 containers/);
    for (const record of records) {
      expect(options.orderShipmentId[record.id]).toBe(entry.value);
      const containers = options.traceByShipment[record.id].containers;
      expect(containers.map((c) => c.label.split(' — ')[0])).toEqual(['TCLU0000001', 'TCLU0000002', 'TCLU0000003']);
    }
    expect(options.traceByShipment[entry.value].containers[1].label).toMatch(/TCLU0000002 — .+ — 21,000 KG/);
  }, 300_000);

  it('two containers: two', async () => {
    const options = await loadExpenseFormOptions(companyId);
    const entry = options.shipments.find((s) => s.label === 'HRCC/2C')!;
    expect(options.traceByShipment[entry.value].containers).toHaveLength(2);
  }, 300_000);
});

describe('costs land where they are named', () => {
  const capitalised = async () =>
    Object.fromEntries(
      (
        await prisma.batch.findMany({
          where: { purchaseContractId: threeId },
          select: { batchNumber: true, capitalisedCostUsd: true },
          orderBy: { batchNumber: 'asc' },
        })
      ).map((b) => [b.batchNumber, Number(b.capitalisedCostUsd)]),
    );
  const book = async (amount: string, containerId: string | null) => {
    const options = await loadExpenseFormOptions(companyId);
    const entry = options.shipments.find((s) => s.label === 'ICUL/FID/3C')!;
    const expense = await createExpense(
      {
        companyId, expenseDate: utcDate('2026-09-10'), expenseCategoryId: categoryId, kind: 'SHIPMENT', shipmentId: entry.value,
        containerId, currency: 'MAD', amount, rateToUsd: '10', rateLocalPerUsd: '10', paymentMethod: 'BANK_TRANSFER',
        capitaliseToLandedCost: true, allocationMethod: 'PER_ITEM', description: `test ${amount}`,
      } as never,
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
    return expense.id;
  };

  it('a cost on container 2 lands on container 2 only, filed under the record that carries it', async () => {
    const container = await prisma.container.findFirstOrThrow({ where: { containerNumber: 'TCLU0000002' } });
    const before = await capitalised();
    const id = await book('6000', container.id);
    const after = await capitalised();
    expect(after['ICUL/FID/3C-B-2'] - before['ICUL/FID/3C-B-2']).toBeCloseTo(600, 2);
    expect(after['ICUL/FID/3C-B-1']).toBeCloseTo(before['ICUL/FID/3C-B-1'], 2);
    expect(after['ICUL/FID/3C-B-3']).toBeCloseTo(before['ICUL/FID/3C-B-3'], 2);
    const expense = await prisma.expense.findUniqueOrThrow({ where: { id } });
    expect(expense.shipmentId).toBe(container.shipmentId);
    expect(expense.containerId).toBe(container.id);
  }, 300_000);

  it('a MAD 30,000 cost for the whole shipment is one expense, spread 10,000 on each container', async () => {
    const before = await capitalised();
    const count = await prisma.expense.count({ where: { companyId } });
    await book('30000', null);
    expect(await prisma.expense.count({ where: { companyId } })).toBe(count + 1);
    const after = await capitalised();
    for (const b of ['ICUL/FID/3C-B-1', 'ICUL/FID/3C-B-2', 'ICUL/FID/3C-B-3']) {
      expect(after[b] - before[b], b).toBeCloseTo(1000, 2);
    }
    const total = Object.values(after).reduce((t, v) => t + v, 0) - Object.values(before).reduce((t, v) => t + v, 0);
    expect(total).toBeCloseTo(3000, 2);
    // And on the order's own figures: one 30,000 and one 6,000, nothing twice.
    const costs = await prisma.expense.aggregate({ where: { companyId, purchaseContractId: threeId, status: 'POSTED' }, _sum: { amountLocal: true } });
    expect(Number(costs._sum.amountLocal)).toBeCloseTo(36_000, 2);
  }, 300_000);
});
