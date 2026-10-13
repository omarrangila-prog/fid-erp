import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createExpense, postExpense, reverseExpense } from '@/lib/services/expense';
import { dec, sum } from '@/lib/money';

/**
 * A cost shared equally per container.
 *
 * Unloading a box, inspecting it, paying for it to wait on the quay: the work
 * happens once per container, so each container bears one share and a coffee's
 * total is the sum of its own containers'. Sharing equally per coffee instead
 * charged a coffee that arrived in three containers the same as one that
 * arrived in a single box.
 *
 * Whatever the number of containers, the shares must add back to the cost
 * exactly: money must not appear or vanish in the division.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let categoryId: string;
let cashId: string;
let n = 0;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '10', effectiveDate: utcDate('2026-01-01') },
  });
  categoryId = (
    await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', capitaliseByDefault: true } })
  ).id;
  cashId = (await getCashAccount(companyId, 'MAD')).id;
}, 300_000);

/**
 * An order of `containers` boxes. Each box is its own contract line, so each
 * gets its own batch and container, and `itemsPerContainer` says which coffee
 * is in it — so one coffee can own several boxes.
 */
async function order(containers: number, coffees = containers) {
  n += 1;
  const items = [masters.item.id];
  for (let i = 1; i < coffees; i += 1) {
    const item = await prisma.coffeeItem.create({
      data: {
        companyId,
        itemCode: `PC-${n}-${i}`,
        itemName: `Coffee ${n}-${i}`,
        coffeeType: 'ROBUSTA',
        originCountry: 'Uganda',
        defaultUnit: 'KG',
        bagWeightKg: '60',
      },
    });
    items.push(item.id);
  }

  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-06-01'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '10',
      freightAmount: '0',
      contractReference: `ICUL/PC/${n}`,
      lines: Array.from({ length: containers }, (_, i) => ({
        itemId: items[i % coffees],
        quantity: '20000',
        unit: 'KG',
        unitPrice: '4.00',
        bagWeightKg: '60',
        lotNumber: `PC-${n}-L${i}`,
        batchNumber: `PC-${n}-B${i}`,
        // A real box per line: the share belongs to the container, so the
        // test has to give each line one.
        containerNumber: `PCBOX${n}${String(i).padStart(2, '0')}`,
      })),
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const batches = await prisma.batch.findMany({
    where: { purchaseContractId: contract.id },
    select: { id: true, itemId: true, containerId: true, shipmentId: true },
    orderBy: { batchNumber: 'asc' },
  });
  return { contractId: contract.id, shipmentId: batches[0].shipmentId, batches };
}

