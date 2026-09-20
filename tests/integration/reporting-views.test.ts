import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, receiveEverything, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getInventoryValuation, getInventoryValuationSummary, getInventoryValuationDetail } from '@/lib/services/stock';
import { getSalesBy, getCustomerBalances, getVendorBalances, getProfitAndLoss, getBalanceSheet } from '@/lib/services/reports';
import { getReceivables, getPayables } from '@/lib/services/receivables';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { listSavedReports, saveReport, removeSavedReport } from '@/lib/services/saved-reports';
import { dec, sum } from '@/lib/money';

/**
 * The report centre's newer views are the same figures at different depths,
 * so each must add up to the statements it sits beside:
 *
 *   inventory valuation summary = by warehouse = detail closing = balance sheet inventory
 *   sales by customer / item / shipment = profit and loss income
 *   customer and supplier balances = the receivable and payable ledgers
 *   the profitability statement's landed cost = purchase + direct expenses, in both currencies
 *   a saved custom report belongs to one person in one company
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;

const FROM = utcDate('2026-05-01');
const TO = utcDate('2026-05-31');

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  const contract = await createPurchaseContract(
    {
      companyId,
      vendorId: masters.vendor.id,
      contractDate: utcDate('2026-05-02'),
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '10',
      freightAmount: '0',
      contractReference: 'ICUL/FID/VIEWS',
      containers: 2,
      lines: [
        { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'VW-1' },
        { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'VW-2' },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const { batches } = await receiveEverything({
    companyId,
    purchaseContractId: contract.id,
    warehouseId: masters.warehouse.id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-05-10'),
  });

  // Clearing charges, paid in dirhams and capitalised into the landed cost.
  const category = await prisma.expenseCategory.findFirstOrThrow({
    where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT', capitaliseByDefault: true },
  });
  const cash = await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'MAD', accountType: 'CASH' } });
  for (const shipment of await prisma.shipment.findMany({ where: { purchaseContractId: contract.id }, select: { id: true } })) {
    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-05-11'),
        expenseCategoryId: category.id,
        shipmentId: shipment.id,
        currency: 'MAD',
        amount: '10000',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        paymentMethod: 'CASH',
        cashBankAccountId: cash.id,
        kind: 'SHIPMENT',
        capitaliseToLandedCost: true,
        description: 'Port clearing',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
  }

  const invoice = await createSalesInvoice(
    {
      companyId,
      invoiceDate: utcDate('2026-05-15'),
      customerId: masters.customer.id,
      currency: 'MAD',
      rateToUsd: '10',
      rateLocalPerUsd: '10',
      lines: [{ batchId: batches[0].id, warehouseId: masters.warehouse.id, quantity: '5000', unit: 'KG' as const, unitPrice: '60.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
}, 300_000);

describe('inventory valuation at three depths', () => {
  it('summary, by warehouse and detail all close to the same stock and value', async () => {
    const [byWarehouse, summary, detail] = await Promise.all([
      getInventoryValuation(companyId),
      getInventoryValuationSummary(companyId),
      getInventoryValuationDetail({ companyId }),
    ]);
    const kg = (xs: Array<{ onHandKg: unknown }>) => sum(xs.map((x) => dec(x.onHandKg as string)));
    expect(Number(kg(byWarehouse))).toBe(35_000);
    expect(Number(kg(summary))).toBe(35_000);
    expect(Number(sum(detail.map((g) => g.closingKg)))).toBe(35_000);

    const valueByWarehouse = sum(byWarehouse.map((r) => r.valueUsd));
    const valueSummary = sum(summary.map((r) => r.assetValueUsd));
    const valueDetail = sum(detail.map((g) => g.closingValueUsd));
    expect(Number(valueSummary)).toBeCloseTo(Number(valueByWarehouse), 2);
    expect(Number(valueDetail)).toBeCloseTo(Number(valueByWarehouse), 2);

    // And the average cost on the summary is the asset value over the quantity.
    for (const row of summary) {
      expect(Number(row.averageCostUsd)).toBeCloseTo(Number(row.assetValueUsd.dividedBy(row.onHandKg)), 3);
    }

    // The detail runs a quantity and value after every movement.
    const sold = detail.find((g) => g.movements.some((m) => m.quantityKg.isNegative()))!;
    expect(sold).toBeDefined();
    const last = sold.movements.at(-1)!;
    expect(Number(last.onHandAfterKg)).toBe(15_000);
    expect(Number(last.valueAfterUsd)).toBeCloseTo(Number(sold.closingValueUsd), 2);
  }, 300_000);

  it('the valuation is the inventory on the balance sheet', async () => {
    const [summary, sheet] = await Promise.all([getInventoryValuationSummary(companyId), getBalanceSheet({ companyId, asOf: TO })]);
    const inventoryLine = sheet.assets.lines.find((l) => /inventory|stock/i.test(l.name))!;
    expect(inventoryLine).toBeDefined();
    expect(Number(sum(summary.map((r) => r.assetValueUsd)))).toBeCloseTo(Number(inventoryLine.amountUsd), 2);
  }, 300_000);
});

describe('sales and balances agree with the statements', () => {
  it('sales by customer, by item and by shipment each add up to the income on the profit and loss', async () => {
    const pnl = await getProfitAndLoss({ companyId, from: FROM, to: TO });
    for (const by of ['customer', 'item', 'shipment', 'warehouse', 'batch'] as const) {
      const rows = await getSalesBy({ companyId, from: FROM, to: TO, by });
      expect(rows.length).toBeGreaterThan(0);
      expect(Number(sum(rows.map((r) => r.revenueUsd)))).toBeCloseTo(Number(pnl.totals.revenueUsd), 2);
      expect(Number(sum(rows.map((r) => r.costUsd)))).toBeCloseTo(Number(pnl.totals.costOfSalesUsd), 2);
      // Each row's detail adds up to the row.
      for (const row of rows) {
        expect(Number(sum(row.detail.map((d) => d.revenueUsd)))).toBeCloseTo(Number(row.revenueUsd), 2);
      }
    }
    expect(Number(pnl.totals.revenueUsd)).toBeCloseTo(30_000, 2);
  }, 300_000);

  it('customer and supplier balances are the ledgers, one line per party and currency', async () => {
    const [customers, receivables, vendors, payables] = await Promise.all([
      getCustomerBalances(companyId),
      getReceivables({ companyId, onlyOutstanding: true }),
      getVendorBalances(companyId),
      getPayables({ companyId, onlyOutstanding: true }),
    ]);
    expect(Number(sum(customers.map((c) => c.balanceUsd)))).toBeCloseTo(Number(sum(receivables.map((r) => r.outstandingAmountUsd))), 2);
    expect(Number(sum(vendors.map((v) => v.balanceUsd)))).toBeCloseTo(Number(sum(payables.map((p) => p.outstandingAmountUsd))), 2);
    expect(customers.find((c) => c.partyName === masters.customer.customerName)?.currency).toBe('MAD');
    expect(Number(customers.find((c) => c.partyName === masters.customer.customerName)?.balance)).toBeCloseTo(300_000, 2);
    expect(Number(vendors.find((v) => v.partyName === masters.vendor.vendorName)?.balanceUsd)).toBeCloseTo(160_000, 2);
  }, 300_000);
});

describe('the profitability statement', () => {
  it('carries landed cost as purchase plus direct expenses in both currencies', async () => {
    const rows = (await getShipmentProfitability({ companyId })).filter((r) => r.contractReference === 'ICUL/FID/VIEWS');
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(Number(r.totalLandedCostUsd)).toBeCloseTo(Number(r.goodsCostUsd.plus(r.capitalisedCostUsd)), 2);
      expect(Number(r.totalLandedCostLocal)).toBeCloseTo(Number(r.goodsCostLocal.plus(r.capitalisedCostLocal)), 2);
      // Local at the contract rate of 10.
      expect(Number(r.totalLandedCostLocal)).toBeCloseTo(Number(r.totalLandedCostUsd) * 10, 1);
      expect(Number(r.landedCostPerKgLocal)).toBeCloseTo(Number(r.totalLandedCostLocal) / Number(r.purchaseQuantityKg), 3);
    }
    // MAD 10,000 of clearing on each container: USD 1,000 each, MAD 10,000 each.
    expect(Number(sum(rows.map((r) => r.capitalisedCostUsd)))).toBeCloseTo(2000, 2);
    expect(Number(sum(rows.map((r) => r.capitalisedCostLocal)))).toBeCloseTo(20_000, 2);
  }, 300_000);
});

describe('saved custom reports', () => {
  it('belong to one person in one company, and refuse addresses outside the application', async () => {
    const saved = await saveReport({ companyId, userId: ctx.admin.id, name: 'Monthly P&L', href: '/reports/profit-loss?columns=month' });
    expect(saved.id).toBeTruthy();
    expect((await listSavedReports(companyId, ctx.admin.id)).map((r) => r.name)).toEqual(['Monthly P&L']);

    // The same name replaces rather than duplicating.
    await saveReport({ companyId, userId: ctx.admin.id, name: 'monthly p&l', href: '/reports/profit-loss?columns=quarter' });
    const list = await listSavedReports(companyId, ctx.admin.id);
    expect(list).toHaveLength(1);
    expect(list[0].href).toBe('/reports/profit-loss?columns=quarter');

    // Not visible from the other company, nor to another user.
    expect(await listSavedReports(ctx.dubai.id, ctx.admin.id)).toEqual([]);
    const other = await prisma.user.findFirst({ where: { id: { not: ctx.admin.id } }, select: { id: true } });
    if (other) expect(await listSavedReports(companyId, other.id)).toEqual([]);

    await expect(saveReport({ companyId, userId: ctx.admin.id, name: 'Bad', href: 'https://example.com' })).rejects.toThrow(/report address/);
    await expect(saveReport({ companyId, userId: ctx.admin.id, name: 'Bad', href: '//evil' })).rejects.toThrow(/report address/);
    await expect(saveReport({ companyId, userId: ctx.admin.id, name: '   ', href: '/reports' })).rejects.toThrow(/name/);

    await removeSavedReport({ companyId, userId: ctx.admin.id, id: list[0].id });
    expect(await listSavedReports(companyId, ctx.admin.id)).toEqual([]);
    await expect(removeSavedReport({ companyId, userId: ctx.admin.id, id: 'nope' })).rejects.toThrow();
  }, 300_000);
});
