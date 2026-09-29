import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createStockTransfer, approveStockTransfer, dispatchStockTransfer, receiveStockTransfer } from '@/lib/services/stock-transfer';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { getItemProfitability, getItemProfitabilityChecks } from '@/lib/services/item-profitability';
import { getShipmentProfitability } from '@/lib/services/profitability';

/**
 * Stock on Hand, by item — worked by hand and checked against the service.
 *
 *   Coffee A, one order, two containers:
 *     CONT-A1  20,000 KG at USD 5.00 (MAD 48.00 at 9.6)
 *     CONT-A2  10,000 KG at USD 6.00 (MAD 57.60)
 *     weighted average MAD 51.20 / KG — not (48 + 57.60) / 2 = 52.80
 *   3,000 KG of A1 moved from the first warehouse to the second: company stock unchanged.
 *   Coffee B, 5,000 KG at USD 4.00 (MAD 38.40).
 *   Coffee C, 1,000 KG at USD 5.00, all sold at MAD 40 — sold out, at a loss.
 *
 *   INV 1  A1 2,000 KG @ 60 from the second warehouse = 120,000
 *          B  1,000 KG @ 50                           =  50,000   total 170,000
 *          paid 85,000 cash + 34,000 through the agent = 119,000 (partly paid)
 *   INV 2  A2 4,000 KG @ 55 = 220,000, paid in full by bank
 *   INV 3  C  1,000 KG @ 40 =  40,000, unpaid
 *
 * The invoice-level payments on INV 1 are shared over its lines by value:
 * A1 gets 120/170 of each, B 50/170.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let itemA: string;
let itemB: string;
let itemC: string;
let first: string;
let second: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  itemA = masters.item.id;
  const [b, c] = await Promise.all([
    prisma.coffeeItem.create({ data: { companyId, itemCode: 'ITM-B', itemName: 'Robusta Screen 12', coffeeType: 'ROBUSTA', originCountry: 'Uganda', defaultUnit: 'KG', bagWeightKg: '60' } }),
    prisma.coffeeItem.create({ data: { companyId, itemCode: 'ITM-C', itemName: 'Robusta Screen 15', coffeeType: 'ROBUSTA', originCountry: 'Uganda', defaultUnit: 'KG', bagWeightKg: '60' } }),
  ]);
  itemB = b.id;
  itemC = c.id;
  first = masters.warehouses[0].id;
  second =
    masters.warehouses[1]?.id ?? (await prisma.warehouse.create({ data: { companyId, code: 'WH-RAD', name: 'RADOUAN', location: 'Casablanca' } })).id;
  const agentId = (await prisma.agent.create({ data: { companyId, agentCode: 'AGT-IP', agentName: 'Agent IP', commissionPct: '0' } })).id;

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-06-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0', contractReference: 'ICUL/FID/IP/001',
      lines: [
        { itemId: itemA, quantity: '20000', unit: 'KG', unitPrice: '5.00', bagWeightKg: '60', containerNumber: 'CONT-A1', lotNumber: 'LOT-A1', batchNumber: 'BATCH-A1' },
        { itemId: itemA, quantity: '10000', unit: 'KG', unitPrice: '6.00', bagWeightKg: '60', containerNumber: 'CONT-A2', lotNumber: 'LOT-A2', batchNumber: 'BATCH-A2' },
        { itemId: itemB, quantity: '5000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'CONT-B1', lotNumber: 'LOT-B1', batchNumber: 'BATCH-B1' },
        { itemId: itemC, quantity: '1000', unit: 'KG', unitPrice: '5.00', bagWeightKg: '60', containerNumber: 'CONT-C1', lotNumber: 'LOT-C1', batchNumber: 'BATCH-C1' },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  await receiveEverything({ companyId, purchaseContractId: contract.id, warehouseId: first, userId: ctx.admin.id, receiptDate: utcDate('2026-07-01') });
  const batch = async (n: string) => prisma.batch.findFirstOrThrow({ where: { companyId, batchNumber: n } });
  const [a1, a2, b1, c1] = await Promise.all([batch('BATCH-A1'), batch('BATCH-A2'), batch('BATCH-B1'), batch('BATCH-C1')]);

  const transfer = await createStockTransfer(
    { companyId, transferDate: utcDate('2026-07-05'), fromWarehouseId: first, toWarehouseId: second, lines: [{ batchId: a1.id, quantityKg: '3000' }] } as never,
    ctx.admin.id,
  );
  await approveStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });
  await dispatchStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });
  await receiveStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });

  const invoice = async (date: string, lines: Array<{ batchId: string; warehouseId: string; quantity: string; unitPrice: string }>) => {
    const created = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate(date), customerId: masters.customer.id, currency: 'MAD', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        lines: lines.map((l) => ({ ...l, unit: 'KG' as const })),
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: created.id, companyId, userId: ctx.admin.id });
    return created.id;
  };
  const inv1 = await invoice('2026-07-10', [
    { batchId: a1.id, warehouseId: second, quantity: '2000', unitPrice: '60' },
    { batchId: b1.id, warehouseId: first, quantity: '1000', unitPrice: '50' },
  ]);
  const inv2 = await invoice('2026-08-10', [{ batchId: a2.id, warehouseId: first, quantity: '4000', unitPrice: '55' }]);
  await invoice('2026-08-12', [{ batchId: c1.id, warehouseId: first, quantity: '1000', unitPrice: '40' }]);

  const bank = await getCashAccount(companyId, 'MAD');
  const cash = await prisma.cashBankAccount.findFirst({ where: { companyId, currency: 'MAD', accountType: 'CASH' } });
  const receipt = async (input: Record<string, unknown>) => {
    const created = await createReceipt(
      { companyId, customerId: masters.customer.id, currency: 'MAD', rateToUsd: '9.6', rateLocalPerUsd: '9.6', ...input } as never,
      ctx.admin.id,
    );
    await postReceipt({ id: created.id, companyId, userId: ctx.admin.id });
  };
  await receipt({ receiptDate: utcDate('2026-07-15'), amount: '85000', paymentMethod: 'CASH', cashBankAccountId: (cash ?? bank).id, allocations: [{ salesInvoiceId: inv1, amount: '85000' }] });
  await receipt({ receiptDate: utcDate('2026-07-20'), amount: '34000', paymentMethod: 'AGENT_COLLECTION', agentId, allocations: [{ salesInvoiceId: inv1, amount: '34000' }] });
  await receipt({ receiptDate: utcDate('2026-08-15'), amount: '220000', paymentMethod: 'BANK_TRANSFER', cashBankAccountId: bank.id, allocations: [{ salesInvoiceId: inv2, amount: '220000' }] });
}, 300_000);

const n = (d: { toString(): string } | null | undefined) => Number(d?.toString() ?? NaN);

describe('Stock on Hand by item', () => {
  it('counts what came in, what sold and what is left from the movements, and a transfer adds nothing', async () => {
    const report = await getItemProfitability({ companyId });
    const a = report.items.find((i) => i.itemId === itemA)!;
    expect(n(a.receivedKg)).toBe(30000);
    expect(n(a.soldKg)).toBe(6000);
    expect(n(a.stockSoldKg)).toBe(6000);
    expect(n(a.transferInKg)).toBe(3000);
    expect(n(a.transferOutKg)).toBe(3000);
    // 30,000 received − 6,000 sold = 24,000 — not 27,000 counting the transfer twice.
    expect(n(a.onHandKg)).toBe(24000);
    expect(n(a.availableKg)).toBe(24000);
    const byName = Object.fromEntries(a.warehouses.map((w) => [w.warehouseId, w]));
    expect(n(byName[first].availableKg)).toBe(23000);
    expect(n(byName[second].availableKg)).toBe(1000);
    expect(n(byName[second].transferInKg)).toBe(3000);
    expect(n(byName[second].stockSoldKg)).toBe(2000);
    expect(a.warehouses.reduce((s, w) => s + n(w.availableKg), 0)).toBe(24000);
    expect(a.status).toBe('IN_STOCK');
  }, 120_000);

  it('weights the average cost by KG at each container’s landed cost', async () => {
    const a = (await getItemProfitability({ companyId })).items.find((i) => i.itemId === itemA)!;
    // (20,000 × 48 + 10,000 × 57.60) ÷ 30,000 = 51.20, not the simple 52.80.
    expect(n(a.avgCostPerKg!.local)).toBeCloseTo(51.2, 6);
    expect(n(a.avgCostPerKg!.usd)).toBeCloseTo(5.3333, 3);
    // What is left at its own batch's cost: 18,000 × 48 + 6,000 × 57.60.
    expect(n(a.stockValue.local)).toBeCloseTo(1_209_600, 2);
  }, 120_000);

  it('takes revenue from the item’s own invoice lines, the average from revenue ÷ KG, and COGS from the KG sold', async () => {
    const a = (await getItemProfitability({ companyId })).items.find((i) => i.itemId === itemA)!;
    // 120,000 on INV 1 (not the invoice's 170,000) + 220,000 on INV 2.
    expect(n(a.revenue.local)).toBeCloseTo(340_000, 2);
    expect(n(a.avgSellPerKg!.local)).toBeCloseTo(56.6667, 3);
    // 2,000 × 48 + 4,000 × 57.60, the batches the KG came from.
    expect(n(a.cogs.local)).toBeCloseTo(326_400, 2);
    expect(n(a.cogs.usd)).toBeCloseTo(34_000, 2);
    expect(n(a.grossProfit.local)).toBeCloseTo(13_600, 2);
    expect(n(a.marginPct)).toBeCloseTo(4, 2);
    expect(n(a.profitPerKg!.local)).toBeCloseTo(2.2667, 3);
  }, 120_000);

  it('shares a partly paid invoice’s payments over its lines by value, agent collection counted as collected', async () => {
    const report = await getItemProfitability({ companyId });
    const a = report.items.find((i) => i.itemId === itemA)!;
    const b = report.items.find((i) => i.itemId === itemB)!;
    // INV 1: 85,000 cash and 34,000 agent, A1 takes 120/170 of each.
    expect(n(a.collected.CASH.local)).toBeCloseTo(60_000, 2);
    expect(n(a.collected.AGENT.local)).toBeCloseTo(24_000, 2);
    expect(n(a.collected.BANK.local)).toBeCloseTo(220_000, 2);
    expect(n(a.collectedTotal.local)).toBeCloseTo(304_000, 2);
    expect(n(a.outstanding.local)).toBeCloseTo(36_000, 2);
    expect(n(b.collected.CASH.local)).toBeCloseTo(25_000, 2);
    expect(n(b.collected.AGENT.local)).toBeCloseTo(10_000, 2);
    expect(n(b.outstanding.local)).toBeCloseTo(15_000, 2);
    // Collected + outstanding is exactly what was invoiced, item by item.
    for (const item of report.items) {
      expect(n(item.collectedTotal.local) + n(item.credited.local) + n(item.outstanding.local)).toBeCloseTo(n(item.invoiced.local), 2);
    }
    const line = report.lines.find((l) => l.itemId === itemA && n(l.quantityKg) === 2000)!;
    expect(line.status).toBe('PARTIAL');
    expect(line.shared).toBe(true);
    expect(n(line.invoiceTotal.local)).toBeCloseTo(170_000, 2);
    expect(n(line.invoicePaid.local)).toBeCloseTo(119_000, 2);
    expect(n(line.invoiceOutstanding.local)).toBeCloseTo(51_000, 2);
    expect(n(line.outstanding.local)).toBeCloseTo(36_000, 2);
  }, 120_000);

  it('keeps a sold-out coffee’s history and calls a loss a loss', async () => {
    const c = (await getItemProfitability({ companyId })).items.find((i) => i.itemId === itemC)!;
    expect(c.status).toBe('SOLD_OUT');
    expect(n(c.availableKg)).toBe(0);
    expect(n(c.revenue.local)).toBeCloseTo(40_000, 2);
    expect(n(c.cogs.local)).toBeCloseTo(48_000, 2);
    expect(n(c.grossProfit.local)).toBeCloseTo(-8_000, 2);
    expect(n(c.avgSellPerKg!.local)).toBeCloseTo(40, 4);
    expect(n(c.outstanding.local)).toBeCloseTo(40_000, 2);
  }, 120_000);

  it('breaks the item down by shipment, container and batch, adding back up to the item', async () => {
    const a = (await getItemProfitability({ companyId })).items.find((i) => i.itemId === itemA)!;
    expect(a.shipments).toHaveLength(2);
    const containers = a.shipments.flatMap((s) => s.containers.map((c) => c.containerNumber)).sort();
    expect(containers).toEqual(['CONT-A1', 'CONT-A2']);
    const a1 = a.shipments.flatMap((s) => s.containers).find((c) => c.containerNumber === 'CONT-A1')!;
    expect(n(a1.soldKg)).toBe(2000);
    expect(n(a1.revenue.local)).toBeCloseTo(120_000, 2);
    expect(n(a1.cogs.local)).toBeCloseTo(96_000, 2);
    const batchA1 = a1.batches[0];
    expect(batchA1.batchNumber).toBe('BATCH-A1');
    expect(batchA1.warehouses.map((w) => n(w.availableKg)).sort((x, y) => x - y)).toEqual([1000, 17000]);
    expect(a.shipments.reduce((s, x) => s + n(x.grossProfit.local), 0)).toBeCloseTo(n(a.grossProfit.local), 2);
    // Shipment Profitability says the same, shipment by shipment.
    const shipments = await getShipmentProfitability({ companyId });
    for (const s of a.shipments) {
      const other = shipments.find((x) => x.shipmentId === s.shipmentId)!;
      expect(n(other.salesRevenueLocal)).toBeCloseTo(n(s.revenue.local), 2);
      expect(n(other.allocatedLandedCostLocal)).toBeCloseTo(n(s.cogs.local), 2);
    }
  }, 120_000);

  it('narrows to one warehouse, where the coffee transferred in is that warehouse’s stock', async () => {
    const report = await getItemProfitability({ companyId, warehouseId: second });
    const a = report.items.find((i) => i.itemId === itemA)!;
    expect(n(a.receivedKg)).toBe(0);
    expect(n(a.transferInKg)).toBe(3000);
    expect(n(a.soldKg)).toBe(2000);
    expect(n(a.availableKg)).toBe(1000);
    expect(n(a.avgCostPerKg!.local)).toBeCloseTo(48, 6);
    expect(n(a.revenue.local)).toBeCloseTo(120_000, 2);
    expect(report.items.find((i) => i.itemId === itemB)).toBeUndefined();
  }, 120_000);

  it('a period opens with the stock before it and still adds up', async () => {
    const report = await getItemProfitability({ companyId, from: utcDate('2026-08-01') });
    const a = report.items.find((i) => i.itemId === itemA)!;
    expect(n(a.openingKg)).toBe(28000);
    expect(n(a.receivedKg)).toBe(0);
    expect(n(a.soldKg)).toBe(4000);
    expect(n(a.openingKg) + n(a.receivedKg) + n(a.transferInKg) - n(a.transferOutKg) - n(a.stockSoldKg) + n(a.adjustmentKg)).toBe(n(a.onHandKg));
    expect(n(a.revenue.local)).toBeCloseTo(220_000, 2);
    // The average cost still weighs everything received, not only what arrived in the period.
    expect(n(a.avgCostPerKg!.local)).toBeCloseTo(51.2, 6);
  }, 120_000);

  it('agrees with Current Stock, the invoices, Shipment Profitability and Outstanding Invoices', async () => {
    const checks = await getItemProfitabilityChecks(companyId);
    for (const check of checks) expect(check.ok, `${check.label}: ${check.shown} vs ${check.source}`).toBe(true);
    expect(checks.map((c) => c.key)).toEqual(
      expect.arrayContaining(['stock-equation', 'stock-current', 'stock-warehouses', 'sold-kg', 'revenue', 'cogs-usd', 'cogs-local', 'outstanding']),
    );
  }, 120_000);

  it('never shows one company’s coffee in the other', async () => {
    const dubai = await getItemProfitability({ companyId: ctx.dubai.id });
    expect(dubai.items.find((i) => [itemA, itemB, itemC].includes(i.itemId))).toBeUndefined();
    expect(dubai.lines).toHaveLength(0);
  }, 120_000);
});
