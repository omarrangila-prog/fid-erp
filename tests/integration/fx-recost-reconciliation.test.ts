import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { setPurchaseActualFx } from '@/lib/services/purchase-edit';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getItemProfitability } from '@/lib/services/item-profitability';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { dec } from '@/lib/money';

/**
 * The client's own example, end to end (brief of 16 Oct, §31 and §35).
 *
 * USD 100,000 of coffee in two containers, ordered at an estimated 9.90 MAD to
 * the dollar, with MAD 65,000 of customs, transport and warehouse charges.
 * 15,000 of the 25,000 KG sold at MAD 43. The dollars actually cost 10.30.
 *
 * At 9.90 the shipment makes MAD 12,000. At 10.30 the same coffee cost MAD
 * 40,000 more, and the shipment is a MAD 12,000 loss. The supplier is owed
 * the same USD 100,000, the MAD charges are the same MAD 65,000, and the
 * customer's invoice is the same MAD 645,000 — the purchase cost moved, and
 * every figure derived from it follows, reconciling at each step.
 */

let companyId: string;
let contractId: string;
let shipmentId: string;
let itemId: string;
let invoiceId: string;

beforeAll(async () => {
  await resetDatabase();
  const ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  itemId = masters.item.id;
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '9.90', effectiveDate: utcDate('2026-01-01') } });

  // Two containers of 12,500 KG at USD 4.00: USD 100,000.
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-06-01'), vendorId: masters.vendor.id,
      currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.90', freightAmount: '0',
      contractReference: 'ICUL/FID/REC/001',
      lines: [0, 1].map((i) => ({
        itemId, quantity: '12500', unit: 'KG' as const, unitPrice: '4.00', bagWeightKg: '60',
        lotNumber: `REC-L${i}`, batchNumber: `REC-B${i}`, containerNumber: `RECBOX0${i}`,
      })),
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  contractId = contract.id;
  const batches = await prisma.batch.findMany({ where: { purchaseContractId: contractId }, orderBy: { batchNumber: 'asc' } });
  shipmentId = batches[0].shipmentId;

  // The direct charges, in dirhams, on the whole shipment.
  const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', capitaliseByDefault: true } });
  const cash = await getCashAccount(companyId, 'MAD');
  for (const [amount, description] of [['40000', 'Customs'], ['15000', 'Transport'], ['10000', 'Warehouse']] as const) {
    const expense = await createExpense(
      {
        companyId, expenseDate: utcDate('2026-06-20'), expenseCategoryId: category.id, shipmentId,
        currency: 'MAD', amount, rateToUsd: '9.90', rateLocalPerUsd: '9.90', kind: 'SHIPMENT',
        capitaliseToLandedCost: true, allocationMethod: 'PER_CONTAINER',
        paymentMethod: 'BANK_TRANSFER', cashBankAccountId: cash.id, description,
      } as never,
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
  }

  await receiveEverything({
    companyId, purchaseContractId: contractId, warehouseId: masters.warehouses[0].id,
    userId: ctx.admin.id, receiptDate: utcDate('2026-07-01'),
  });

  // 7,500 KG from each container at MAD 43: MAD 645,000.
  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-07-15'), customerId: masters.customer.id,
      currency: 'MAD', rateToUsd: '9.90', rateLocalPerUsd: '9.90',
      lines: batches.map((b) => ({ batchId: b.id, warehouseId: masters.warehouses[0].id, quantity: '7500', unit: 'KG' as const, unitPrice: '43' })),
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
  invoiceId = invoice.id;
}, 300_000);

/** Every §35 figure, read from the services the screens use. */
async function reconciliation() {
  const sheet = await getShipmentCostSheet(companyId, shipmentId, { wholeOrder: true });
  const item = (await getItemProfitability({ companyId })).items.find((i) => i.itemId === itemId)!;
  const pnl = (await getShipmentProfitability({ companyId })).filter((r) => r.contractId === contractId);
  const invoice = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const contract = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contractId } });
  const f = (d: { toString(): string } | null | undefined) => (d === null || d === undefined ? '—' : dec(d.toString()).toFixed(2));
  return {
    'PO USD value': f(contract.totalValueUsd),
    'Purchase FX': f(sheet.rateLocalPerUsd),
    'FX source': sheet.fxSource,
    'MAD purchase cost': f(sheet.goodsLocal),
    'Direct expenses (MAD)': f(sheet.expenseLocal),
    'Landed cost (MAD)': f(sheet.totalShipmentCostLocal),
    'Received KG': f(sheet.receivedKg),
    'Sold KG': f(sheet.soldKg),
    'Remaining KG': f(sheet.remainingKg),
    'Avg cost/KG (shipment)': f(sheet.remainingAvgCostPerKgLocal),
    'Avg cost/KG (Stock on Hand)': f(item.avgCostPerKg?.local),
    'COGS (MAD)': f(sheet.cogsLocal),
    'COGS (profitability)': f(pnl.reduce((t, r) => t.plus(r.allocatedLandedCostLocal), dec(0))),
    'Remaining inventory (shipment)': f(sheet.remainingLandedLocal),
    'Remaining inventory (Stock on Hand)': f(item.stockValue.local),
    'Sales revenue (MAD)': f(sheet.revenueLocal),
    'Invoice total (MAD)': f(invoice.totalAmount),
    'Gross profit / loss (MAD)': f(sheet.grossProfitLocal),
    'Gross margin %': f(sheet.profitPct),
    'Gross margin % (profitability)': f(pnl[0]?.grossMarginPct),
  };
}

