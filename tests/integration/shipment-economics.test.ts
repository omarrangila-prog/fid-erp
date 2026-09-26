import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { getOrderCostSheets } from '@/lib/services/order-cost';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { getBatchStock, getItemStock, getShipmentStock } from '@/lib/services/stock';
import { getFinancialPosition } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';
import { dec } from '@/lib/money';

/**
 * The eleven questions the client asks about one shipment, and one answer each.
 *
 *   what the coffee cost · what was spent on it · how much is paid · how much
 *   is still owed · the landed cost · the cost per kilo · what was sold · what
 *   the sold coffee cost · the profit · what is left · what it is worth
 *
 * The shipment below carries all four kinds of cost at once: one paid from the
 * bank and added to the coffee, one still owed to a supplier and added to the
 * coffee, and one the client said not to add to stock. That last one is what
 * these tests are really about. The cost report totalled every cost booked to
 * a shipment into "Total landed cost", so a cost deliberately kept out of
 * stock still raised the cost per kilo — a second landed cost that the stock,
 * the ledger and cost of sales all disagreed with. And the stock screens
 * valued the shelf at the contract price under a label reading "at landed
 * cost", understating the client's inventory by the whole of every shipment's
 * charges.
 *
 * A cost that was not capitalised still has to reduce the profit. Once.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let contractId: string;
let shipmentId: string;
let batchId: string;

const RATE = '10.00';
/** Paid from the bank, into the coffee's cost. */
const CLEARING_MAD = '48000';
/** Owed to the transporter, into the coffee's cost. */
const TRANSPORT_MAD = '12000';
/** The client's own decision: a running cost, not part of the coffee. */
const OFFICE_MAD = '5000';
const SOLD_KG = '4000';

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: RATE, effectiveDate: utcDate('2026-01-01') },
  });

  // 10,000 KG at USD 4.00 = USD 40,000.
  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-04-01'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: RATE,
      freightAmount: '0',
      contractReference: 'ICUL/FID/ECON/1',
      lines: [
        { itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'LOT-ECON', containerNumber: 'ECON0000001' },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  contractId = contract.id;
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contractId } });
  batchId = batch.id;
  shipmentId = batch.shipmentId;

  const grn = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: contractId,
      warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-04-20'),
      receivedById: ctx.admin.id,
      lines: [{ batchId, quantityKg: '10000' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', status: 'ACTIVE' } });
  const cash = await getCashAccount(companyId, 'MAD');

  const raise = async (amount: string, options: { capitalise: boolean; owed: boolean; memo: string }) => {
    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-04-25'),
        expenseCategoryId: category.id,
        shipmentId,
        currency: 'MAD',
        amount,
        rateToUsd: RATE,
        rateLocalPerUsd: RATE,
        kind: 'SHIPMENT',
        capitaliseToLandedCost: options.capitalise,
        description: options.memo,
        paymentMethod: 'BANK_TRANSFER' as const,
        // Owed means no cash account is named: the cost goes to the supplier's
        // balance and waits for a payment.
        ...(options.owed ? { vendorId: masters.vendor.id } : { cashBankAccountId: cash.id }),
      } as never,
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
  };

  await raise(CLEARING_MAD, { capitalise: true, owed: false, memo: 'Clearing and port charges, paid from the bank' });
  await raise(TRANSPORT_MAD, { capitalise: true, owed: true, memo: 'Transport to the warehouse, still to pay' });
  await raise(OFFICE_MAD, { capitalise: false, owed: false, memo: 'Office costs while the container cleared' });

  const invoice = await createSalesInvoice(
    {
      companyId,
      invoiceDate: utcDate('2026-05-02'),
      customerId: masters.customer.id,
      currency: 'MAD',
      rateToUsd: RATE,
      rateLocalPerUsd: RATE,
      lines: [{ batchId, warehouseId: masters.warehouses[0].id, quantity: SOLD_KG, unit: 'KG' as const, unitPrice: '65.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
}, 300_000);

const sheet = async () => {
  const sheets = await getOrderCostSheets(companyId);
  return sheets.find((s) => s.contractId === contractId)!;
};

describe('one shipment, eleven answers', () => {
  it('says what the coffee cost and what was spent on it', async () => {
    const s = await sheet();
    expect(Number(s.goodsUsd)).toBeCloseTo(40_000, 2);
    // 48,000 + 12,000 + 5,000 MAD at 10 to the dollar.
    expect(Number(s.expenseUsd)).toBeCloseTo(6_500, 2);
    expect(Number(s.capitalisedExpenseUsd)).toBeCloseTo(6_000, 2);
    expect(Number(s.periodExpenseUsd)).toBeCloseTo(500, 2);
  }, 300_000);

  it('separates what has been paid from what is still owed', async () => {
    const expenses = await prisma.expense.findMany({
      where: { companyId, shipmentId, status: 'POSTED' },
      select: { amountUsd: true, cashBankAccountId: true, allocations: { select: { amountUsd: true, payment: { select: { status: true } } } } },
    });
    let paid = dec(0);
    let owed = dec(0);
    for (const e of expenses) {
      if (e.cashBankAccountId) { paid = paid.plus(dec(e.amountUsd)); continue; }
      const settled = e.allocations.filter((a) => a.payment.status === 'POSTED').reduce((t, a) => t.plus(dec(a.amountUsd)), dec(0));
      paid = paid.plus(settled);
      owed = owed.plus(dec(e.amountUsd).minus(settled));
    }
    expect(Number(paid)).toBeCloseTo(5_300, 2);
    expect(Number(owed)).toBeCloseTo(1_200, 2);
  }, 300_000);

  it('adds the unpaid cost to the coffee as soon as it is incurred', async () => {
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId }, select: { capitalisedCostUsd: true } });
    // Both capitalised costs, the paid one and the one still owed.
    expect(Number(batch.capitalisedCostUsd)).toBeCloseTo(6_000, 2);
  }, 300_000);

  it('adds each cost to the coffee once, not once per screen', async () => {
    const s = await sheet();
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId }, select: { capitalisedCostUsd: true } });
    expect(Number(batch.capitalisedCostUsd)).toBeCloseTo(Number(s.capitalisedExpenseUsd), 2);
  }, 300_000);

  it('gives the landed cost the coffee is actually valued at, and no other', async () => {
    const s = await sheet();
    const batch = await prisma.batch.findUniqueOrThrow({
      where: { id: batchId },
      select: { purchaseCostUsd: true, capitalisedCostUsd: true, landedUnitCostUsd: true },
    });
    expect(Number(s.landedUsd)).toBeCloseTo(46_000, 2);
    expect(Number(s.landedUsd)).toBeCloseTo(Number(batch.purchaseCostUsd) + Number(batch.capitalisedCostUsd), 2);
    // And the cost per kilo is that figure, not one inflated by a cost the
    // client said to keep out of stock.
    expect(Number(s.costPerKgUsd)).toBeCloseTo(4.6, 4);
    expect(Number(batch.landedUnitCostUsd)).toBeCloseTo(4.6, 4);
  }, 300_000);

  it('charges the sold coffee at that same cost per kilo', async () => {
    const s = await sheet();
    expect(Number(s.soldKg)).toBeCloseTo(4_000, 3);
    expect(Number(s.revenueUsd)).toBeCloseTo(26_000, 2);
    expect(Number(s.cogsUsd)).toBeCloseTo(18_400, 2);
    expect(Number(s.grossProfitUsd)).toBeCloseTo(7_600, 2);
  }, 300_000);

  it('takes the cost that was not added to stock off the profit once', async () => {
    const s = await sheet();
    expect(Number(s.netProfitUsd)).toBeCloseTo(7_100, 2);
    // Which is the profit less that cost, and not less it twice.
    expect(Number(s.netProfitUsd)).toBeCloseTo(Number(s.grossProfitUsd) - Number(s.periodExpenseUsd), 2);
    expect(Number(s.netProfitUsd)).not.toBeCloseTo(Number(s.grossProfitUsd) - 2 * Number(s.periodExpenseUsd), 2);
  }, 300_000);

  it('says what is left and what it is worth, agreeing with the stock records', async () => {
    const s = await sheet();
    const batch = await prisma.batch.findUniqueOrThrow({
      where: { id: batchId },
      select: { availableQuantityKg: true, allocatedQuantityKg: true },
    });
    expect(Number(s.remainingKg)).toBeCloseTo(6_000, 3);
    expect(Number(s.remainingKg)).toBeCloseTo(Number(batch.availableQuantityKg) + Number(batch.allocatedQuantityKg), 3);
    expect(Number(s.remainingValueUsd)).toBeCloseTo(27_600, 2);
  }, 300_000);
});

