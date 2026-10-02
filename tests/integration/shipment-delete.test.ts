import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { receiveContainers } from '@/lib/services/goods-receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createStockTransfer, approveStockTransfer, dispatchStockTransfer, receiveStockTransfer } from '@/lib/services/stock-transfer';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createPayment, postPayment } from '@/lib/services/payment';
import { getShipmentDeletePreview, deleteShipment } from '@/lib/services/shipment-delete';
import { getLoadingSheet } from '@/lib/services/loading-sheet';

/**
 * Delete Shipment: one action, the system does the rest.
 *
 *   A — three containers, nothing received: the shipment goes, the order
 *       stays as a draft with the same reference and three lines.
 *   B — two containers received, part moved to a second warehouse, a cost
 *       capitalised before the receipt and one after: one delete reverses the
 *       transfer, both receipts, both costs and the order, and stock, the
 *       stock accounts, in transit and the supplier all come back to nothing.
 *   C — coffee sold, a cost paid, the supplier paid: refused, saying why, and
 *       nothing changes.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let second: string;

async function order(reference: string, containers: string[]) {
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-09-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0', contractReference: reference,
      lines: containers.map((container, i) => ({
        itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '5.00', bagWeightKg: '60',
        containerNumber: container, lotNumber: `${reference}-L${i + 1}`, batchNumber: `${reference}-B${i + 1}`,
      })),
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  return contract.id;
}

async function receiveAll(contractId: string, date: string) {
  const batches = await prisma.batch.findMany({ where: { purchaseContractId: contractId, status: 'ACTIVE' }, include: { container: true } });
  await receiveContainers({
    companyId, purchaseContractId: contractId, receiptDate: utcDate(date), receivedById: ctx.admin.id,
    lines: batches.map((b) => ({ batchId: b.id, quantityKg: '10000', containerNumber: b.container?.containerNumber, warehouseId: masters.warehouse.id })) as never,
  });
  return batches;
}

async function cost(contractId: string, amount: string, paid = false) {
  const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT', capitaliseByDefault: true }, orderBy: { code: 'asc' } });
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contractId }, orderBy: { createdAt: 'asc' } });
  const cash = paid ? await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'USD', status: 'ACTIVE' } }) : null;
  const expense = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-09-20'), expenseCategoryId: category.id, shipmentId: shipment.id,
      ...(cash ? { cashBankAccountId: cash.id } : { vendorId: masters.vendor.id }),
      currency: 'USD', amount, rateToUsd: '1', rateLocalPerUsd: '9.6',
    } as never,
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
  return expense.id;
}

/** Company-wide balance of one account, USD and local, from every posted entry. */
async function gl(key: string) {
  const [row] = await prisma.$queryRawUnsafe<Array<{ usd: string | null; loc: string | null }>>(
    `SELECT SUM(jl."debitUsd" - jl."creditUsd")::text usd, SUM(jl."debitLocal" - jl."creditLocal")::text loc
       FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId" JOIN accounts a ON a."id" = jl."accountId"
      WHERE je."companyId" = $1 AND je."status" = 'POSTED' AND a."systemKey" = $2`,
    companyId,
    key,
  );
  return { usd: Number(row?.usd ?? 0), local: Number(row?.loc ?? 0) };
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  second = masters.warehouses[1]?.id ?? (await prisma.warehouse.create({ data: { companyId, code: 'WH-DEL', name: 'Second store', location: 'Casablanca' } })).id;
}, 300_000);

describe('A — nothing received yet', () => {
  it('deletes the shipment and keeps the order as a draft with every container line', async () => {
    const id = await order('ICUL/DEL/A', ['DELA0000001', 'DELA0000002', 'DELA0000003']);
    const preview = await getShipmentDeletePreview(companyId, id);
    expect(preview.canDelete).toBe(true);
    expect(preview.containerCount).toBe(3);
    expect(preview.receipts).toHaveLength(0);

    const result = await deleteShipment({ companyId, userId: ctx.admin.id, contractId: id, mode: 'keep-order', reason: 'Wrong purchase order' });
    expect((await prisma.purchaseContract.findUniqueOrThrow({ where: { id } })).status).toBe('REVERSED');
    const draft = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: result.draftId! }, include: { lines: true } });
    expect(draft.status).toBe('DRAFT');
    expect(draft.contractReference).toBe('ICUL/DEL/A');
    expect(draft.lines.map((l) => l.containerNumber).sort()).toEqual(['DELA0000001', 'DELA0000002', 'DELA0000003']);
    // Off the loading sheet; the books as if it had never been approved.
    expect((await getLoadingSheet(companyId)).some((r) => r.contractId === id || r.contractId === draft.id)).toBe(false);
    expect((await gl('ACCOUNTS_PAYABLE')).usd).toBeCloseTo(0, 2);
    expect((await gl('INVENTORY_IN_TRANSIT')).usd).toBeCloseTo(0, 2);
    expect(await prisma.batch.count({ where: { purchaseContractId: id, status: 'ACTIVE' } })).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: 'SHIPMENT_DELETED' } });
    expect(JSON.stringify(audit.after)).toMatch(/Wrong purchase order/);
  }, 180_000);
});