describe('the client’s example: 9.90 estimated, 10.30 actual', () => {
  let before: Awaited<ReturnType<typeof reconciliation>>;
  let after: Awaited<ReturnType<typeof reconciliation>>;

  it('reconciles at the estimate, with a profit', async () => {
    before = await reconciliation();
    expect(before['MAD purchase cost']).toBe('990000.00');
    expect(before['Direct expenses (MAD)']).toBe('65000.00');
    expect(before['Landed cost (MAD)']).toBe('1055000.00');
    expect(before['Avg cost/KG (shipment)']).toBe('42.20');
    expect(before['COGS (MAD)']).toBe('633000.00');
    expect(before['Remaining inventory (shipment)']).toBe('422000.00');
    expect(before['Sales revenue (MAD)']).toBe('645000.00');
    expect(before['Gross profit / loss (MAD)']).toBe('12000.00');
  }, 300_000);

  it('moves every figure that depends on the purchase cost when 10.30 is confirmed, and nothing else', async () => {
    const ctx = await getContext();
    await setPurchaseActualFx({ companyId, contractId, userId: ctx.admin.id, actualRateLocalPerUsd: '10.30', note: 'Bank advice' });
    after = await reconciliation();

    // Unchanged: the supplier's dollars, the dirham charges, the customer's invoice.
    expect(after['PO USD value']).toBe('100000.00');
    expect(after['Direct expenses (MAD)']).toBe('65000.00');
    expect(after['Sales revenue (MAD)']).toBe('645000.00');
    expect(after['Invoice total (MAD)']).toBe(before['Invoice total (MAD)']);

    // The purchase cost rises by USD 100,000 × 0.40 = MAD 40,000.
    expect(after['FX source']).toBe('ACTUAL');
    expect(after['MAD purchase cost']).toBe('1030000.00');
    expect(dec(after['MAD purchase cost']).minus(before['MAD purchase cost']).toFixed(2)).toBe('40000.00');
    expect(after['Landed cost (MAD)']).toBe('1095000.00');
    expect(after['Avg cost/KG (shipment)']).toBe('43.80');
    expect(after['COGS (MAD)']).toBe('657000.00');
    expect(after['Remaining inventory (shipment)']).toBe('438000.00');

    // The exchange loss, said in dirhams: USD 100,000 × 0.40, of which the
    // 15,000 KG sold carry 24,000 and the 10,000 KG left carry 16,000. Put
    // back, the profit is the 12,000 the shipment made at the order's rate.
    const sheet = await getShipmentCostSheet(companyId, shipmentId, { wholeOrder: true });
    expect(sheet.orderedRate.toFixed(2)).toBe('9.90');
    expect(sheet.exchangeDifferenceLocal.toFixed(2)).toBe('40000.00');
    expect(sheet.exchangeDifferenceInSalesLocal.toFixed(2)).toBe('24000.00');
    expect(sheet.exchangeDifferenceInStockLocal.toFixed(2)).toBe('16000.00');
    expect(sheet.grossProfitLocal.plus(sheet.exchangeDifferenceInSalesLocal).toFixed(2)).toBe(before['Gross profit / loss (MAD)']);

    // A higher rate is a higher cost: the profit becomes a loss, never a gain.
    expect(after['Gross profit / loss (MAD)']).toBe('-12000.00');
    expect(dec(after['Gross margin %']).isNegative()).toBe(true);
    expect(dec(after['Gross margin % (profitability)']).isNegative()).toBe(true);
  }, 300_000);

  it('reconciles: landed = COGS + remaining, and every screen says the same', async () => {
    for (const r of [before, after]) {
      expect(dec(r['COGS (MAD)']).plus(r['Remaining inventory (shipment)']).toFixed(2)).toBe(r['Landed cost (MAD)']);
      expect(dec(r['Sales revenue (MAD)']).minus(r['COGS (MAD)']).toFixed(2)).toBe(r['Gross profit / loss (MAD)']);
      expect(r['Avg cost/KG (Stock on Hand)']).toBe(r['Avg cost/KG (shipment)']);
      expect(r['Remaining inventory (Stock on Hand)']).toBe(r['Remaining inventory (shipment)']);
      expect(r['COGS (profitability)']).toBe(r['COGS (MAD)']);
    }
    console.table(Object.keys(after).map((k) => ({ figure: k, 'at 9.90': before[k as keyof typeof before], 'at 10.30': after[k as keyof typeof after] })));
  }, 300_000);
});
