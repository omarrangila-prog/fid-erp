import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract, addContainerToOrder } from '@/lib/services/purchase';
import { editApprovedPurchase } from '@/lib/services/purchase-edit';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createExpense, postExpense, reverseExpense, updateExpense } from '@/lib/services/expense';
import { reconcile } from '@/lib/services/reconciliation';
import { dec } from '@/lib/money';

/**
 * Three ways to share a cost booked to the whole order, and taking a cost
 * back exactly.
 *
 * The order: coffee A, 20,000 KG at USD 4.00 (USD 80,000), and coffee B,
 * 10,000 KG at USD 5.00 (USD 50,000). A USD 3,000 clearing bill is shared
 *
 *   equally per coffee   1,500     / 1,500
 *   by weight            2,000     / 1,000
 *   by value             1,846.15  / 1,153.85
 *
 * And whichever way it went on, deleting the bill takes exactly that off
 * again — after a price correction, a container added, or a receipt that
 * divided a batch. Recomputing the split with today's weights would move
 * cost onto coffee that never carried it.
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
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '10', effectiveDate: utcDate('2026-01-01') } });
  categoryId = (await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', capitaliseByDefault: true } })).id;
  cashId = (await getCashAccount(companyId, 'MAD')).id;
}, 300_000);

async function order() {
  n += 1;
  const itemB = await prisma.coffeeItem.create({
    data: { companyId, itemCode: `ALLOC-B-${n}`, itemName: `Coffee B ${n}`, coffeeType: 'ROBUSTA', originCountry: 'Uganda', defaultUnit: 'KG', bagWeightKg: '60' },
  });
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-06-01'), vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1',
      rateLocalPerUsd: '10', freightAmount: '0', contractReference: `ICUL/ALLOC/${n}`,
      lines: [
        { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: `ALLOC-A-${n}` },
        { itemId: itemB.id, quantity: '10000', unit: 'KG', unitPrice: '5.00', bagWeightKg: '60', lotNumber: `ALLOC-B-${n}` },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const batches = await prisma.batch.findMany({ where: { purchaseContractId: contract.id }, orderBy: { orderedQuantityKg: 'desc' } });
  return { contractId: contract.id, shipmentId: batches[0].shipmentId, a: batches[0].id, b: batches[1].id };
}

async function cost(shipmentId: string, method: 'PER_ITEM' | 'BY_WEIGHT' | 'BY_VALUE') {
  const expense = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-06-10'), expenseCategoryId: categoryId, shipmentId, currency: 'MAD',
      amount: '30000', rateToUsd: '10', rateLocalPerUsd: '10', kind: 'SHIPMENT', capitaliseToLandedCost: true,
      allocationMethod: method, paymentMethod: 'BANK_TRANSFER', cashBankAccountId: cashId, description: `Clearing, ${method}`,
    } as never,
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
  return expense.id;
}

const capitalised = async (batchId: string) =>
  Number((await prisma.batch.findUniqueOrThrow({ where: { id: batchId }, select: { capitalisedCostUsd: true } })).capitalisedCostUsd);

async function orderCapitalised(contractId: string) {
  const rows = await prisma.batch.findMany({ where: { purchaseContractId: contractId }, select: { capitalisedCostUsd: true } });
  return rows.map((r) => Number(r.capitalisedCostUsd));
}

describe('the three ways to share', () => {
  it('equally per coffee: 1,500 and 1,500', async () => {
    const o = await order();
    await cost(o.shipmentId, 'PER_ITEM');
    expect(await capitalised(o.a)).toBeCloseTo(1_500, 2);
    expect(await capitalised(o.b)).toBeCloseTo(1_500, 2);
  }, 300_000);

  it('by weight: 2,000 and 1,000', async () => {
    const o = await order();
    await cost(o.shipmentId, 'BY_WEIGHT');
    expect(await capitalised(o.a)).toBeCloseTo(2_000, 2);
    expect(await capitalised(o.b)).toBeCloseTo(1_000, 2);
  }, 300_000);

  it('by value: 1,846.15 and 1,153.85, adding to the bill exactly', async () => {
    const o = await order();
    const id = await cost(o.shipmentId, 'BY_VALUE');
    expect(await capitalised(o.a)).toBeCloseTo(1_846.15, 2);
    expect(await capitalised(o.b)).toBeCloseTo(1_153.85, 2);
    const shares = await prisma.expenseBatchShare.findMany({ where: { expenseId: id } });
    expect(shares.reduce((t, s) => t.plus(dec(s.amountUsd)), dec(0)).toNumber()).toBeCloseTo(3_000, 2);
  }, 300_000);
});

describe('taken back exactly as it went on', () => {
  it('after the order price was corrected', async () => {
    const o = await order();
    const id = await cost(o.shipmentId, 'BY_VALUE');
    const contract = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: o.contractId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
    // Coffee A's price doubles: by today's values it would carry far more.
    await editApprovedPurchase({
      companyId, contractId: o.contractId, userId: ctx.admin.id, contractReference: contract.contractReference,
      contractDate: contract.contractDate, vendorId: contract.vendorId, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10',
      freightAmount: '0', containers: contract.containers,
      lines: contract.lines.map((l, i) => ({
        id: l.id, itemId: l.itemId, lotNumber: l.lotNumber, batchNumber: l.batchNumber, containerNumber: l.containerNumber,
        quantity: l.quantity.toString(), unit: 'KG' as const, unitPrice: i === 0 ? '8.00' : l.unitPrice.toString(), bagWeightKg: '60',
      })),
    });
    await reverseExpense({ id, companyId, userId: ctx.admin.id, reason: 'Entered twice' });
    for (const value of await orderCapitalised(o.contractId)) expect(value).toBeCloseTo(0, 2);
  }, 300_000);

  it('after a container was added to the order', async () => {
    const o = await order();
    const id = await cost(o.shipmentId, 'PER_ITEM');
    const itemC = await prisma.coffeeItem.create({
      data: { companyId, itemCode: `ALLOC-C-${n}`, itemName: `Coffee C ${n}`, coffeeType: 'ROBUSTA', originCountry: 'Uganda', defaultUnit: 'KG', bagWeightKg: '60' },
    });
    await addContainerToOrder({ companyId, contractId: o.contractId, userId: ctx.admin.id, itemId: itemC.id, quantityKg: '5000', unitPriceKg: '4.50' });
    await reverseExpense({ id, companyId, userId: ctx.admin.id, reason: 'Wrong shipment' });
    // Nothing negative on the new container, nothing left on the others.
    for (const value of await orderCapitalised(o.contractId)) expect(value).toBeCloseTo(0, 2);
  }, 300_000);

  it('after a receipt divided a batch', async () => {
    const o = await order();
    const id = await cost(o.shipmentId, 'BY_WEIGHT');
    const grn = await createGoodsReceipt(
      {
        companyId, purchaseContractId: o.contractId, warehouseId: masters.warehouses[0].id, receiptDate: utcDate('2026-06-20'),
        receivedById: ctx.admin.id, lines: [{ batchId: o.a, quantityKg: '5000', lotNumber: `SPLIT-${n}` }],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });
    const pieces = await prisma.batch.count({ where: { purchaseContractId: o.contractId } });
    expect(pieces).toBe(3);
    // The records followed the coffee: they still add up to what each batch carries.
    for (const batch of await prisma.batch.findMany({ where: { purchaseContractId: o.contractId } })) {
      const recorded = await prisma.expenseBatchShare.aggregate({ where: { batchId: batch.id }, _sum: { amountUsd: true } });
      expect(Number(recorded._sum.amountUsd ?? 0)).toBeCloseTo(Number(batch.capitalisedCostUsd), 2);
    }
    await reverseExpense({ id, companyId, userId: ctx.admin.id, reason: 'Duplicate' });
    for (const value of await orderCapitalised(o.contractId)) expect(value).toBeCloseTo(0, 2);
  }, 300_000);
});

describe('changing the way a posted cost is shared', () => {
  it('moves it to the new split, and only it', async () => {
    const o = await order();
    const id = await cost(o.shipmentId, 'PER_ITEM');
    const posted = await prisma.expense.findUniqueOrThrow({ where: { id } });
    await updateExpense(
      id,
      {
        companyId, expenseDate: posted.expenseDate, expenseCategoryId: posted.expenseCategoryId, shipmentId: posted.shipmentId,
        currency: 'MAD', amount: '30000', rateToUsd: '10', rateLocalPerUsd: '10', kind: 'SHIPMENT', capitaliseToLandedCost: true,
        allocationMethod: 'BY_WEIGHT', paymentMethod: 'BANK_TRANSFER', cashBankAccountId: cashId, description: posted.description,
      } as never,
      ctx.admin.id,
    );
    expect(await capitalised(o.a)).toBeCloseTo(2_000, 2);
    expect(await capitalised(o.b)).toBeCloseTo(1_000, 2);
  }, 300_000);

  it('leaves the books whole', async () => {
    const result = await reconcile(companyId);
    for (const c of result.checks.filter((x) => !x.passed)) console.log(JSON.stringify(c));
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
  }, 300_000);
});
