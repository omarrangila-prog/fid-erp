import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getShipmentSettlement } from '@/lib/services/shipment';

/**
 * Sales belong to the container whose coffee was sold — SCREEN 18's case.
 *
 * On the live books one invoice sold 19,799.6 KG from one SCREEN 18 container
 * and 1,107.7 KG from the other, and its header named neither; another named
 * the first container and sold from it only a little. Screens that picked
 * invoices by the header showed a sold-out container with almost no sales.
 * Here: two containers of 10,000 KG, one invoice selling from both whose
 * header names only the first, one invoice naming nothing.
 */

let companyId: string;
let a: { shipmentId: string; batchId: string };
let b: { shipmentId: string; batchId: string };

beforeAll(async () => {
  await resetDatabase();
  const ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '10', effectiveDate: utcDate('2026-01-01') } });

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-06-01'), vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10',
      freightAmount: '0', contractReference: 'ICUL/S18/1',
      lines: [
        { itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'S18-A', containerNumber: 'S18CONTA01' },
        { itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'S18-B', containerNumber: 'S18CONTB01' },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const batches = await prisma.batch.findMany({ where: { purchaseContractId: contract.id }, orderBy: { batchNumber: 'asc' } });
  a = { shipmentId: batches[0].shipmentId, batchId: batches[0].id };
  b = { shipmentId: batches[1].shipmentId, batchId: batches[1].id };
  const grn = await createGoodsReceipt(
    {
      companyId, purchaseContractId: contract.id, warehouseId: masters.warehouses[0].id, receiptDate: utcDate('2026-06-10'), receivedById: ctx.admin.id,
      lines: batches.map((x) => ({ batchId: x.id, quantityKg: '10000' })),
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  const sell = async (shipmentId: string | null, lines: Array<[string, string]>) => {
    const invoice = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate('2026-06-20'), customerId: masters.customer.id, currency: 'MAD', rateToUsd: '10', rateLocalPerUsd: '10',
        ...(shipmentId ? { shipmentId } : {}),
        lines: lines.map(([batchId, kg]) => ({ batchId, warehouseId: masters.warehouses[0].id, quantity: kg, unit: 'KG' as const, unitPrice: '60.00' })),
      } as never,
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
  };
  // Header names A; it sells 9,000 KG of A's coffee and 2,000 KG of B's.
  await sell(a.shipmentId, [[a.batchId, '9000'], [b.batchId, '2000']]);
  // Header names nothing; it sells the rest of both.
  await sell(null, [[a.batchId, '1000'], [b.batchId, '8000']]);
}, 300_000);

describe('sales follow the coffee', () => {
  it('each container shows the sales of its own coffee — both sold out, neither at zero', async () => {
    const rows = await getShipmentProfitability({ companyId });
    const ra = rows.find((r) => r.shipmentId === a.shipmentId)!;
    const rb = rows.find((r) => r.shipmentId === b.shipmentId)!;
    // 10,000 KG × MAD 60 = MAD 600,000 = USD 60,000 each.
    expect(Number(ra.salesRevenueUsd)).toBeCloseTo(60_000, 2);
    expect(Number(rb.salesRevenueUsd)).toBeCloseTo(60_000, 2);
    expect(Number(ra.remainingQuantityKg)).toBeCloseTo(0, 3);
    expect(Number(rb.remainingQuantityKg)).toBeCloseTo(0, 3);
  }, 300_000);

  it('the shipment page says the same, not what the invoice header named', async () => {
    const sa = await getShipmentCostSheet(companyId, a.shipmentId);
    const sb = await getShipmentCostSheet(companyId, b.shipmentId);
    expect(Number(sa.revenueUsd)).toBeCloseTo(60_000, 2);
    expect(Number(sb.revenueUsd)).toBeCloseTo(60_000, 2);
    expect(Number(sa.cogsUsd)).toBeCloseTo(40_000, 2);
    expect(Number(sb.cogsUsd)).toBeCloseTo(40_000, 2);
  }, 300_000);

  it('the parent is the sum of its containers, each counted once', async () => {
    const rows = (await getShipmentProfitability({ companyId })).filter((r) => [a.shipmentId, b.shipmentId].includes(r.shipmentId));
    const total = rows.reduce((t, r) => t + Number(r.salesRevenueUsd), 0);
    expect(total).toBeCloseTo(120_000, 2);
    const invoices = await prisma.salesInvoice.aggregate({ where: { companyId, status: 'POSTED' }, _sum: { subtotalUsd: true } });
    expect(total).toBeCloseTo(Number(invoices._sum.subtotalUsd), 2);
  }, 300_000);

  it("either container's shipment page shows the whole shipment: both containers, all its sales", async () => {
    for (const opened of [a.shipmentId, b.shipmentId]) {
      const whole = await getShipmentCostSheet(companyId, opened, { wholeOrder: true });
      expect(Number(whole.revenueUsd)).toBeCloseTo(120_000, 2);
      expect(Number(whole.cogsUsd)).toBeCloseTo(80_000, 2);
      expect(Number(whole.receivedKg)).toBeCloseTo(20_000, 3);
      expect(whole.purchaseLines).toHaveLength(2);
    }
  }, 300_000);

  it('what each container has invoiced is its own share', async () => {
    const sa = await getShipmentSettlement(prisma, companyId, a.shipmentId);
    const sb = await getShipmentSettlement(prisma, companyId, b.shipmentId);
    expect(Number(sa.invoicedUsd)).toBeCloseTo(60_000, 2);
    expect(Number(sb.invoicedUsd)).toBeCloseTo(60_000, 2);
  }, 300_000);
});
