import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import {
  createStockTransfer,
  approveStockTransfer,
  dispatchStockTransfer,
  receiveStockTransfer,
} from '@/lib/services/stock-transfer';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { getProfitAndLoss } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';
import { dec } from '@/lib/money';

/**
 * Coffee moving from the main warehouse to the agent's, and sold from there.
 *
 * Moving stock between two of the company's own warehouses is not a sale, a
 * purchase, revenue or a cost — nothing has been bought or sold and nobody
 * owes anybody anything. The company still owns all of it, so the total on
 * hand must be identical before and after, and the batch has to stay the same
 * batch or the trail from container to customer is broken.
 *
 * Later the agent sells it, and that sale has to take the coffee out of HIS
 * warehouse and not out of the one it came from.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let batchId: string;
let mainWarehouse: string;
let agentWarehouse: string;

/** What is on hand for this batch, everywhere, added up. */
async function companyTotal() {
  const rows = await prisma.inventoryBalance.findMany({ where: { batchId } });
  return rows.reduce((total, row) => total.plus(dec(row.onHandKg)), dec(0));
}

async function inWarehouse(warehouseId: string) {
  const row = await prisma.inventoryBalance.findUnique({
    where: { batchId_warehouseId: { batchId, warehouseId } },
  });
  return dec(row?.onHandKg ?? 0);
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.85', effectiveDate: utcDate('2026-01-01') },
  });

  mainWarehouse = masters.warehouses[0].id;
  const second = masters.warehouses[1] ?? (await prisma.warehouse.create({
    data: { companyId, code: 'WH-AGENT', name: 'Agent Warehouse', location: 'Casablanca' },
  }));
  agentWarehouse = second.id;

  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-02-02'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      freightAmount: '0',
      lines: [{ itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });

  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  batchId = batch.id;

  const grn = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: contract.id,
      warehouseId: mainWarehouse,
      receiptDate: utcDate('2026-03-01'),
      receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '10000', lotNumber: 'XFER-LOT-1' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });
}, 300_000);

describe('5,000 KG moves to the agent warehouse', () => {
  it('starts with all 10,000 KG in the main warehouse', async () => {
    expect((await inWarehouse(mainWarehouse)).toString()).toBe('10000');
    expect((await companyTotal()).toString()).toBe('10000');
  }, 120_000);

  it('leaves the company total untouched', async () => {
    const before = await companyTotal();

    const transfer = await createStockTransfer(
      {
        companyId,
        transferDate: utcDate('2026-03-15'),
        fromWarehouseId: mainWarehouse,
        toWarehouseId: agentWarehouse,
        notes: 'To Ridwan for local sale',
        lines: [{ batchId, quantityKg: '5000' }],
      },
      ctx.admin.id,
    );
    await approveStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });
    await dispatchStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });
    await receiveStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });

    expect((await inWarehouse(mainWarehouse)).toString()).toBe('5000');
    expect((await inWarehouse(agentWarehouse)).toString()).toBe('5000');
    // Nothing was bought or sold, so the company owns exactly what it did.
    expect((await companyTotal()).toString()).toBe(before.toString());
  }, 300_000);

  it('keeps the same batch on both sides', async () => {
    const rows = await prisma.inventoryBalance.findMany({
      where: { batchId },
      include: { warehouse: true },
    });
    expect(rows).toHaveLength(2);
    // One batch in two places, not two batches.
    expect(new Set(rows.map((r) => r.batchId)).size).toBe(1);
  }, 120_000);

  it('moves out of one warehouse exactly what moved into the other', async () => {
    const moves = await prisma.inventoryTransaction.findMany({
      where: { batchId, referenceType: 'STOCK_TRANSFER' },
    });
    const out = moves
      .filter((m) => m.warehouseId === mainWarehouse)
      .reduce((t, m) => t.plus(dec(m.quantityKg)), dec(0));
    const inTo = moves
      .filter((m) => m.warehouseId === agentWarehouse)
      .reduce((t, m) => t.plus(dec(m.quantityKg)), dec(0));
    expect(out.plus(inTo).toString()).toBe('0');
    expect(inTo.abs().toString()).toBe('5000');
  }, 120_000);

  it('is not a sale, a purchase, revenue or a cost', async () => {
    const pnl = await getProfitAndLoss({
      companyId,
      from: utcDate('2026-03-01'),
      to: utcDate('2026-03-31'),
    });
    expect(Number(pnl.totals.revenueUsd)).toBe(0);
    expect(Number(pnl.totals.costOfSalesUsd)).toBe(0);
    expect(Number(pnl.totals.netProfitUsd)).toBe(0);
  }, 180_000);
});

describe('the agent sells from his own warehouse', () => {
  it('takes the coffee out of his warehouse, not the one it came from', async () => {
    const mainBefore = await inWarehouse(mainWarehouse);
    const agentBefore = await inWarehouse(agentWarehouse);

    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-04-01'),
        dueDate: utcDate('2026-05-01'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        lines: [
          {
            batchId,
            warehouseId: agentWarehouse,
            quantity: '2000',
            unit: 'KG',
            unitPrice: '55.00',
          },
        ],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

    expect((await inWarehouse(agentWarehouse)).toString()).toBe(agentBefore.minus(2000).toString());
    expect((await inWarehouse(mainWarehouse)).toString()).toBe(mainBefore.toString());
    expect((await companyTotal()).toString()).toBe('8000');
  }, 300_000);

  it('refuses to sell more than that warehouse holds', async () => {
    await expect(
      createSalesInvoice(
        {
          companyId,
          invoiceDate: utcDate('2026-04-05'),
          customerId: masters.customer.id,
          currency: 'MAD',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
          lines: [
            {
              batchId,
              warehouseId: agentWarehouse,
              quantity: '9000',
              unit: 'KG',
              unitPrice: '55.00',
            },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/available|stock/i);
  }, 180_000);

  it('leaves the books reconciling', async () => {
    const health = await reconcile(companyId);
    expect(health.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);
});
