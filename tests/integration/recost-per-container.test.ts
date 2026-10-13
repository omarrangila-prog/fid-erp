import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createExpense, postExpense, updateExpense } from '@/lib/services/expense';
import { reconcile } from '@/lib/services/reconciliation';
import { dec, sum } from '@/lib/money';

/**
 * Moving a posted cost from "equal per coffee" to "equal per container".
 *
 * The client's job: one container of Screen 12 and two of Screen 18. Shared
 * charges were split half to each coffee, so the single box of Screen 12
 * carried twice what each box of Screen 18 did for work done once per box.
 *
 * Re-costing puts each expense back through the same service the Edit screen
 * uses, which unwinds the original postings and reposts them. This is what
 * the repair script does, so it is rehearsed here first: the cost must move
 * between containers without the total changing, cost of sales must be
 * restated for coffee already sold, and the books must still reconcile.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let categoryId: string;
let cashId: string;
let contractId: string;
let shipmentId: string;

const carried = async () => {
  const rows = await prisma.batch.findMany({
    where: { purchaseContractId: contractId },
    select: { batchNumber: true, capitalisedCostUsd: true, item: { select: { itemName: true } } },
    orderBy: { batchNumber: 'asc' },
  });
  return rows.map((r) => ({ batch: r.batchNumber, item: r.item.itemName, usd: dec(r.capitalisedCostUsd) }));
};

const cogs = async () => {
  const rows = await prisma.$queryRaw<Array<{ usd: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId" AND je."status" = 'POSTED'
    JOIN accounts a ON a."id" = jl."accountId" AND a."systemKey" = 'COST_OF_GOODS_SOLD'
    WHERE a."companyId" = ${companyId}`;
  return dec(rows[0]?.usd ?? 0);
};

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

  // Screen 12 in one box, Screen 18 in two — the client's own shape.
  const screen18 = await prisma.coffeeItem.create({
    data: {
      companyId, itemCode: 'RC-S18', itemName: 'Screen 18', coffeeType: 'ROBUSTA',
      originCountry: 'Uganda', defaultUnit: 'KG', bagWeightKg: '60',
    },
  });
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-05-01'), vendorId: masters.vendor.id,
      currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10', freightAmount: '0',
      contractReference: 'ICUL/RECOST/1',
      lines: [
        { itemId: masters.item.id, quantity: '21000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'RC-12', batchNumber: 'RC-B12', containerNumber: 'RCBOX01' },
        { itemId: screen18.id, quantity: '20040', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'RC-18A', batchNumber: 'RC-B18A', containerNumber: 'RCBOX02' },
        { itemId: screen18.id, quantity: '20040', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'RC-18B', batchNumber: 'RC-B18B', containerNumber: 'RCBOX03' },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  contractId = contract.id;
  const batches = await prisma.batch.findMany({ where: { purchaseContractId: contractId }, orderBy: { batchNumber: 'asc' } });
  shipmentId = batches[0].shipmentId!;

  // Land it all, so some can be sold.
  const grn = await createGoodsReceipt(
    {
      companyId, purchaseContractId: contractId, warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-05-20'), receivedById: ctx.admin.id,
      lines: batches.map((b) => ({ batchId: b.id, quantityKg: dec(b.orderedQuantityKg).toString() })),
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  // A shared charge the old way: equal per coffee, then by weight.
  const expense = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-05-25'), expenseCategoryId: categoryId, shipmentId,
      currency: 'MAD', amount: '300000', rateToUsd: '10', rateLocalPerUsd: '10',
      kind: 'SHIPMENT', capitaliseToLandedCost: true, allocationMethod: 'PER_ITEM',
      paymentMethod: 'CASH', cashBankAccountId: cashId, description: 'Clearing, the old way',
    } as never,
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

  // Sell part of the Screen 12 box, so cost of sales is in play.
  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-06-01'), customerId: masters.customer.id,
      currency: 'MAD', rateToUsd: '10', rateLocalPerUsd: '10',
      lines: [{ batchId: batches[0].id, warehouseId: masters.warehouses[0].id, quantity: '10000', unit: 'KG', unitPrice: '60' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
}, 300_000);

describe('re-costing a posted shared charge to per container', () => {
  it('starts with the old split: one box of Screen 12 carrying a full half', async () => {
    const rows = await carried();
    // USD 30,000 shared: 15,000 to Screen 12's one box, 7,500 to each Screen 18 box.
    expect(rows.find((r) => r.batch === 'RC-B12')!.usd.toFixed(2)).toBe('15000.00');
    expect(rows.find((r) => r.batch === 'RC-B18A')!.usd.toFixed(2)).toBe('7500.00');
    expect(rows.find((r) => r.batch === 'RC-B18B')!.usd.toFixed(2)).toBe('7500.00');
  }, 120_000);

  it('moves the cost onto the containers without changing the total, and restates sold cost', async () => {
    const beforeTotal = sum((await carried()).map((r) => r.usd));
    const cogsBefore = await cogs();

    // Exactly what the repair script does: the same values, the new method.
    const expense = await prisma.expense.findFirstOrThrow({ where: { companyId, allocationMethod: 'PER_ITEM' } });
    await updateExpense(
      expense.id,
      {
        companyId, expenseDate: expense.expenseDate, expenseCategoryId: expense.expenseCategoryId,
        shipmentId: expense.shipmentId, purchaseContractId: expense.purchaseContractId,
        containerId: expense.containerId, batchId: expense.batchId, vendorId: expense.vendorId,
        currency: expense.currency, amount: expense.amount.toString(),
        rateToUsd: expense.rateToUsd.toString(), rateLocalPerUsd: expense.rateLocalPerUsd.toString(),
        cashBankAccountId: expense.cashBankAccountId, paymentMethod: expense.paymentMethod,
        capitaliseToLandedCost: true, allocationMethod: 'PER_CONTAINER',
        description: expense.description,
      } as never,
      ctx.admin.id,
    );

    const rows = await carried();
    // USD 10,000 a box, whatever coffee is in it.
    for (const row of rows) expect(row.usd.toFixed(2), row.batch).toBe('10000.00');

    // The cost moved; it was not created or lost.
    expect(sum(rows.map((r) => r.usd)).toFixed(2)).toBe(beforeTotal.toFixed(2));

    // Screen 12 was over-charged and had sold 10,000 of 21,000 KG, so cost of
    // sales comes down with it rather than being left overstated.
    expect((await cogs()).lessThan(cogsBefore)).toBe(true);
  }, 180_000);

  it('leaves the books reconciling', async () => {
    const report = await reconcile(companyId);
    const failed = report.checks.filter((c) => !c.passed);
    expect(failed.map((c) => c.label)).toEqual([]);
  }, 180_000);
});
