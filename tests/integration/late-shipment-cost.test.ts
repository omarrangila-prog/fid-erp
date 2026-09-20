import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getCompanyProfitSummary } from '@/lib/services/profitability';
import { reconcile } from '@/lib/services/reconciliation';
import { dec, toMoney } from '@/lib/money';

/**
 * A freight or clearing bill almost never arrives before the coffee is sold.
 *
 * When it lands late, the share belonging to coffee already sold has to reach
 * cost of goods sold in the ledger AND in every margin report, and if it is
 * owed to the supplier rather than paid on the spot it has to show up in what
 * that supplier is owed. Both used to be missed, each in a way that flattered
 * the numbers: gross profit stayed too high, and a supplier's balance too low.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let shipmentId: string;

async function failedChecks() {
  const result = await reconcile(companyId);
  return result.checks
    .filter((check) => !check.passed)
    .map((check) => `${check.label}: ${check.left.value} vs ${check.right.value}`);
}


async function control(systemKey: string) {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return toMoney(rows[0]?.bal ?? 0);
}

function capitalisingCategory() {
  return prisma.expenseCategory.findFirstOrThrow({
    where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT', capitaliseByDefault: true },
    orderBy: { code: 'asc' },
  });
}

/** Buy 20,000 KG at USD 4.00, receive it all, sell half. */
beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      freightAmount: '0',
      lines: [{ itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });

  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  shipmentId = batch.shipmentId;

  const receipt = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: contract.id,
      warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-02-01'),
      receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '20000', lotNumber: 'LATE-COST-1' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

  const invoice = await createSalesInvoice(
    {
      companyId,
      invoiceDate: utcDate('2026-02-10'),
      customerId: masters.customer.id,
      currency: 'MAD',
      rateToUsd: '9.85',
      rateLocalPerUsd: '9.85',
      lines: [
        {
          batchId: batch.id,
          warehouseId: masters.warehouses[0].id,
          quantity: '10000',
          unit: 'KG',
          unitPrice: '60',
        },
      ],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
});

describe('a shipment cost capitalised after part of the coffee has sold', () => {
  it('raises cost of goods sold in the reports, not only in the ledger', async () => {
    const before = await getCompanyProfitSummary({ companyId });
    const cash = await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId, currency: 'USD', status: 'ACTIVE' },
    });
    const category = await capitalisingCategory();

    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-02-14'),
        expenseCategoryId: category.id,
        shipmentId,
        cashBankAccountId: cash.id,
        currency: 'USD',
        amount: '1000',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    // Half the coffee sold, so half the USD 1,000 belongs in cost of sales.
    const after = await getCompanyProfitSummary({ companyId });
    expect(after.cogsUsd.minus(before.cogsUsd).toFixed(2)).toBe('500.00');
    expect(after.grossProfitUsd.toFixed(2)).toBe(before.grossProfitUsd.minus(500).toFixed(2));

    // And it is written onto the invoice that sold the coffee, so profit by
    // customer and by item move with it.
    const invoice = await prisma.salesInvoice.findFirstOrThrow({ where: { companyId, status: 'POSTED' } });
    expect(dec(invoice.costOfGoodsUsd).toFixed(2)).toBe('40500.00');

    expect(await failedChecks()).toEqual([]);
  });

  it('shows on the supplier statement when the bill is owed rather than paid', async () => {
    const category = await capitalisingCategory();
    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-02-15'),
        expenseCategoryId: category.id,
        shipmentId,
        vendorId: masters.vendor.id,
        currency: 'USD',
        amount: '1000',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    const { getPayables } = await import('@/lib/services/receivables');
    const payables = await getPayables({ companyId, vendorId: masters.vendor.id, onlyOutstanding: true });
    const billed = payables.find((row) => row.kind === 'EXPENSE');

    expect(billed).toBeDefined();
    expect(billed!.contractNumber).toBe(expense.expenseNumber);
    expect(billed!.outstandingAmountUsd.toFixed(2)).toBe('1000.00');

    expect(await failedChecks()).toEqual([]);
  });

  it('stays off the supplier statement when an agent carries the cost instead', async () => {
    const agent = await prisma.agent.create({
      data: { companyId, agentCode: 'LATE-AG', agentName: 'Late Cost Agent' },
    });
    const category = await capitalisingCategory();

    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-02-16'),
        expenseCategoryId: category.id,
        shipmentId,
        payableToAgentId: agent.id,
        currency: 'USD',
        amount: '1000',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    const { getPayables } = await import('@/lib/services/receivables');
    const payables = await getPayables({ companyId, onlyOutstanding: true });
    expect(payables.filter((row) => row.kind === 'EXPENSE')).toHaveLength(1);

    expect(await failedChecks()).toEqual([]);
  });
});

