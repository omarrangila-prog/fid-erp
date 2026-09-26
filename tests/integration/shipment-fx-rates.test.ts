import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { getOrderCostSheets } from '@/lib/services/order-cost';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { getBatchCostings, getShipmentCostSheet } from '@/lib/services/landed-cost';
import { summariseFx, type FxTransaction } from '@/lib/services/shipment-fx';
import { reconcile } from '@/lib/services/reconciliation';
import { dec } from '@/lib/money';

/**
 * Each transaction at its own rate; one weighted rate only where one figure
 * has to describe several.
 *
 * The costing turned every dollar on an order into dirhams at the purchase
 * contract's rate, so a local bill entered at 9.50 was restated at whatever
 * the coffee had been bought at. The brief's own case:
 *
 *   purchase  USD 10,000 @ 9.20  = MAD  92,000
 *   cost      USD 20,000 @ 9.50  = MAD 190,000
 *   cost      USD  5,000 @ 9.80  = MAD  49,000
 *                                  -----------
 *             USD 35,000          MAD 331,000   weighted 9.4571
 *
 * At the purchase rate alone the costs would have read MAD 230,000 instead
 * of MAD 239,000.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let contractId: string;
let shipmentId: string;
let batchId: string;
const costIds: string[] = [];

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '9.60', effectiveDate: utcDate('2026-01-01') } });

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-03-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.20', freightAmount: '0', contractReference: 'ICUL/FX/1',
      lines: [{ itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '1.00', bagWeightKg: '60', lotNumber: 'LOT-FX-1' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  contractId = contract.id;
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  batchId = batch.id;
  shipmentId = batch.shipmentId;

  const grn = await createGoodsReceipt(
    {
      companyId, purchaseContractId: contract.id, warehouseId: masters.warehouses[0].id, receiptDate: utcDate('2026-04-01'),
      receivedById: ctx.admin.id, lines: [{ batchId, quantityKg: '10000' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', status: 'ACTIVE' } });
  const usdBank =
    (await prisma.cashBankAccount.findFirst({ where: { companyId, currency: 'USD', accountType: 'BANK' } })) ??
    (await getCashAccount(companyId, 'USD'));
  for (const [amount, rate, day] of [['20000', '9.50', '05'], ['5000', '9.80', '06']] as const) {
    const expense = await createExpense(
      {
        companyId, expenseDate: utcDate(`2026-04-${day}`), expenseCategoryId: category.id, shipmentId,
        currency: 'USD', amount, rateToUsd: '1', rateLocalPerUsd: rate, kind: 'SHIPMENT', capitaliseToLandedCost: true,
        paymentMethod: 'BANK_TRANSFER', cashBankAccountId: usdBank.id, description: `Cost at ${rate}`,
      } as never,
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
    costIds.push(expense.id);
  }

  // 4,000 of the 10,000 KG sold, invoiced at 9.60.
  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-05-01'), customerId: masters.customer.id, currency: 'MAD',
      rateToUsd: '9.60', rateLocalPerUsd: '9.60',
      lines: [{ batchId, warehouseId: masters.warehouses[0].id, quantity: '4000', unit: 'KG' as const, unitPrice: '40.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
}, 300_000);

const sheet = async () => (await getOrderCostSheets(companyId)).find((s) => s.contractId === contractId)!;

describe('each transaction keeps its own rate', () => {
  it('stores each cost at the rate it was entered at, never rewritten', async () => {
    const costs = await prisma.expense.findMany({ where: { id: { in: costIds } }, orderBy: { expenseDate: 'asc' } });
    expect(costs.map((c) => Number(c.rateLocalPerUsd))).toEqual([9.5, 9.8]);
    expect(costs.map((c) => Number(c.amountLocal))).toEqual([190_000, 49_000]);
    const contract = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contractId } });
    expect(Number(contract.rateLocalPerUsd)).toBe(9.2);
  }, 300_000);

  it('lists every transaction in the breakdown at its own rate', async () => {
    const s = await sheet();
    expect(s.fxCosts.map((t) => Number(t.rateLocalPerUsd))).toEqual([9.2, 9.5, 9.8]);
    expect(s.fxCosts.map((t) => Number(t.local))).toEqual([92_000, 190_000, 49_000]);
  }, 300_000);
});

describe('the shipment in dirhams is the sum of those', () => {
  it('lands at MAD 331,000 — not USD 35,000 at any one rate', async () => {
    const s = await sheet();
    expect(Number(s.landedUsd)).toBeCloseTo(35_000, 2);
    expect(Number(s.landedLocal)).toBeCloseTo(331_000, 2);
    // At the purchase rate it would have been 322,000; at the latest, 343,000.
    expect(Number(s.landedLocal)).not.toBeCloseTo(35_000 * 9.2, 0);
    expect(Number(s.landedLocal)).not.toBeCloseTo(35_000 * 9.8, 0);
  }, 300_000);

  it('shows the weighted average, from the transactions themselves', async () => {
    const s = await sheet();
    expect(s.costFx).toHaveLength(1);
    const pair = s.costFx[0];
    expect(pair.from).toBe('USD');
    expect(pair.to).toBe('MAD');
    expect(Number(pair.rate)).toBeCloseTo(331_000 / 35_000, 6);
    expect(pair.count).toBe(3);
    expect(Number(pair.lowest)).toBe(9.2);
    expect(Number(pair.highest)).toBe(9.8);
  }, 300_000);

  it('gives the cost per kilo in dirhams from that total', async () => {
    const s = await sheet();
    expect(Number(s.costPerKgLocal)).toBeCloseTo(33.1, 4);
    const [batch] = await getBatchCostings({ companyId, batchIds: [batchId] });
    expect(Number(batch.landedLocal)).toBeCloseTo(331_000, 2);
    expect(Number(batch.landedPerKgLocal)).toBeCloseTo(33.1, 4);
  }, 300_000);

  it('charges what sold at the rates it was bought and costed at, and the rest stays in stock', async () => {
    const s = await sheet();
    expect(Number(s.cogsUsd)).toBeCloseTo(14_000, 2);
    expect(Number(s.cogsLocal)).toBeCloseTo(132_400, 2);
    expect(Number(s.remainingValueLocal)).toBeCloseTo(198_600, 2);
    // Sold plus left is what landed, in dirhams as in dollars.
    expect(Number(s.cogsLocal) + Number(s.remainingValueLocal)).toBeCloseTo(Number(s.landedLocal), 2);
    // Sales are at the invoice's own rate.
    expect(Number(s.revenueLocal)).toBeCloseTo(160_000, 2);
    expect(Number(s.grossProfitLocal)).toBeCloseTo(160_000 - 132_400, 2);
  }, 300_000);

  it('the shipment P&L says the same', async () => {
    const [p] = await getShipmentProfitability({ companyId, shipmentId });
    expect(Number(p.totalLandedCostLocal)).toBeCloseTo(331_000, 2);
    expect(Number(p.capitalisedCostLocal)).toBeCloseTo(239_000, 2);
    expect(Number(p.allocatedLandedCostLocal)).toBeCloseTo(132_400, 2);
    expect(Number(p.closingStockValueLocal)).toBeCloseTo(198_600, 2);
    expect(Number(p.landedCostPerKgLocal)).toBeCloseTo(33.1, 4);
  }, 300_000);

  it('the shipment page says the same', async () => {
    const cost = await getShipmentCostSheet(companyId, shipmentId);
    expect(Number(cost.totalShipmentCostLocal)).toBeCloseTo(331_000, 2);
    expect(Number(cost.costFx[0].rate)).toBeCloseTo(331_000 / 35_000, 6);
  }, 300_000);

  it('leaves the books whole', async () => {
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
  }, 300_000);
});

describe('currency pairs are never averaged together', () => {
  it('keeps AED→MAD apart from USD→MAD', () => {
    const t = (currency: string, amount: number, usd: number, local: number): FxTransaction => ({
      kind: 'COST', id: `${currency}-${amount}`, date: new Date(), label: '', reference: null, currency,
      amount: dec(amount), usd: dec(usd), local: dec(local), rateLocalPerUsd: dec(local).dividedBy(usd),
    });
    const pairs = summariseFx(
      [t('USD', 10_000, 10_000, 92_000), t('MAD', 95_000, 10_000, 95_000), t('AED', 3_670, 1_000, 9_600)],
      'MAD',
    );
    expect(pairs.map((p) => `${p.from}→${p.to}`)).toEqual(['USD→MAD', 'AED→MAD']);
    expect(Number(pairs[0].rate)).toBeCloseTo(187_000 / 20_000, 6);
    expect(Number(pairs[1].rate)).toBeCloseTo(9_600 / 3_670, 6);
  });
});
