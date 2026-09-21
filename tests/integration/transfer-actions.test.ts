import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, receiveEverything, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import {
  createStockTransfer,
  updateDraftStockTransfer,
  approveStockTransfer,
  receiveStockTransfer,
  reverseReceivedStockTransfer,
  correctReceivedStockTransfer,
  getStockTransferDetail,
} from '@/lib/services/stock-transfer';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { reconcile } from '@/lib/services/reconciliation';
import { dec } from '@/lib/money';

/**
 * Warehouse transfers can be opened, edited, cancelled and corrected — and
 * whatever is done, stock moves as matched out/in pairs: each warehouse is
 * right, the batch is right, and the company total never changes.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let batchId: string;
let ipsen: string;
let ridwan: string;

async function at(warehouseId: string) {
  const row = await prisma.inventoryBalance.findUnique({ where: { batchId_warehouseId: { batchId, warehouseId } } });
  return Number(row?.onHandKg ?? 0);
}
async function total() {
  const rows = await prisma.inventoryBalance.findMany({ where: { batchId } });
  return rows.reduce((s, r) => s.plus(dec(r.onHandKg)), dec(0)).toNumber();
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  ipsen = (await prisma.warehouse.create({ data: { companyId, code: 'WH-IP', name: 'IPSEN Warehouse', location: 'Casablanca' } })).id;
  ridwan = (await prisma.warehouse.create({ data: { companyId, code: 'WH-RD', name: 'Ridwan Warehouse', location: 'Casablanca' } })).id;
  const contract = await createPurchaseContract(
    {
      companyId, vendorId: masters.vendor.id, contractDate: utcDate('2026-08-01'), currency: 'USD', rateToUsd: '1',
      rateLocalPerUsd: '10', freightAmount: '0', contractReference: 'ICUL/FID/001',
      lines: [{ itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  ({ batches: [{ id: batchId }] } = await receiveEverything({ companyId, purchaseContractId: contract.id, warehouseId: ipsen, userId: ctx.admin.id, receiptDate: utcDate('2026-08-10') }));
}, 300_000);

describe('warehouse transfer actions', () => {
  let transferId: string;

  it('opens with the ICUL/FID reference, batch, lot and container on each line', async () => {
    const t = await createStockTransfer(
      { companyId, transferDate: utcDate('2026-09-01'), fromWarehouseId: ipsen, toWarehouseId: ridwan, lines: [{ batchId, quantityKg: '5000' }] },
      ctx.admin.id,
    );
    transferId = t.id;
    const detail = await getStockTransferDetail(companyId, transferId);
    expect(detail.transferNumber).toBe('WTO-001');
    expect(detail.lines[0].batch.purchaseContract?.contractReference).toBe('ICUL/FID/001');
    expect(detail.lines[0].batch.lot?.lotNumber).toBeTruthy();
  }, 300_000);

  it('edits a draft in place, keeping its number, and moves no stock', async () => {
    await updateDraftStockTransfer(
      transferId,
      { companyId, transferDate: utcDate('2026-09-02'), fromWarehouseId: ipsen, toWarehouseId: ridwan, notes: 'Edited', lines: [{ batchId, quantityKg: '3000' }] },
      ctx.admin.id,
    );
    const detail = await getStockTransferDetail(companyId, transferId);
    expect(detail.transferNumber).toBe('WTO-001');
    expect(Number(detail.lines[0].quantityKg)).toBe(3000);
    expect(detail.lines[0].bags).toBe(50);
    expect(await at(ipsen)).toBe(10000);
    expect(await at(ridwan)).toBe(0);
  }, 300_000);

  it('refuses to edit a transfer once it has moved stock', async () => {
    await approveStockTransfer({ id: transferId, companyId, userId: ctx.admin.id });
    await receiveStockTransfer({ id: transferId, companyId, userId: ctx.admin.id });
    expect(await at(ipsen)).toBe(7000);
    expect(await at(ridwan)).toBe(3000);
    await expect(
      updateDraftStockTransfer(
        transferId,
        { companyId, transferDate: utcDate('2026-09-02'), fromWarehouseId: ipsen, toWarehouseId: ridwan, lines: [{ batchId, quantityKg: '1' }] },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/Only a draft/);
  }, 300_000);

  it('corrects a received transfer: stock goes back, the original stays, a new draft opens', async () => {
    const draft = await correctReceivedStockTransfer({ id: transferId, companyId, userId: ctx.admin.id, reason: 'Wrong quantity' });
    expect(await at(ipsen)).toBe(10000);
    expect(await at(ridwan)).toBe(0);
    expect(await total()).toBe(10000);
    const original = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(original.status).toBe('REVERSED');
    expect(original.transferNumber).toBe('WTO-001');
    expect(draft.transferNumber).toBe('WTO-002');
    expect(draft.workflowState).toBe('DRAFT');
    // The movements are all still there: out, in, and the matched move back.
    const moves = await prisma.inventoryTransaction.findMany({ where: { batchId, transactionType: { in: ['TRANSFER_IN', 'TRANSFER_OUT'] } } });
    expect(moves).toHaveLength(4);
    expect(moves.reduce((s, m) => s + Number(m.quantityKg), 0)).toBe(0);
  }, 300_000);

  it('refuses to reverse a transfer whose coffee has since been sold at the destination', async () => {
    const t = await createStockTransfer(
      { companyId, transferDate: utcDate('2026-09-05'), fromWarehouseId: ipsen, toWarehouseId: ridwan, lines: [{ batchId, quantityKg: '1000' }] },
      ctx.admin.id,
    );
    await approveStockTransfer({ id: t.id, companyId, userId: ctx.admin.id });
    await receiveStockTransfer({ id: t.id, companyId, userId: ctx.admin.id });
    const invoice = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate('2026-09-06'), customerId: masters.customer.id, currency: 'MAD', rateToUsd: '10', rateLocalPerUsd: '10',
        lines: [{ batchId, warehouseId: ridwan, quantity: '800', unit: 'KG' as const, unitPrice: '60' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
    await expect(reverseReceivedStockTransfer({ id: t.id, companyId, userId: ctx.admin.id, reason: 'test' })).rejects.toThrow();
    // Nothing moved by the refusal.
    expect(await at(ridwan)).toBe(200);
    expect((await reconcile(companyId)).checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);
});