async function cost(shipmentId: string, amountMad: string, containerId?: string) {
  const expense = await createExpense(
    {
      companyId,
      expenseDate: utcDate('2026-06-10'),
      expenseCategoryId: categoryId,
      shipmentId,
      containerId,
      currency: 'MAD',
      amount: amountMad,
      rateToUsd: '10',
      rateLocalPerUsd: '10',
      kind: 'SHIPMENT',
      capitaliseToLandedCost: true,
      allocationMethod: 'PER_CONTAINER',
      paymentMethod: 'BANK_TRANSFER',
      cashBankAccountId: cashId,
      description: 'Unloading, per container',
    } as never,
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
  return expense.id;
}

/** What each batch of the order now carries, in USD. */
async function carried(contractId: string) {
  const rows = await prisma.batch.findMany({
    where: { purchaseContractId: contractId },
    select: { id: true, itemId: true, containerId: true, capitalisedCostUsd: true },
    orderBy: { batchNumber: 'asc' },
  });
  return rows.map((r) => ({ ...r, usd: dec(r.capitalisedCostUsd) }));
}

describe('a cost shared equally per container', () => {
  // MAD 30,000 at 10 to the dollar is USD 3,000 — divisible by 1, 3, 10 and
  // 12 only down to the cent, which is the point of the exercise.
  for (const containers of [1, 3, 10, 12]) {
    it(`divides between ${containers} container${containers === 1 ? '' : 's'}, losing nothing`, async () => {
      const o = await order(containers);
      await cost(o.shipmentId, '30000');

      const rows = await carried(o.contractId);
      expect(rows).toHaveLength(containers);

      // Every container carries the same share, to the cent.
      const each = dec(3000).dividedBy(containers);
      for (const row of rows) expect(row.usd.minus(each).abs().lessThanOrEqualTo('0.01')).toBe(true);

      // And the shares add back to the cost exactly: no money created or lost.
      expect(sum(rows.map((r) => r.usd)).toFixed(2)).toBe('3000.00');
    }, 300_000);
  }

  it("gives a coffee the sum of its own containers' shares, not an equal share of the cost", async () => {
    // 3 containers, 2 coffees: coffee A owns containers 1 and 3, coffee B owns 2.
    const o = await order(3, 2);
    await cost(o.shipmentId, '30000');

    const rows = await carried(o.contractId);
    const byItem = new Map<string, ReturnType<typeof dec>[]>();
    for (const row of rows) byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), row.usd]);

    const totals = [...byItem.values()].map((shares) => ({ containers: shares.length, usd: sum(shares) }));
    const two = totals.find((t) => t.containers === 2);
    const one = totals.find((t) => t.containers === 1);

    // USD 1,000 a container: the coffee in two boxes carries 2,000, not 1,500.
    expect(two?.usd.toFixed(2)).toBe('2000.00');
    expect(one?.usd.toFixed(2)).toBe('1000.00');
    expect(sum(rows.map((r) => r.usd)).toFixed(2)).toBe('3000.00');
  }, 300_000);

  it('keeps a cost booked to one container on that container alone', async () => {
    const o = await order(3);
    const target = o.batches[0];

    // The shared cost, then MAD 5,000 that belongs to the first box only.
    await cost(o.shipmentId, '30000');
    await cost(o.shipmentId, '5000', target.containerId ?? undefined);

    const rows = await carried(o.contractId);
    const first = rows.find((r) => r.id === target.id);
    const others = rows.filter((r) => r.id !== target.id);

    // 1,000 shared + 500 its own.
    expect(first?.usd.toFixed(2)).toBe('1500.00');
    for (const row of others) expect(row.usd.toFixed(2)).toBe('1000.00');

    // The two costs together, once each: not 3,500 a box, and not 1,500 × 3.
    expect(sum(rows.map((r) => r.usd)).toFixed(2)).toBe('3500.00');
  }, 300_000);

  it('is what a cost gets when nobody chooses a method', async () => {
    const o = await order(3);
    // No allocationMethod at all: the share belongs to the container now.
    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-06-10'),
        expenseCategoryId: categoryId,
        shipmentId: o.shipmentId,
        currency: 'MAD',
        amount: '30000',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        kind: 'SHIPMENT',
        capitaliseToLandedCost: true,
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: cashId,
        description: 'Unloading, no method chosen',
      } as never,
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    const stored = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
      select: { allocationMethod: true },
    });
    expect(stored.allocationMethod).toBe('PER_CONTAINER');

    // USD 1,000 a box, not a half each between the coffees.
    for (const row of await carried(o.contractId)) expect(row.usd.toFixed(2)).toBe('1000.00');
  }, 300_000);

  it('takes the cost off again exactly when it is reversed', async () => {
    const o = await order(3);
    const id = await cost(o.shipmentId, '30000');
    expect(sum((await carried(o.contractId)).map((r) => r.usd)).toFixed(2)).toBe('3000.00');

    await reverseExpense({ id, companyId, userId: ctx.admin.id, reason: 'Booked to the wrong order' });

    // Nothing left behind, and nothing driven negative.
    for (const row of await carried(o.contractId)) expect(row.usd.toFixed(2)).toBe('0.00');
  }, 300_000);
});