describe('a shipment cost capitalised while half the containers are still at sea', () => {
  it('values the shelf at what landed, and leaves the rest in transit', async () => {
    // Two lines on one order; only the first has been received.
    const contract = await createPurchaseContract(
      {
        companyId,
        contractDate: utcDate('2026-03-01'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '0',
        lines: [
          { itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'SEA-1', batchNumber: 'SEA-B1' },
          { itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'SEA-2', batchNumber: 'SEA-B2' },
        ],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });

    const landed = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id, batchNumber: 'SEA-B1' } });
    const receipt = await createGoodsReceipt(
      {
        companyId,
        purchaseContractId: contract.id,
        warehouseId: masters.warehouses[0].id,
        receiptDate: utcDate('2026-03-10'),
        receivedById: ctx.admin.id,
        lines: [{ batchId: landed.id, quantityKg: '10000' }],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const inTransitBefore = await control('INVENTORY_IN_TRANSIT');
    const inventoryBefore = await control('INVENTORY');

    const cash = await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'USD', status: 'ACTIVE' } });
    const category = await capitalisingCategory();
    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-03-12'),
        expenseCategoryId: category.id,
        shipmentId: landed.shipmentId,
        cashBankAccountId: cash.id,
        currency: 'USD',
        amount: '2000',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    // Half the kilograms are on the shelf, half on the water: the cost splits
    // the same way, and neither account is asked to carry the other's share.
    expect((await control('INVENTORY')).minus(inventoryBefore).toFixed(2)).toBe('1000.00');
    expect((await control('INVENTORY_IN_TRANSIT')).minus(inTransitBefore).toFixed(2)).toBe('1000.00');

    expect(await failedChecks()).toEqual([]);
  });
});

describe('a late cost when the documents sold less than the batch says', () => {
  /**
   * The live books drifted by USD 41.83 this way: the true-up was sized from
   * the batch's own sold quantity but written onto the sales invoices, so
   * whatever no invoice could absorb was left sitting in cost of sales with
   * nothing behind it — the ledger and the margin reports then disagreed for
   * ever. Whatever the documents cannot carry must stay in inventory.
   */
  it('never moves more into cost of sales than the invoices absorb', async () => {
    const batch = await prisma.batch.findFirstOrThrow({ where: { companyId, status: 'ACTIVE' }, orderBy: { batchNumber: 'asc' } });

    // The batch believes more was sold than any invoice line records — the
    // shape a correction elsewhere can leave behind.
    const documentKg = await prisma.salesInvoiceLine.aggregate({
      where: { batchId: batch.id, salesInvoice: { companyId, status: 'POSTED' } },
      _sum: { quantityKg: true },
    });
    await prisma.batch.update({
      where: { id: batch.id },
      data: { soldQuantityKg: dec(documentKg._sum.quantityKg ?? 0).plus(500) },
    });

    const cogsBefore = await control('COST_OF_GOODS_SOLD');
    const inventoryBefore = await control('INVENTORY');
    const invoicesBefore = await prisma.salesInvoice.aggregate({ where: { companyId, status: 'POSTED' }, _sum: { costOfGoodsUsd: true } });

    const category = await capitalisingCategory();
    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-06-01'),
        expenseCategoryId: category.id,
        shipmentId,
        currency: 'MAD',
        amount: '10000',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        paymentMethod: 'CASH',
        kind: 'SHIPMENT',
        capitaliseToLandedCost: true,
        description: 'Late charge after a correction',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    // What the ledger moved into cost of sales equals what the invoices took.
    const cogsMoved = (await control('COST_OF_GOODS_SOLD')).minus(cogsBefore);
    const invoicesAfter = await prisma.salesInvoice.aggregate({ where: { companyId, status: 'POSTED' }, _sum: { costOfGoodsUsd: true } });
    const documentsTook = dec(invoicesAfter._sum.costOfGoodsUsd ?? 0).minus(dec(invoicesBefore._sum.costOfGoodsUsd ?? 0));
    expect(cogsMoved.toFixed(4)).toBe(toMoney(documentsTook).toFixed(4));

    // The rest of the charge stayed with the coffee, not in thin air.
    const inventoryMoved = (await control('INVENTORY')).minus(inventoryBefore);
    expect(cogsMoved.plus(inventoryMoved).toFixed(2)).toBe('1000.00');

    expect(await failedChecks()).toEqual([]);
  }, 300_000);
});
