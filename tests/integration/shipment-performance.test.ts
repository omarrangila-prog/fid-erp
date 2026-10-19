import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { getItemProfitability } from '@/lib/services/item-profitability';
import { changeShipmentStatus } from '@/lib/services/shipment';
import { shipmentStage, shipmentResult, closureBlockers, getClosedDates } from '@/lib/services/shipment-performance';
import { transaction } from '@/lib/db';
import { dec } from '@/lib/money';

/**
 * Profit on what sold, stock at cost beside it, and a final result only once
 * the shipment is closed (brief of 20 Oct, §44–47).
 *
 * One container: 12,500 KG at USD 4.00, the order at 9.90 MAD to the dollar
 * (MAD 495,000), with MAD 30,000 of customs capitalised — MAD 525,000 landed,
 * MAD 42.00 a KG. 7,500 KG sell at MAD 45; the rest later at MAD 30, below
 * cost; a MAD 5,000 period cost lands on the shipment before it is closed.
 */

let companyId: string;
let contractId: string;
let shipmentId: string;
let userId: string;
let customerId: string;
let warehouseId: string;
let batchId: string;
let itemId: string;
let categoryId: string;
let cashId: string;

const f2 = (d: { toString(): string } | null | undefined) => (d === null || d === undefined ? '—' : dec(d.toString()).toFixed(2));

async function read() {
  const sheet = await getShipmentCostSheet(companyId, shipmentId, { wholeOrder: true });
  const rows = (await getShipmentProfitability({ companyId })).filter((r) => r.contractId === contractId);
  const records = await prisma.shipment.findMany({ where: { purchaseContractId: contractId }, select: { status: true } });
  const stage = shipmentStage({ remainingKg: sheet.remainingKg, soldKg: sheet.soldKg, closed: records.every((r) => r.status === 'CLOSED') });
  const result = shipmentResult({
    stage,
    revenueLocal: sheet.revenueLocal,
    grossProfitLocal: sheet.grossProfitLocal,
    soldKg: sheet.soldKg,
    periodCostsLocal: rows.reduce((t, r) => t.plus(r.otherCostsLocal), dec(0)),
    overheadLocal: rows.reduce((t, r) => t.plus(r.allocatedOverheadLocal), dec(0)),
  });
  const item = (await getItemProfitability({ companyId })).items.find((i) => i.itemId === itemId)!;
  return { sheet, rows, stage, result, item };
}

const blockers = () => transaction((tx) => closureBlockers(tx, companyId, shipmentId));
const setStatus = (toStatus: 'CLOSED' | 'ARRIVED') => changeShipmentStatus({ companyId, shipmentId, userId, toStatus });

async function sell(kg: string, price: string, post = true) {
  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-08-01'), customerId, currency: 'MAD', rateToUsd: '9.90', rateLocalPerUsd: '9.90',
      lines: [{ batchId, warehouseId, quantity: kg, unit: 'KG' as const, unitPrice: price }],
    },
    userId,
  );
  if (post) await postSalesInvoice({ id: invoice.id, companyId, userId });
  return invoice;
}

async function expense(amount: string, capitalise: boolean, post = true) {
  const e = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-06-20'), expenseCategoryId: categoryId, shipmentId,
      currency: 'MAD', amount, rateToUsd: '9.90', rateLocalPerUsd: '9.90', kind: 'SHIPMENT',
      capitaliseToLandedCost: capitalise, allocationMethod: 'PER_CONTAINER',
      paymentMethod: 'BANK_TRANSFER', cashBankAccountId: cashId, description: capitalise ? 'Customs' : 'Bank charges',
    } as never,
    userId,
  );
  if (post) await postExpense({ id: e.id, companyId, userId });
  return e;
}

beforeAll(async () => {
  await resetDatabase();
  const ctx = await getContext();
  companyId = ctx.morocco.id;
  userId = ctx.admin.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  itemId = masters.item.id;
  customerId = masters.customer.id;
  warehouseId = masters.warehouses[0].id;
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '9.90', effectiveDate: utcDate('2026-01-01') } });
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-06-01'), vendorId: masters.vendor.id,
      currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.90', freightAmount: '0', contractReference: 'ICUL/FID/PERF/001',
      lines: [{ itemId, quantity: '12500', unit: 'KG' as const, unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'PERF-L0', batchNumber: 'PERF-B0', containerNumber: 'PERFBOX00' }],
    },
    userId,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId });
  contractId = contract.id;
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contractId } });
  batchId = batch.id;
  shipmentId = batch.shipmentId;
  categoryId = (await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', capitaliseByDefault: true } })).id;
  cashId = (await getCashAccount(companyId, 'MAD')).id;
  await expense('30000', true);
  await receiveEverything({ companyId, purchaseContractId: contractId, warehouseId, userId, receiptDate: utcDate('2026-07-01') });
  // The fixture's logistics: the container has landed.
  await prisma.shipment.update({ where: { id: shipmentId }, data: { status: 'ARRIVED', ataDate: utcDate('2026-06-30') } });
  await sell('7500', '45');
}, 300_000);

