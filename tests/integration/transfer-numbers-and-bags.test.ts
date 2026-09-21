import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import {
  createStockTransfer,
  approveStockTransfer,
  receiveStockTransfer,
  cancelStockTransfer,
  deleteDraftStockTransfer,
} from '@/lib/services/stock-transfer';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { getItemWarehouseStock, getBatchLocations, getBatchStock } from '@/lib/services/stock';
import { getWarehouseStock } from '@/lib/services/dashboard';
import { suggestStockTransferNumber } from '@/lib/services/numbering';
import { transferNumberLabel, parseTransferSequence } from '@/lib/transfer-number';
import { bagsForKg } from '@/lib/bags';
import { transaction } from '@/lib/db';

/**
 * Two reported faults, reproduced from the client's own books.
 *
 * 1. Screen 12 in the Ridwan warehouse showed −6 bags with coffee on the
 *    shelf. The live trail was: 360 KG transferred in (recorded with 0 bags),
 *    359.2 KG sold out (recorded with 6 bags), then 56.58 KG and 595.4 KG
 *    transferred in (0 bags each). Bags were summed on their own, so the
 *    warehouse read −6 bags beside 652.78 KG. The same sequence is played
 *    here and every stock screen must now read 652.78 ÷ 60 = 10.88 bags.
 *
 * 2. Warehouse transfers must be numbered WTO-001, WTO-002 … on the server,
 *    in order, never twice, even when two people save at once.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let batchId: string;
let itemId: string;
let ipsen: string;
let ridwan: string;

async function moveTo(to: string, kg: string, date: string) {
  const transfer = await createStockTransfer(
    { companyId, transferDate: utcDate(date), fromWarehouseId: ipsen, toWarehouseId: to, lines: [{ batchId, quantityKg: kg }] },
    ctx.admin.id,
  );
  await approveStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });
  await receiveStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });
  return transfer;
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  itemId = masters.item.id;

  ipsen = (await prisma.warehouse.create({ data: { companyId, code: 'WH-IPSEN', name: 'IPSEN Warehouse', location: 'Casablanca' } })).id;
  ridwan = (await prisma.warehouse.create({ data: { companyId, code: 'WH-RIDWAN', name: 'Ridwan Warehouse', location: 'Casablanca' } })).id;

  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-08-01'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '10',
      freightAmount: '0',
      contractReference: 'ICUL/FID/SCR12',
      lines: [{ itemId, quantity: '12960', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;

  // 216 bags of 60 KG received into IPSEN, counted at the gate.
  const grn = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: contract.id,
      warehouseId: ipsen,
      receiptDate: utcDate('2026-08-10'),
      receivedById: ctx.admin.id,
      lines: [{ batchId, quantityKg: '12960', bags: 216, lotNumber: '120216' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });
}, 300_000);

describe('Screen 12 in the Ridwan warehouse', () => {
  it('replays the live trail and reads 10.88 bags beside 652.78 KG, on every stock screen', async () => {
    await moveTo(ridwan, '360', '2026-08-12');

    // The sale the live books recorded: 359.2 KG, which the invoice counts as 6 bags.
    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-08-12'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        lines: [{ batchId, warehouseId: ridwan, quantity: '359.2', unit: 'KG' as const, unitPrice: '60.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
    expect((await prisma.salesInvoiceLine.findFirstOrThrow({ where: { salesInvoiceId: invoice.id } })).bags).toBe(6);

    await moveTo(ridwan, '56.58', '2026-08-25');
    await moveTo(ridwan, '595.4', '2026-09-04');

    // Opening 0 + received 0 + transfers in 1,011.98 − sold 359.2 = 652.78 KG.
    const expectedKg = 360 + 56.58 + 595.4 - 359.2;
    expect(expectedKg).toBeCloseTo(652.78, 2);
    const expectedBags = bagsForKg(expectedKg, 60);
    expect(expectedBags).toBe(10.88);

    // Item → warehouse view (item page, items list).
    const item = await getItemWarehouseStock(companyId, itemId);
    const atRidwan = item.warehouses.find((w) => w.warehouseId === ridwan)!;
    expect(Number(atRidwan.onHandKg)).toBeCloseTo(652.78, 3);
    expect(atRidwan.bags).toBe(10.88);
    expect(atRidwan.lines[0].bags).toBe(10.88);

    // Batch → where it is (batch page).
    const locations = await getBatchLocations(companyId, batchId);
    expect(locations.find((l) => l.warehouseId === ridwan)!.bags).toBe(10.88);

    // Warehouse totals (dashboard, warehouses page, financial position).
    const warehouses = await getWarehouseStock(companyId);
    expect(warehouses.find((w) => w.warehouseId === ridwan)!.bags).toBe(10.88);

    // The stored balance holds the whole-bag equivalent, never a negative count.
    const stored = await prisma.inventoryBalance.findUniqueOrThrow({ where: { batchId_warehouseId: { batchId, warehouseId: ridwan } } });
    expect(Number(stored.onHandKg)).toBeCloseTo(652.78, 3);
    expect(stored.bags).toBe(11);
  }, 300_000);

  it('keeps the source warehouse in step: what left IPSEN left in bags as well as KG', async () => {
    const item = await getItemWarehouseStock(companyId, itemId);
    const atIpsen = item.warehouses.find((w) => w.warehouseId === ipsen)!;
    const kg = 12960 - 360 - 56.58 - 595.4;
    expect(Number(atIpsen.onHandKg)).toBeCloseTo(kg, 3);
    expect(atIpsen.bags).toBe(bagsForKg(kg, 60));

    // Company-wide the bags on the shelves are the kilograms on the shelves.
    const all = item.warehouses.reduce((sum, w) => sum + w.bags, 0);
    const onHand = Number(item.totalOnHandKg);
    expect(all).toBeCloseTo(onHand / 60, 1);

    // Batch stock (batch list) agrees.
    const [row] = await getBatchStock({ companyId });
    expect(row.bags).toBeCloseTo(onHand / 60, 1);
  }, 300_000);

  it('records bags on every transfer, derived from the weight the way a sale does', async () => {
    const lines = await prisma.stockTransferLine.findMany({ where: { batchId }, orderBy: { quantityKg: 'asc' } });
    expect(lines.map((l) => [Number(l.quantityKg), l.bags])).toEqual([
      [56.58, 1],
      [360, 6],
      [595.4, 10],
    ]);
    // And the movements written by receiving them carry the same count, out and in.
    const moves = await prisma.inventoryTransaction.findMany({ where: { batchId, transactionType: { in: ['TRANSFER_IN', 'TRANSFER_OUT'] } } });
    for (const move of moves) {
      expect(Math.sign(move.bags)).toBe(Math.sign(Number(move.quantityKg)));
    }
  }, 300_000);

  it('never shows negative bags while the kilograms are positive, anywhere in the company', async () => {
    const balances = await prisma.inventoryBalance.findMany({ where: { companyId } });
    for (const balance of balances) {
      if (Number(balance.onHandKg) >= 0) expect(balance.bags).toBeGreaterThanOrEqual(0);
    }
    const item = await getItemWarehouseStock(companyId, itemId);
    for (const warehouse of item.warehouses) {
      if (Number(warehouse.onHandKg) >= 0) expect(warehouse.bags).toBeGreaterThanOrEqual(0);
    }
  }, 300_000);
});

describe('Warehouse transfer numbers', () => {
  it('numbers the transfers already made WTO-001, WTO-002, WTO-003', async () => {
    const numbers = (await prisma.stockTransfer.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } })).map((t) => t.transferNumber);
    expect(numbers).toEqual(['WTO-001', 'WTO-002', 'WTO-003']);
    expect(await transaction((tx) => suggestStockTransferNumber(tx, companyId))).toBe('WTO-004');
  }, 300_000);

  it('issues a deleted draft\'s number again, and keeps a cancelled transfer\'s', async () => {
    const draft = await createStockTransfer(
      { companyId, transferDate: utcDate('2026-09-10'), fromWarehouseId: ipsen, toWarehouseId: ridwan, lines: [{ batchId, quantityKg: '10' }] },
      ctx.admin.id,
    );
    expect(draft.transferNumber).toBe('WTO-004');
    await deleteDraftStockTransfer({ id: draft.id, companyId, userId: ctx.admin.id });
    expect(await transaction((tx) => suggestStockTransferNumber(tx, companyId))).toBe('WTO-004');

    const cancelled = await createStockTransfer(
      { companyId, transferDate: utcDate('2026-09-10'), fromWarehouseId: ipsen, toWarehouseId: ridwan, lines: [{ batchId, quantityKg: '10' }] },
      ctx.admin.id,
    );
    expect(cancelled.transferNumber).toBe('WTO-004');
    await cancelStockTransfer({ id: cancelled.id, companyId, userId: ctx.admin.id, reason: 'Wrong warehouse' });
    // Still on the list as cancelled, so its number stays with it.
    expect(await transaction((tx) => suggestStockTransferNumber(tx, companyId))).toBe('WTO-005');
  }, 300_000);

  it('never hands two people saving at once the same number', async () => {
    const created = await Promise.all(
      Array.from({ length: 5 }, () =>
        createStockTransfer(
          { companyId, transferDate: utcDate('2026-09-12'), fromWarehouseId: ipsen, toWarehouseId: ridwan, lines: [{ batchId, quantityKg: '1' }] },
          ctx.admin.id,
        ),
      ),
    );
    const numbers = created.map((t) => t.transferNumber).sort();
    expect(numbers).toEqual(['WTO-005', 'WTO-006', 'WTO-007', 'WTO-008', 'WTO-009']);
    expect(new Set(numbers).size).toBe(5);
  }, 300_000);

  it('counts a transfer raised under the old numbering as its place in the sequence', async () => {
    // A transfer stored the old way, as the client's first four were.
    const legacy = await prisma.stockTransfer.findFirstOrThrow({ where: { companyId, transferNumber: 'WTO-009' } });
    await prisma.stockTransfer.update({ where: { id: legacy.id }, data: { transferNumber: 'FID-MA-ST-000010' } });

    expect(parseTransferSequence('FID-MA-ST-000010')).toBe(10);
    expect(transferNumberLabel('FID-MA-ST-000010')).toBe('WTO-010');
    // 9 is free again; 10 is held by the old-style number and is never issued twice.
    expect(await transaction((tx) => suggestStockTransferNumber(tx, companyId))).toBe('WTO-009');
    const next = await createStockTransfer(
      { companyId, transferDate: utcDate('2026-09-13'), fromWarehouseId: ipsen, toWarehouseId: ridwan, lines: [{ batchId, quantityKg: '1' }] },
      ctx.admin.id,
    );
    expect(next.transferNumber).toBe('WTO-009');
    expect(await transaction((tx) => suggestStockTransferNumber(tx, companyId))).toBe('WTO-011');
  }, 300_000);

  it('keeps Dubai and Morocco on their own sequences', async () => {
    expect(await transaction((tx) => suggestStockTransferNumber(tx, ctx.dubai.id))).toBe('WTO-001');
  }, 300_000);
});

describe('one invoice selling from two warehouses', () => {
  it('takes each line out of its own warehouse, in KG and in bags', async () => {
    const before = await getItemWarehouseStock(companyId, itemId);
    const kgAt = (stock: typeof before, id: string) => Number(stock.warehouses.find((w) => w.warehouseId === id)!.onHandKg);

    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-09-20'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        lines: [
          { batchId, warehouseId: ipsen, quantity: '600', unit: 'KG' as const, unitPrice: '60.00' },
          { batchId, warehouseId: ridwan, quantity: '120', unit: 'KG' as const, unitPrice: '62.00' },
        ],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

    const lines = await prisma.salesInvoiceLine.findMany({ where: { salesInvoiceId: invoice.id }, orderBy: { lineNumber: 'asc' } });
    expect(lines.map((l) => l.warehouseId)).toEqual([ipsen, ridwan]);
    expect(lines.map((l) => l.bags)).toEqual([10, 2]);

    const after = await getItemWarehouseStock(companyId, itemId);
    expect(kgAt(before, ipsen) - kgAt(after, ipsen)).toBeCloseTo(600, 3);
    expect(kgAt(before, ridwan) - kgAt(after, ridwan)).toBeCloseTo(120, 3);
    // And the bags on each shelf still follow its kilograms.
    for (const warehouse of after.warehouses) {
      expect(warehouse.bags).toBe(bagsForKg(warehouse.onHandKg, 60));
    }
  }, 300_000);
});
