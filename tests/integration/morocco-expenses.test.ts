import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { getShipmentProfitabilityById } from '@/lib/services/profitability';
import { getJobCostSummary } from '@/lib/services/landed-cost';
import { transaction } from '@/lib/db';
import { getFinancialPosition } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';
import { toMoney } from '@/lib/money';

/**
 * Morocco: shipment costing against company overheads.
 *
 * The client's own scenario, run exactly as written. The question it settles
 * is the one that matters: three of these four costs belong to the coffee and
 * one does not, they all come out of the same cash, and none of them may be
 * counted twice.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let shipmentId: string;
let batchId: string;
let cashId: string;

/** A GL balance in USD, straight from the journal. */
async function control(companyId: string, systemKey: string) {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return toMoney(rows[0]?.bal ?? 0);
}

/** A named expense category for this company. */
async function categoryId(companyId: string, code: string) {
  const found = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, code } });
  return found.id;
}

async function spend(params: {
  code: string;
  amount: string;
  kind: 'SHIPMENT' | 'GENERAL';
  description: string;
  daysAfter: number;
}) {
  const expense = await createExpense(
    {
      companyId: ctx.morocco.id,
      expenseDate: utcDate(`2026-02-${String(10 + params.daysAfter).padStart(2, '0')}`),
      expenseCategoryId: await categoryId(ctx.morocco.id, params.code),
      shipmentId: params.kind === 'SHIPMENT' ? shipmentId : null,
      currency: 'MAD',
      amount: params.amount,
      rateToUsd: '10',
      rateLocalPerUsd: '10',
      cashBankAccountId: cashId,
      kind: params.kind,
      description: params.description,
    },
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
  return expense;
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.morocco.id, { currency: 'MAD' });

  // MAD 10 to the dollar throughout, so every figure below can be checked by
  // hand: USD 100,000 of coffee, USD 5,000 of freight, MAD 35,000 of local
  // costs of which MAD 2,000 is a staff dinner.
  const contract = await createPurchaseContract(
    {
      companyId: ctx.morocco.id,
      contractReference: 'MA-EXP-2026-01',
      contractDate: utcDate('2026-01-10'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '10',
      freightAmount: '5000',
      lines: [
        {
          itemId: masters.item.id,
          lotNumber: 'MA/EXP/LOT',
          batchNumber: 'MA-EXP-B001',
          quantity: '20000',
          unit: 'KG',
          unitPrice: '5.00',
          bagWeightKg: '60',
        },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

  shipmentId = (await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;
  batchId = (await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'MA-EXP-B001' } })).id;

  await receiveEverything({
    companyId: ctx.morocco.id,
    purchaseContractId: contract.id,
    warehouseId: masters.warehouses[0].id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-02-01'),
  });

  const cash = await getCashAccount(ctx.morocco.id, 'MAD');
  cashId = cash.id;
  // A petty cash float to spend from.
  await prisma.cashBankAccount.update({ where: { id: cashId }, data: { openingBalance: '50000' } });
});

describe('the four expenses', () => {
  it('records three shipment costs and one company overhead', async () => {
    await spend({ code: 'CLEARING', amount: '20000', kind: 'SHIPMENT', description: 'Clearing', daysAfter: 1 });
    await spend({ code: 'DOCUMENTATION', amount: '5000', kind: 'SHIPMENT', description: 'Documentation', daysAfter: 2 });
    await spend({ code: 'BROKER', amount: '10000', kind: 'SHIPMENT', description: 'Broker commission', daysAfter: 3 });
    await spend({ code: 'MEALS', amount: '2000', kind: 'GENERAL', description: 'Staff dinner', daysAfter: 4 });

    const all = await prisma.expense.findMany({
      where: { companyId: ctx.morocco.id, status: 'POSTED' },
      orderBy: { expenseNumber: 'asc' },
    });
    // All four are on the register, whatever their kind.
    expect(all).toHaveLength(4);
    expect(all.filter((e) => e.kind === 'SHIPMENT')).toHaveLength(3);
    expect(all.filter((e) => e.kind === 'GENERAL')).toHaveLength(1);
  });

  it('refuses a shipment expense that names no shipment', async () => {
    await expect(
      createExpense(
        {
          companyId: ctx.morocco.id,
          expenseDate: utcDate('2026-02-20'),
          expenseCategoryId: await categoryId(ctx.morocco.id, 'CLEARING'),
          currency: 'MAD',
          amount: '500',
          rateToUsd: '10',
          rateLocalPerUsd: '10',
          cashBankAccountId: cashId,
          kind: 'SHIPMENT',
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/has to name the shipment/i);
  });

  it('refuses a company expense that names one', async () => {
    await expect(
      createExpense(
        {
          companyId: ctx.morocco.id,
          expenseDate: utcDate('2026-02-20'),
          expenseCategoryId: await categoryId(ctx.morocco.id, 'MEALS'),
          shipmentId,
          currency: 'MAD',
          amount: '500',
          rateToUsd: '10',
          rateLocalPerUsd: '10',
          cashBankAccountId: cashId,
          kind: 'GENERAL',
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/does not belong to a shipment/i);
  });

  it('takes all four out of petty cash, and only once each', async () => {
    const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
      SELECT COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS bal
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      WHERE je."companyId" = ${ctx.morocco.id} AND je."status" = 'POSTED'
        AND jl."cashBankAccountId" = ${cashId}`;
    // MAD 20,000 + 5,000 + 10,000 + 2,000 spent.
    expect(Number(rows[0].bal)).toBeCloseTo(-37_000, 2);

    const account = await prisma.cashBankAccount.findUniqueOrThrow({ where: { id: cashId } });
    // 50,000 float less 37,000 spent.
    expect(Number(account.openingBalance) + Number(rows[0].bal)).toBeCloseTo(13_000, 2);
  });
});

describe('what reaches the coffee', () => {
  it('puts the three shipment costs into landed cost and leaves the dinner out', async () => {
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });

    // USD 100,000 goods + 5,000 freight + MAD 35,000 of clearing,
    // documentation and commission at 10 to the dollar = USD 108,500.
    // Over 20,000 KG that is USD 5.425.
    expect(Number(batch.landedUnitCostUsd)).toBeCloseTo(5.425, 4);
    expect(Number(batch.landedUnitCostUsd) * 20_000).toBeCloseTo(108_500, 2);
  });

  it('does not also charge those three to the profit and loss', async () => {
    // The whole point of §8. They are in inventory, not in expenses — they
    // reach the P&L only as cost of goods sold, when the coffee is sold.
    const inventory = await control(ctx.morocco.id, 'INVENTORY');
    expect(Number(inventory)).toBeCloseTo(108_500, 2);

    const cogs = await control(ctx.morocco.id, 'COST_OF_GOODS_SOLD');
    expect(Number(cogs)).toBe(0);
  });

  it('charges the dinner straight to the period', async () => {
    const meals = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, code: 'MEALS' },
      include: { glAccount: true },
    });
    const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
      SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      WHERE je."companyId" = ${ctx.morocco.id} AND je."status" = 'POSTED'
        AND jl."accountId" = ${meals.glAccountId}`;
    // MAD 2,000 at 10 to the dollar.
    expect(Number(rows[0].bal)).toBeCloseTo(200, 2);
  });

  it('shows the three on the shipment cost report and not the dinner', async () => {
    const jobCost = await transaction((tx) => getJobCostSummary(tx, ctx.morocco.id, shipmentId));

    expect(Number(jobCost.goodsUsd)).toBeCloseTo(105_000, 2);
    // MAD 35,000 of clearing, documentation and commission at 10 to the dollar.
    expect(Number(jobCost.capitalisedUsd)).toBeCloseTo(3_500, 2);
    expect(Number(jobCost.totalLandedUsd)).toBeCloseTo(108_500, 2);
    expect(Number(jobCost.landedCostPerKgUsd)).toBeCloseTo(5.425, 4);

    // The dinner is nowhere near this job.
    const jobExpenses = await prisma.expense.findMany({
      where: { companyId: ctx.morocco.id, shipmentId, status: 'POSTED' },
      select: { description: true },
    });
    const descriptions = jobExpenses.map((e) => e.description ?? '');
    expect(descriptions).toEqual(
      expect.arrayContaining(['Clearing', 'Documentation', 'Broker commission']),
    );
    expect(descriptions).not.toContain('Staff dinner');
  });
});

describe('selling half of it', () => {
  it('charges cost of sales at the landed rate, not the purchase rate', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.morocco.id,
        invoiceDate: utcDate('2026-03-01'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        paymentTermDays: 30,
        lines: [
          {
            batchId,
            warehouseId: masters.warehouses[0].id,
            quantity: '10000',
            unit: 'KG',
            unitPrice: '70.00',
          },
        ],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    // 10,000 KG at the landed USD 5.425.
    const cogs = await control(ctx.morocco.id, 'COST_OF_GOODS_SOLD');
    expect(Number(cogs)).toBeCloseTo(54_250, 2);
  });

  it('leaves the unsold half in inventory at its landed cost', async () => {
    const position = await getFinancialPosition({ companyId: ctx.morocco.id });
    expect(Number(position.inventoryValueUsd)).toBeCloseTo(54_250, 2);

    const inventory = await control(ctx.morocco.id, 'INVENTORY');
    expect(Number(inventory)).toBeCloseTo(54_250, 2);
  });

  it('reports realised gross profit on the half that sold', async () => {
    const profit = (await getShipmentProfitabilityById(ctx.morocco.id, shipmentId))!;
    expect(profit).toBeTruthy();

    expect(Number(profit.receivedQuantityKg)).toBeCloseTo(20_000, 3);
    expect(Number(profit.soldQuantityKg)).toBeCloseTo(10_000, 3);
    expect(Number(profit.remainingQuantityKg)).toBeCloseTo(10_000, 3);

    // MAD 700,000 of revenue at 10 to the dollar.
    expect(Number(profit.salesRevenueUsd)).toBeCloseTo(70_000, 2);
    expect(Number(profit.totalLandedCostUsd)).toBeCloseTo(108_500, 2);
    // Only the half that sold is charged against that revenue.
    expect(Number(profit.allocatedLandedCostUsd)).toBeCloseTo(54_250, 2);
    // Unsold coffee is neither revenue nor a loss.
    expect(Number(profit.grossProfitUsd)).toBeCloseTo(15_750, 2);
  });

  it('keeps the dinner out of the shipment’s profit', async () => {
    const profit = (await getShipmentProfitabilityById(ctx.morocco.id, shipmentId))!;
    // 70,000 − 54,250 = 15,750 exactly. A staff dinner inside this would make
    // it 15,550 and quietly make one consignment answer for the office.
    expect(Number(profit.grossProfitUsd)).toBeCloseTo(15_750, 2);
    // Nor does it reach the job as a period cost.
    expect(Number(profit.otherCostsUsd)).toBe(0);
  });
});

describe('the books', () => {
  it('reconciles', async () => {
    const result = await reconcile(ctx.morocco.id);
    expect(result.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  });
});