describe('B — received, moved, costed, nothing sold', () => {
  it('reverses the transfer, the receipts and the costs and deletes the order, leaving the books at nothing', async () => {
    const id = await order('ICUL/DEL/B', ['DELB0000001', 'DELB0000002']);
    await cost(id, '800'); // before the coffee lands
    const batches = await receiveAll(id, '2026-09-25');
    await cost(id, '400'); // freight billed after it landed
    const transfer = await createStockTransfer(
      { companyId, transferDate: utcDate('2026-09-26'), fromWarehouseId: masters.warehouse.id, toWarehouseId: second, lines: [{ batchId: batches[0].id, quantityKg: '3000' }] } as never,
      ctx.admin.id,
    );
    await approveStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });
    await dispatchStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });
    await receiveStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });

    expect((await gl('INVENTORY')).usd).toBeCloseTo(101_200, 2);
    const preview = await getShipmentDeletePreview(companyId, id);
    expect(preview.canDelete).toBe(true);
    expect(preview.receipts.filter((r) => r.status === 'POSTED')).toHaveLength(1);
    expect(preview.transfers.map((t) => t.action)).toEqual(['reverse']);
    expect(preview.costs.map((c) => c.settlement)).toEqual(['UNPAID', 'UNPAID']);
    expect(preview.willUndo.join(' ')).toMatch(/Goods receipt/);

    await deleteShipment({ companyId, userId: ctx.admin.id, contractId: id, mode: 'delete-order', reason: 'Test entry', memo: 'entered for training' });

    // Stock: nothing left anywhere, no draft order.
    expect(Number((await prisma.inventoryBalance.aggregate({ where: { companyId }, _sum: { onHandKg: true } }))._sum.onHandKg ?? 0)).toBe(0);
    expect(await prisma.purchaseContract.count({ where: { companyId, contractReference: 'ICUL/DEL/B' } })).toBe(0);
    expect(await prisma.goodsReceipt.count({ where: { purchaseContractId: id, status: 'POSTED' } })).toBe(0);
    expect(await prisma.expense.count({ where: { purchaseContractId: id, status: 'POSTED' } })).toBe(0);
    expect(await prisma.expense.count({ where: { shipment: { purchaseContractId: id }, status: 'POSTED' } })).toBe(0);

    // The books: every account this shipment touched is back where it started, in USD and in dirhams.
    for (const key of ['INVENTORY', 'INVENTORY_IN_TRANSIT', 'ACCOUNTS_PAYABLE', 'COST_OF_GOODS_SOLD']) {
      const balance = await gl(key);
      expect(balance.usd, `${key} USD`).toBeCloseTo(0, 2);
      expect(balance.local, `${key} MAD`).toBeCloseTo(0, 1);
    }
  }, 240_000);
});

describe('C — refused when something real depends on it', () => {
  it('sold coffee: refused, listing the invoice, and nothing changes', async () => {
    const id = await order('ICUL/DEL/C', ['DELC0000001']);
    const [batch] = await receiveAll(id, '2026-09-25');
    const invoice = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate('2026-09-27'), customerId: masters.customer.id, currency: 'MAD', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        lines: [{ batchId: batch.id, warehouseId: masters.warehouse.id, quantity: '1000', unit: 'KG' as const, unitPrice: '60' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

    const preview = await getShipmentDeletePreview(companyId, id);
    expect(preview.canDelete).toBe(false);
    expect(preview.sales).toHaveLength(1);
    expect(preview.blockers.join(' ')).toMatch(/sold on 1 sales invoice/);
    await expect(deleteShipment({ companyId, userId: ctx.admin.id, contractId: id, mode: 'delete-order', reason: 'Mistaken entry' })).rejects.toThrow(/sold/);
    expect((await prisma.purchaseContract.findUniqueOrThrow({ where: { id } })).status).toBe('POSTED');
    expect(await prisma.goodsReceipt.count({ where: { purchaseContractId: id, status: 'POSTED' } })).toBe(1);
  }, 180_000);

  it('a paid cost or a supplier payment: refused, saying why', async () => {
    const paidCost = await order('ICUL/DEL/D', ['DELD0000001']);
    await cost(paidCost, '250', true);
    const p1 = await getShipmentDeletePreview(companyId, paidCost);
    expect(p1.canDelete).toBe(false);
    expect(p1.blockers.join(' ')).toMatch(/been paid/);

    const paidSupplier = await order('ICUL/DEL/E', ['DELE0000001']);
    const bank = (await prisma.cashBankAccount.findFirst({ where: { companyId, currency: 'USD', accountType: 'BANK' } })) ?? (await getCashAccount(companyId, 'USD'));
    const payment = await createPayment(
      {
        companyId, paymentDate: utcDate('2026-09-10'), vendorId: masters.vendor.id, currency: 'USD', amount: '1000',
        rateToUsd: '1', rateLocalPerUsd: '9.6', paymentMethod: 'BANK_TRANSFER', cashBankAccountId: bank.id,
        allocations: [{ purchaseContractId: paidSupplier, amount: '1000' }],
      } as never,
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });
    const p2 = await getShipmentDeletePreview(companyId, paidSupplier);
    expect(p2.canDelete).toBe(false);
    expect(p2.blockers.join(' ')).toMatch(/supplier has been paid/);
    await expect(deleteShipment({ companyId, userId: ctx.admin.id, contractId: paidSupplier, mode: 'keep-order', reason: 'Duplicate shipment' })).rejects.toThrow(/paid/);
  }, 180_000);

  it('never reaches another company’s shipment, and wants a reason', async () => {
    const id = await order('ICUL/DEL/F', ['DELF0000001']);
    await expect(getShipmentDeletePreview(ctx.dubai.id, id)).rejects.toThrow(/not found/i);
    await expect(deleteShipment({ companyId: ctx.dubai.id, userId: ctx.admin.id, contractId: id, mode: 'delete-order', reason: 'Test entry' })).rejects.toThrow(/not found/i);
    await expect(deleteShipment({ companyId, userId: ctx.admin.id, contractId: id, mode: 'delete-order', reason: '' })).rejects.toThrow(/why/i);
    expect((await prisma.purchaseContract.findUniqueOrThrow({ where: { id } })).status).toBe('POSTED');
  }, 120_000);
});