describe('what the coffee on the shelf is worth', () => {
  it('values it at what it cost to land, on every stock screen', async () => {
    const [batches, items, shipments] = await Promise.all([
      getBatchStock({ companyId }),
      getItemStock(companyId),
      getShipmentStock(companyId),
    ]);
    const mine = batches.find((b) => b.batchId === batchId)!;
    // 6,000 KG at 4.60, not at the 4.00 the supplier was paid.
    expect(Number(mine.unitCostUsd)).toBeCloseTo(4.6, 4);
    expect(Number(mine.stockValueUsd)).toBeCloseTo(27_600, 2);

    const item = items.find((i) => Number(i.availableKg) > 0)!;
    expect(Number(item.stockValueUsd)).toBeCloseTo(27_600, 2);
    const shipment = shipments.find((x) => x.shipmentId === shipmentId)!;
    expect(Number(shipment.stockValueUsd)).toBeCloseTo(27_600, 2);
  }, 300_000);

  it('is the same figure the books and the valuation carry', async () => {
    const [position, batches] = await Promise.all([getFinancialPosition({ companyId }), getBatchStock({ companyId })]);
    const onScreen = batches.reduce((total, b) => total.plus(dec(b.stockValueUsd)), dec(0));
    expect(Number(onScreen)).toBeCloseTo(Number(position.inventoryValueUsd), 2);

    // And the check the client runs says so too.
    const result = await reconcile(companyId);
    const inventory = result.checks.find((c) => c.id === 'inventory-value')!;
    expect(inventory.passed).toBe(true);
  }, 300_000);
});

describe('the costing and the shipment profit tell one story', () => {
  it('reports the same sales, cost of sales and landed cost as the P&L', async () => {
    const s = await sheet();
    const profits = await getShipmentProfitability({ companyId });
    const mine = profits.filter((p) => s.shipmentIds.includes(p.shipmentId));
    const total = (pick: (p: (typeof mine)[number]) => unknown) =>
      Number(mine.reduce((t, p) => t.plus(dec(pick(p) as never)), dec(0)));

    expect(total((p) => p.salesRevenueUsd)).toBeCloseTo(Number(s.revenueUsd), 2);
    expect(total((p) => p.allocatedLandedCostUsd)).toBeCloseTo(Number(s.cogsUsd), 2);
    expect(total((p) => p.totalLandedCostUsd)).toBeCloseTo(Number(s.landedUsd), 2);
    // The P&L subtracts the uncapitalised cost once, exactly as the costing does.
    expect(total((p) => p.otherCostsUsd)).toBeCloseTo(Number(s.periodExpenseUsd), 2);
    expect(total((p) => p.netProfitUsd)).toBeCloseTo(Number(s.netProfitUsd), 2);
  }, 300_000);

  it('leaves the books whole', async () => {
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
  }, 300_000);
});