describe('a shipment from first sale to final result', () => {
  it('§44 active: profit on the 7,500 KG sold, the 5,000 KG left at cost beside it, nothing final', async () => {
    const { sheet, stage, result, item } = await read();
    expect(stage).toBe('ACTIVE');
    // Sold goods: MAD 337,500 − 7,500 × 42.00 = MAD 22,500, 6.67 %, MAD 3.00 a KG.
    expect(f2(sheet.soldKg)).toBe('7500.00');
    expect(f2(sheet.revenueLocal)).toBe('337500.00');
    expect(f2(sheet.cogsLocal)).toBe('315000.00');
    expect(f2(sheet.grossProfitLocal)).toBe('22500.00');
    expect(f2(sheet.profitPct)).toBe('6.67');
    expect(f2(result.profitPerKgSold)).toBe('3.00');
    // Goods in hand: 5,000 KG, an asset at cost — not in any profit figure.
    expect(f2(sheet.remainingKg)).toBe('5000.00');
    expect(f2(sheet.remainingPurchaseUsd)).toBe('20000.00');
    expect(f2(sheet.remainingPurchaseLocal)).toBe('198000.00');
    expect(f2(sheet.remainingLandedLocal)).toBe('210000.00');
    expect(f2(sheet.remainingAvgCostPerKgLocal)).toBe('42.00');
    // §20: COGS + what is left = the landed cost.
    expect(f2(sheet.cogsLocal.plus(sheet.remainingLandedLocal))).toBe(f2(sheet.totalShipmentCostLocal));
    expect(f2(sheet.totalShipmentCostLocal)).toBe('525000.00');
    // §22: received − sold = remaining.
    expect(f2(sheet.receivedKg.minus(sheet.soldKg))).toBe(f2(sheet.remainingKg));
    // §32: Stock on Hand says the same of the same coffee.
    expect(f2(item.onHandKg)).toBe('5000.00');
    expect(f2(item.stockValue.local)).toBe('210000.00');
    expect(f2(item.purchaseValue.usd)).toBe('20000.00');
    // No period costs or overhead: no net figure at all, and nothing final.
    expect(result.hasDeductions).toBe(false);
    await expect(setStatus('CLOSED')).rejects.toThrow(/5,000(\.000)? KG is still in stock/);
  }, 300_000);

  it('§45 sold out is not final: closing waits for the drafts, then the final result appears', async () => {
    // A draft sale of the rest blocks closing even before it is posted.
    const draft = await sell('5000', '30', false);
    expect((await blockers()).join(' ')).toMatch(/draft sales invoice/);
    await postSalesInvoice({ id: draft.id, companyId, userId });

    let r = await read();
    expect(f2(r.sheet.remainingKg)).toBe('0.00');
    expect(r.stage).toBe('SOLD_OUT_PENDING');
    expect(await getClosedDates(companyId, [shipmentId])).toEqual(new Map());

    // A cost still in draft blocks it too.
    const late = await expense('5000', false, false);
    await expect(setStatus('CLOSED')).rejects.toThrow(/draft expense/);
    await postExpense({ id: late.id, companyId, userId });

    // Profit to date while open: gross less the MAD 5,000 period cost.
    r = await read();
    expect(r.stage).toBe('SOLD_OUT_PENDING');
    expect(r.result.hasDeductions).toBe(true);
    expect(await blockers()).toEqual([]);

    await setStatus('CLOSED');
    r = await read();
    expect(r.stage).toBe('CLOSED');
    expect((await getClosedDates(companyId, [shipmentId])).has(shipmentId)).toBe(true);
    // Final: MAD 487,500 of sales − MAD 525,000 COGS = MAD 37,500 gross loss;
    // less MAD 5,000 = MAD 42,500 final net loss. Nothing left in stock.
    expect(f2(r.sheet.revenueLocal)).toBe('487500.00');
    expect(f2(r.sheet.cogsLocal)).toBe('525000.00');
    expect(f2(r.sheet.remainingLandedLocal)).toBe('0.00');
    expect(f2(r.sheet.cogsLocal)).toBe(f2(r.sheet.totalShipmentCostLocal));
    expect(f2(r.result.periodCostsLocal)).toBe('5000.00');
    expect(f2(r.result.netLocal)).toBe('-42500.00');
  }, 300_000);

  it('§46 loss: a gross loss and a final net loss read as losses', async () => {
    const r = await read();
    expect(r.sheet.grossProfitLocal.isNegative()).toBe(true);
    expect(f2(r.sheet.grossProfitLocal)).toBe('-37500.00');
    expect(r.result.netLocal.isNegative()).toBe(true);
    expect(f2(r.result.netMarginPct)).toBe(f2(dec(-42500).dividedBy(487500).times(100)));
  }, 300_000);

  it('reopening takes the result back to not final', async () => {
    await setStatus('ARRIVED');
    const r = await read();
    expect(r.stage).toBe('SOLD_OUT_PENDING');
    expect(await getClosedDates(companyId, [shipmentId])).toEqual(new Map());
  }, 300_000);
});

describe('shipmentStage', () => {
  it('is final only when closed with nothing left', () => {
    expect(shipmentStage({ remainingKg: '10', soldKg: '5', closed: false })).toBe('ACTIVE');
    expect(shipmentStage({ remainingKg: '0', soldKg: '0', closed: false })).toBe('ACTIVE');
    expect(shipmentStage({ remainingKg: '0', soldKg: '5', closed: false })).toBe('SOLD_OUT_PENDING');
    expect(shipmentStage({ remainingKg: '0', soldKg: '5', closed: true })).toBe('CLOSED');
    // Coffee returned after closing: open again.
    expect(shipmentStage({ remainingKg: '10', soldKg: '5', closed: true })).toBe('ACTIVE');
  });
});
