import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { setPurchaseActualFx } from '@/lib/services/purchase-edit';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getItemProfitability } from '@/lib/services/item-profitability';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { getInventoryValuation } from '@/lib/services/stock';
import { dec } from '@/lib/money';

/**
 * FID acceptance: the purchase order's confirmed actual rate is the one rate
 * that moves cost, for both FID companies, each in its own local money.
 *
 * USD 100,000 of coffee, 25,000 KG; local charges 65,000; one genuine USD
 * charge of USD 1,000 booked at its OWN rate; 15,000 KG sold in local money.
 * Then the actual rate replaces the estimate. The supplier's dollars, the
 * local charges, the USD charge's own rate and the customer's invoice must not
 * move; the purchase cost, landed cost, cost per kilo, cost of sales, stock
 * value and profit must — and agree on every page.
 */
const CASES = [
  { name: 'FID Morocco (MAD)', company: 'morocco' as const, currency: 'MAD', estimate: '9.60', actual: '10.30', usdChargeRate: '9.75', price: '43' },
  { name: 'FID Dubai (AED)', company: 'dubai' as const, currency: 'AED', estimate: '3.6725', actual: '3.7100', usdChargeRate: '3.6725', price: '15' },
];

describe.each(CASES)('$name: actual FX drives cost, never sales', (c) => {
  let companyId: string;
  let contractId: string;
  let shipmentId: string;
  let itemId: string;
  let invoiceId: string;

  beforeAll(async () => {
    await resetDatabase();
    const ctx = await getContext();
    companyId = ctx[c.company].id;
    const masters = await createMasters(companyId, { currency: c.currency });
    itemId = masters.item.id;
    await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: c.currency, rate: c.estimate, effectiveDate: utcDate('2026-01-01') } });

    const contract = await createPurchaseContract(
      {
        companyId, contractDate: utcDate('2026-06-01'), vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1',
        rateLocalPerUsd: c.estimate, freightAmount: '0', contractReference: `ICUL/FID/ACC/${c.currency}`,
        lines: [0, 1].map((i) => ({
          itemId, quantity: '12500', unit: 'KG' as const, unitPrice: '4.00', bagWeightKg: '60',
          lotNumber: `ACC-L${i}`, batchNumber: `ACC-B${i}`, containerNumber: `ACCBOX0${i}`,
        })),
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
    contractId = contract.id;
    const batches = await prisma.batch.findMany({ where: { purchaseContractId: contractId }, orderBy: { batchNumber: 'asc' } });
    shipmentId = batches[0].shipmentId;

    const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', capitaliseByDefault: true } });
    const cash = await getCashAccount(companyId, c.currency);
    for (const [amount, description] of [['40000', 'Customs'], ['15000', 'Transport'], ['10000', 'Warehouse']] as const) {
      const e = await createExpense(
        {
          companyId, expenseDate: utcDate('2026-06-20'), expenseCategoryId: category.id, shipmentId, currency: c.currency,
          amount, rateToUsd: c.estimate, rateLocalPerUsd: c.estimate, kind: 'SHIPMENT', capitaliseToLandedCost: true,
          allocationMethod: 'PER_CONTAINER', paymentMethod: 'BANK_TRANSFER', cashBankAccountId: cash.id, description,
        } as never,
        ctx.admin.id,
      );
      await postExpense({ id: e.id, companyId, userId: ctx.admin.id });
    }
    // A genuine dollar charge, at the rate of ITS OWN transaction — not the order's.
    const usdCash = await getCashAccount(companyId, 'USD');
    const usdExpense = await createExpense(
      {
        companyId, expenseDate: utcDate('2026-06-22'), expenseCategoryId: category.id, shipmentId, currency: 'USD',
        amount: '1000', rateToUsd: '1', rateLocalPerUsd: c.usdChargeRate, kind: 'SHIPMENT', capitaliseToLandedCost: true,
        allocationMethod: 'PER_CONTAINER', paymentMethod: 'BANK_TRANSFER', cashBankAccountId: usdCash.id, description: 'Freight',
      } as never,
      ctx.admin.id,
    );
    await postExpense({ id: usdExpense.id, companyId, userId: ctx.admin.id });

    await receiveEverything({ companyId, purchaseContractId: contractId, warehouseId: masters.warehouses[0].id, userId: ctx.admin.id, receiptDate: utcDate('2026-07-01') });

    const invoice = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate('2026-07-15'), customerId: masters.customer.id, currency: c.currency,
        rateToUsd: c.estimate, rateLocalPerUsd: c.estimate,
        lines: batches.map((b) => ({ batchId: b.id, warehouseId: masters.warehouses[0].id, quantity: '7500', unit: 'KG' as const, unitPrice: c.price })),
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
    invoiceId = invoice.id;
  }, 300_000);

  async function snapshot() {
    const sheet = await getShipmentCostSheet(companyId, shipmentId, { wholeOrder: true });
    const item = (await getItemProfitability({ companyId })).items.find((i) => i.itemId === itemId)!;
    const pnl = (await getShipmentProfitability({ companyId })).filter((r) => r.contractId === contractId);
    const invoice = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const contract = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contractId } });
    const valuation = await getInventoryValuation(companyId);
    return { sheet, item, pnl, invoice, contract, valuation };
  }

  it('moves the cost side only, reconciles, and every page agrees', async () => {
    const ctx = await getContext();
    const before = await snapshot();
    const usdCharge = dec(1000).times(c.usdChargeRate);
    const est = dec(c.estimate);
    const act = dec(c.actual);

    expect(before.sheet.fxSource).toBe('ESTIMATED');
    expect(before.sheet.goodsLocal.toFixed(2)).toBe(dec(100000).times(est).toFixed(2));

    await setPurchaseActualFx({ companyId, contractId, userId: ctx.admin.id, actualRateLocalPerUsd: c.actual, note: 'Bank advice' });
    const after = await snapshot();

    // The supplier's dollars, the customer's invoice and every local charge do not move.
    expect(dec(after.contract.totalValueUsd).toFixed(2)).toBe('100000.00');
    expect(dec(after.invoice.totalAmount).toFixed(2)).toBe(dec(before.invoice.totalAmount).toFixed(2));
    expect(dec(after.invoice.totalAmountUsd).toFixed(2)).toBe(dec(before.invoice.totalAmountUsd).toFixed(2));
    expect(dec(after.invoice.rateLocalPerUsd).toFixed(8)).toBe(dec(before.invoice.rateLocalPerUsd).toFixed(8));
    expect(after.sheet.revenueLocal.toFixed(2)).toBe(before.sheet.revenueLocal.toFixed(2));
    expect(after.sheet.expenseLocal.toFixed(2)).toBe(before.sheet.expenseLocal.toFixed(2));
    expect(after.sheet.expenseLocal.toFixed(2)).toBe(dec(65000).plus(usdCharge).toFixed(2));

    // The purchase cost is the dollars at the confirmed rate; landed = that + charges.
    expect(after.sheet.fxSource).toBe('ACTUAL');
    expect(after.sheet.goodsLocal.toFixed(2)).toBe(dec(100000).times(act).toFixed(2));
    const landed = dec(100000).times(act).plus(65000).plus(usdCharge);
    expect(after.sheet.totalShipmentCostLocal.toFixed(2)).toBe(landed.toFixed(2));

    // Cost per kilo, cost of sales and stock follow; sold + remaining = landed.
    const perKg = landed.dividedBy(25000);
    expect(after.sheet.soldKg.toFixed(0)).toBe('15000');
    expect(after.sheet.remainingKg.toFixed(0)).toBe('10000');
    expect(after.sheet.cogsLocal.toFixed(2)).toBe(perKg.times(15000).toFixed(2));
    expect(after.sheet.remainingLandedLocal.toFixed(2)).toBe(perKg.times(10000).toFixed(2));
    expect(after.sheet.cogsLocal.plus(after.sheet.remainingLandedLocal).toFixed(2)).toBe(landed.toFixed(2));
    expect(after.sheet.revenueLocal.minus(after.sheet.cogsLocal).toFixed(2)).toBe(after.sheet.grossProfitLocal.toFixed(2));
    // A dearer purchase can only lower profit.
    expect(after.sheet.grossProfitLocal.lessThan(before.sheet.grossProfitLocal)).toBe(true);

    // One source of truth: Stock on Hand, Profitability and Inventory Valuation say the same.
    expect(dec(after.item.stockValue.local).toFixed(2)).toBe(after.sheet.remainingLandedLocal.toFixed(2));
    expect(dec(after.item.avgCostPerKg!.local).toFixed(2)).toBe(after.sheet.remainingAvgCostPerKgLocal!.toFixed(2));
    expect(after.pnl.reduce((t, r) => t.plus(r.allocatedLandedCostLocal), dec(0)).toFixed(2)).toBe(after.sheet.cogsLocal.toFixed(2));
    expect(after.valuation.reduce((t, l) => t.plus(l.valueLocal), dec(0)).toFixed(2)).toBe(after.sheet.remainingLandedLocal.toFixed(2));

    // The estimate is not lost: the audit trail keeps old and new rate, who and why.
    const audit = await prisma.auditLog.findFirst({ where: { companyId, action: 'PURCHASE_ACTUAL_FX_SET', entityId: contractId }, orderBy: { createdAt: 'desc' } });
    expect(audit).not.toBeNull();
    const recorded = audit!.after as { estimatedRate: string; actualRate: string; difference: string };
    expect(dec(recorded.estimatedRate).toFixed(4)).toBe(est.toFixed(4));
    expect(dec(recorded.actualRate).toFixed(4)).toBe(act.toFixed(4));
    expect(dec(recorded.difference).toFixed(2)).toBe(dec(100000).times(act.minus(est)).toFixed(2));
    expect(audit!.userId).toBe(ctx.admin.id);

    console.table({
      'PO USD amount': '100000.00',
      'Estimated FX': c.estimate,
      'Actual FX': c.actual,
      [`Purchase cost (${c.currency})`]: after.sheet.goodsLocal.toFixed(2),
      'Direct expenses': after.sheet.expenseLocal.toFixed(2),
      'Landed cost': after.sheet.totalShipmentCostLocal.toFixed(2),
      'Received / Sold / Remaining KG': `${after.sheet.receivedKg.toFixed(0)} / ${after.sheet.soldKg.toFixed(0)} / ${after.sheet.remainingKg.toFixed(0)}`,
      'Sales revenue': after.sheet.revenueLocal.toFixed(2),
      COGS: after.sheet.cogsLocal.toFixed(2),
      'Gross profit': `${after.sheet.grossProfitLocal.toFixed(2)} (was ${before.sheet.grossProfitLocal.toFixed(2)})`,
      'Gross margin %': after.sheet.profitPct.toFixed(2),
      'Remaining purchase value USD': after.sheet.remainingPurchaseUsd.toFixed(2),
      'Remaining inventory value': after.sheet.remainingLandedLocal.toFixed(2),
    });
  }, 300_000);
});
