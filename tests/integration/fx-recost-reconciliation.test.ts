import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything, editOrderRate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { getReceivables } from '@/lib/services/receivables';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getItemProfitability, getItemProfitabilityChecks } from '@/lib/services/item-profitability';
import { getInvoicePoRates } from '@/lib/services/invoice-po-rate';
import { getSupplierPaymentRate } from '@/lib/services/supplier-payment-rate';
import { createPayment, postPayment } from '@/lib/services/payment';
import { getShipmentProfitability, getCogsReport } from '@/lib/services/profitability';
import { getInventoryValuation, getInventoryValuationSummary } from '@/lib/services/stock';
import { dec } from '@/lib/money';

/**
 * The client's own example, end to end (briefs of 16 and 19 Oct).
 *
 * USD 100,000 of coffee in two containers, ordered at 9.90 MAD to the dollar,
 * with MAD 65,000 of customs, transport and warehouse charges. 15,000 of the
 * 25,000 KG sold at MAD 43. The order has one USD/MAD rate, and the client
 * edits it on the order: 9.90 → 10.30, then back to 9.90.
 *
 * At 9.90 the shipment makes MAD 12,000. At 10.30 the same coffee costs MAD
 * 40,000 more and the shipment is a MAD 12,000 loss; back at 9.90 it is a
 * MAD 12,000 profit again. The supplier is owed the same USD 100,000, the MAD
 * charges are the same MAD 65,000, the customer's invoice and balance are the
 * same, and not a kilo moves — the purchase cost moved, and every figure
 * derived from it follows, reconciling at each step.
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
  const valuation = await getInventoryValuation(companyId);
  const summaryRow = (await getInventoryValuationSummary(companyId)).find((r) => r.itemId === itemId);
  const cogsLines = await getCogsReport({ companyId });
  const receivable = (await getReceivables({ companyId })).find((r) => r.invoiceId === invoiceId);
  const invoiceRate = (await getInvoicePoRates({ companyId, invoiceIds: [invoiceId] })).get(invoiceId);
  const itemChecks = await getItemProfitabilityChecks(companyId);
  const cogsUsdReport = cogsLines.reduce((t, l) => t.plus(l.rateLocalPerUsd ? l.cogsLocal.dividedBy(l.rateLocalPerUsd) : l.cogsUsd), dec(0));
  const batch = item.shipments.find((s) => s.shipmentId === shipmentId)!.containers[0].batches[0];
  const batches = await prisma.batch.findMany({ where: { purchaseContractId: contractId }, select: { orderedQuantityKg: true, receivedQuantityKg: true, soldQuantityKg: true, availableQuantityKg: true } });
  return {
    'PO USD value': f(contract.totalValueUsd),
    'USD/MAD rate': f(sheet.rateLocalPerUsd),
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
    'Remaining inventory (Inventory Valuation)': f(valuation.reduce((t, l) => t.plus(l.valueLocal), dec(0))),
    'Avg cost/KG (Inventory Valuation)': f(summaryRow?.averageCostLocal),
    'COGS (COGS report)': f(cogsLines.reduce((t, l) => t.plus(l.cogsLocal), dec(0))),
    'Sales (COGS report)': f(cogsLines.reduce((t, l) => t.plus(l.revenueLocal), dec(0))),
    'Customer outstanding (MAD)': f(receivable?.outstandingAmount),
    // Management dollars: every one at the order's rate.
    'Invoice USD/MAD rate (from its PO)': f(invoiceRate),
    'Invoice ≈ USD': f(invoiceRate ? dec(invoice.totalAmount).dividedBy(invoiceRate) : null),
    'Stock on Hand sales (MAD)': f(item.revenue.local),
    'Stock on Hand sales ≈ USD': f(item.revenue.usd),
    'Stock on Hand COGS ≈ USD': f(item.cogs.usd),
    'COGS report COGS ≈ USD': f(cogsUsdReport),
    'Stock on Hand stock value ≈ USD': f(item.stockValue.usd),
    // §27/§28: what the coffee still here cost to buy, USD as charged.
    'Remaining purchase value USD (Stock on Hand)': f(item.purchaseValue.usd),
    'Remaining purchase value ≈ MAD (Stock on Hand)': f(item.purchaseValue.local),
    'Avg purchase/KG USD (Stock on Hand)': f(item.avgPurchasePerKg?.usd),
    'Batch USD/MAD rate (item page)': f(batch.rateLocalPerUsd),
    'Batch purchase/KG USD (item page)': f(batch.purchasePerKg.usd),
    'Batch purchase/KG MAD (item page)': f(batch.purchasePerKg.local),
    'Batch allocated expense/KG MAD (item page)': f(batch.expensePerKg.local),
    'Batch landed/KG MAD (item page)': f(batch.landedPerKg.local),
    'Stock on Hand checks failing': itemChecks.filter((c) => !c.ok).map((c) => c.key).join(',') || 'none',
    'Invoice status': invoice.status,
    'Quantities (ordered/received/sold/available KG)': batches
      .map((b) => [b.orderedQuantityKg, b.receivedQuantityKg, b.soldQuantityKg, b.availableQuantityKg].map((q) => dec(q).toFixed(3)).join('/'))
      .join(' · '),
  };
}

describe('the client’s example: the order rate edited 9.90 → 10.30 → 9.90', () => {
  let before: Awaited<ReturnType<typeof reconciliation>>;
  let after: Awaited<ReturnType<typeof reconciliation>>;
  let back: Awaited<ReturnType<typeof reconciliation>>;

  it('reconciles at 9.90, with a profit', async () => {
    before = await reconciliation();
    expect(before['MAD purchase cost']).toBe('990000.00');
    expect(before['Direct expenses (MAD)']).toBe('65000.00');
    expect(before['Landed cost (MAD)']).toBe('1055000.00');
    expect(before['Avg cost/KG (shipment)']).toBe('42.20');
    expect(before['COGS (MAD)']).toBe('633000.00');
    expect(before['Remaining inventory (shipment)']).toBe('422000.00');
    expect(before['Sales revenue (MAD)']).toBe('645000.00');
    expect(before['Gross profit / loss (MAD)']).toBe('12000.00');
    // The dollars at 9.90: MAD 645,000 of sales, 633,000 of cost, 422,000 of stock.
    expect(before['Invoice USD/MAD rate (from its PO)']).toBe('9.90');
    expect(before['Invoice ≈ USD']).toBe(dec(645000).dividedBy('9.90').toFixed(2));
    expect(before['Stock on Hand sales ≈ USD']).toBe(dec(645000).dividedBy('9.90').toFixed(2));
    expect(before['Stock on Hand COGS ≈ USD']).toBe(dec(633000).dividedBy('9.90').toFixed(2));
    expect(before['Stock on Hand stock value ≈ USD']).toBe(dec(422000).dividedBy('9.90').toFixed(2));
    expect(before['Stock on Hand checks failing']).toBe('none');
    // 10,000 KG left of coffee bought at USD 4.00 a KG.
    expect(before['Remaining purchase value USD (Stock on Hand)']).toBe('40000.00');
    expect(before['Remaining purchase value ≈ MAD (Stock on Hand)']).toBe('396000.00');
    expect(before['Avg purchase/KG USD (Stock on Hand)']).toBe('4.00');
    expect(before['Batch USD/MAD rate (item page)']).toBe('9.90');
    expect(before['Batch purchase/KG USD (item page)']).toBe('4.00');
    expect(before['Batch purchase/KG MAD (item page)']).toBe('39.60');
    expect(before['Batch allocated expense/KG MAD (item page)']).toBe('2.60');
    expect(before['Batch landed/KG MAD (item page)']).toBe('42.20');
  }, 300_000);

  it('moves every figure that depends on the purchase cost when the order rate is edited to 10.30, and nothing else', async () => {
    const ctx = await getContext();
    await editOrderRate({ companyId, contractId, userId: ctx.admin.id, rateLocalPerUsd: '10.30' });
    after = await reconciliation();

    // Unchanged: the supplier's dollars, the dirham charges, the customer's
    // invoice, what the customer owes, and every kilo.
    expect(after['PO USD value']).toBe('100000.00');
    expect(after['Direct expenses (MAD)']).toBe('65000.00');
    expect(after['Sales revenue (MAD)']).toBe('645000.00');
    expect(after['Invoice total (MAD)']).toBe(before['Invoice total (MAD)']);
    expect(after['Customer outstanding (MAD)']).toBe(before['Customer outstanding (MAD)']);
    expect(after['Invoice status']).toBe(before['Invoice status']);
    expect(after['Quantities (ordered/received/sold/available KG)']).toBe(before['Quantities (ordered/received/sold/available KG)']);

    // Stock on Hand: the sales in dirhams are the invoice and do not move;
    // every dollar figure is restated at 10.30, and every check still holds.
    expect(after['Stock on Hand sales (MAD)']).toBe(before['Stock on Hand sales (MAD)']);
    expect(after['Invoice USD/MAD rate (from its PO)']).toBe('10.30');
    expect(after['Invoice ≈ USD']).toBe(dec(645000).dividedBy('10.30').toFixed(2));
    expect(after['Stock on Hand sales ≈ USD']).toBe(dec(645000).dividedBy('10.30').toFixed(2));
    expect(after['Stock on Hand COGS ≈ USD']).toBe(dec(657000).dividedBy('10.30').toFixed(2));
    expect(after['Stock on Hand stock value ≈ USD']).toBe(dec(438000).dividedBy('10.30').toFixed(2));
    expect(after['Stock on Hand checks failing']).toBe('none');
    // The supplier's dollars stay; their dirhams follow the rate; the charges stay.
    expect(after['Remaining purchase value USD (Stock on Hand)']).toBe('40000.00');
    expect(after['Remaining purchase value ≈ MAD (Stock on Hand)']).toBe('412000.00');
    expect(after['Batch USD/MAD rate (item page)']).toBe('10.30');
    expect(after['Batch purchase/KG USD (item page)']).toBe('4.00');
    expect(after['Batch purchase/KG MAD (item page)']).toBe('41.20');
    expect(after['Batch allocated expense/KG MAD (item page)']).toBe('2.60');
    expect(after['Batch landed/KG MAD (item page)']).toBe('43.80');

    // The purchase cost rises by USD 100,000 × 0.40 = MAD 40,000.
    expect(after['USD/MAD rate']).toBe('10.30');
    expect(after['MAD purchase cost']).toBe('1030000.00');
    expect(dec(after['MAD purchase cost']).minus(before['MAD purchase cost']).toFixed(2)).toBe('40000.00');
    expect(after['Landed cost (MAD)']).toBe('1095000.00');
    expect(after['Avg cost/KG (shipment)']).toBe('43.80');
    expect(after['COGS (MAD)']).toBe('657000.00');
    expect(after['Remaining inventory (shipment)']).toBe('438000.00');
    expect(after['Remaining inventory (Inventory Valuation)']).toBe('438000.00');
    expect(after['COGS (COGS report)']).toBe('657000.00');

    // A higher rate is a higher cost: the profit becomes a loss, never a gain.
    expect(after['Gross profit / loss (MAD)']).toBe('-12000.00');
    expect(dec(after['Gross margin %']).isNegative()).toBe(true);
    expect(dec(after['Gross margin % (profitability)']).isNegative()).toBe(true);
  }, 300_000);

  it('follows the rate back down when it is edited again, to 9.90', async () => {
    const ctx = await getContext();
    await editOrderRate({ companyId, contractId, userId: ctx.admin.id, rateLocalPerUsd: '9.90' });
    back = await reconciliation();
    // Whatever is saved on the order now is the rate: every figure is what it
    // was at 9.90, with no trace of 10.30 left in the costing.
    for (const key of Object.keys(before) as Array<keyof typeof before>) expect(back[key], key).toBe(before[key]);
  }, 300_000);

  it('reconciles: landed = COGS + remaining, and every screen says the same', async () => {
    for (const r of [before, after, back]) {
      expect(dec(r['COGS (MAD)']).plus(r['Remaining inventory (shipment)']).toFixed(2)).toBe(r['Landed cost (MAD)']);
      expect(dec(r['Sales revenue (MAD)']).minus(r['COGS (MAD)']).toFixed(2)).toBe(r['Gross profit / loss (MAD)']);
      expect(r['Avg cost/KG (Stock on Hand)']).toBe(r['Avg cost/KG (shipment)']);
      expect(r['Remaining inventory (Stock on Hand)']).toBe(r['Remaining inventory (shipment)']);
      expect(r['COGS (profitability)']).toBe(r['COGS (MAD)']);
      // The two reports read the same costing, so they say the same.
      expect(r['Remaining inventory (Inventory Valuation)']).toBe(r['Remaining inventory (shipment)']);
      expect(r['Avg cost/KG (Inventory Valuation)']).toBe(r['Avg cost/KG (shipment)']);
      expect(r['COGS (COGS report)']).toBe(r['COGS (MAD)']);
      expect(r['Sales (COGS report)']).toBe(r['Sales revenue (MAD)']);
      // Stock on Hand and the COGS report state cost of sales in the same dollars.
      expect(r['Stock on Hand COGS ≈ USD']).toBe(r['COGS report COGS ≈ USD']);
    }
    console.table(Object.keys(after).map((k) => ({ figure: k, 'at 9.90': before[k as keyof typeof before], 'at 10.30': after[k as keyof typeof after], 'back at 9.90': back[k as keyof typeof back] })));
  }, 300_000);
});

describe('§35: the rate the supplier was paid at, beside the order rate', () => {
  it('weights each payment by the dollars it paid, and leaves the order rate and its costing alone', async () => {
    const ctx = await getContext();
    const contract = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contractId }, select: { vendorId: true } });
    const madBank = await getCashAccount(companyId, 'MAD');
    const before = await getShipmentCostSheet(companyId, shipmentId, { wholeOrder: true });
    expect(await getSupplierPaymentRate({ companyId, contractId })).toBeNull();
    for (const [date, mad, rate, usd] of [
      ['2026-09-01', '412000', '10.30', '40000'],
      ['2026-09-15', '594000', '9.90', '60000'],
    ] as const) {
      const payment = await createPayment(
        {
          companyId, paymentDate: utcDate(date), vendorId: contract.vendorId, currency: 'MAD', amount: mad,
          rateToUsd: rate, rateLocalPerUsd: rate, paymentMethod: 'BANK_TRANSFER', cashBankAccountId: madBank.id,
          allocations: [{ purchaseContractId: contractId, amount: usd }],
        },
        ctx.admin.id,
      );
      await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });
    }
    const paid = (await getSupplierPaymentRate({ companyId, contractId }))!;
    // (40,000 × 10.30 + 60,000 × 9.90) ÷ 100,000 = 10.06
    expect(paid.paidUsd.toFixed(2)).toBe('100000.00');
    expect(paid.weightedRate.toFixed(2)).toBe('10.06');
    expect(paid.payments).toHaveLength(2);
    // Shown, not applied: the order's own rate still costs the shipment.
    const after = await getShipmentCostSheet(companyId, shipmentId, { wholeOrder: true });
    expect(dec(after.rateLocalPerUsd).toFixed(2)).toBe('9.90');
    expect(dec(after.goodsLocal).toFixed(2)).toBe(dec(before.goodsLocal).toFixed(2));
    // Another company never sees these payments.
    expect(await getSupplierPaymentRate({ companyId: ctx.dubai.id, contractId })).toBeNull();
  }, 300_000);
});
