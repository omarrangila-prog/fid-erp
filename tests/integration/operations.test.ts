import { beforeAll, describe, expect, it } from 'vitest';
import {
  prisma, resetDatabase, getContext, createMasters, utcDate, receiveEverything, transaction,
} from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import {
  createStockTransfer, approveStockTransfer, dispatchStockTransfer, receiveStockTransfer,
} from '@/lib/services/stock-transfer';
import { createExpense, postExpense } from '@/lib/services/expense';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { getReceivables, summariseAgeing } from '@/lib/services/receivables';
import { getContainerProfitability } from '@/lib/services/profitability';
import { getTrialBalanceReport } from '@/lib/services/reports';

/**
 * The operational scenarios from the acceptance list: Morocco's two warehouses,
 * container accounting, petty cash, job costing, and the manual journal.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
});

// ---------------------------------------------------------------------------
describe('Morocco — two warehouses, and a transfer that must not invent coffee', () => {
  let masters: Awaited<ReturnType<typeof createMasters>>;
  let batchId: string;
  let warehouseA: string;
  let warehouseB: string;

  beforeAll(async () => {
    masters = await createMasters(ctx.morocco.id, { currency: 'MAD' });
    warehouseA = masters.warehouses[0].id;
    warehouseB = masters.warehouses[1].id;

    const contract = await createPurchaseContract(
      {
        companyId: ctx.morocco.id, contractReference: 'MA-100K', contractDate: utcDate('2026-01-05'),
        vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.85',
        freightAmount: '0',
        lines: [{
          itemId: masters.item.id, lotNumber: 'MA-LOT-1', batchNumber: 'MA-B001',
          quantity: '100000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60',
        }],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
    await receiveEverything({
      companyId: ctx.morocco.id, purchaseContractId: contract.id,
      warehouseId: warehouseA, userId: ctx.admin.id, receiptDate: utcDate('2026-01-20'),
    });
    batchId = (await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;
  });

  async function balances() {
    const rows = await prisma.inventoryBalance.findMany({ where: { batchId } });
    const at = (warehouseId: string) =>
      Number(rows.find((r) => r.warehouseId === warehouseId)?.onHandKg ?? 0);
    return { a: at(warehouseA), b: at(warehouseB), total: rows.reduce((s, r) => s + Number(r.onHandKg), 0) };
  }

  it('lands all 100,000 KG in Warehouse A', async () => {
    expect(await balances()).toMatchObject({ a: 100000, b: 0, total: 100000 });
  });

  it('moves 25,000 KG to Warehouse B without changing the company total', async () => {
    const transfer = await createStockTransfer(
      {
        companyId: ctx.morocco.id, transferDate: utcDate('2026-02-01'),
        fromWarehouseId: warehouseA, toWarehouseId: warehouseB,
        lines: [{ batchId, quantityKg: '25000' }],
      },
      ctx.admin.id,
    );
    const params = { id: transfer.id, companyId: ctx.morocco.id, userId: ctx.admin.id };
    await approveStockTransfer(params);
    await dispatchStockTransfer(params);
    await receiveStockTransfer(params);

    const after = await balances();
    expect(after.a).toBe(75000);
    expect(after.b).toBe(25000);
    // The whole point: 75,000 + 25,000 is still 100,000, not 125,000.
    expect(after.total).toBe(100000);
  });

  it('refuses to move more than the source warehouse holds', async () => {
    await expect(
      createStockTransfer(
        {
          companyId: ctx.morocco.id, transferDate: utcDate('2026-02-02'),
          fromWarehouseId: warehouseB, toWarehouseId: warehouseA,
          lines: [{ batchId, quantityKg: '30000' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
  });

  it('supports a second partial transfer on top of the first', async () => {
    const transfer = await createStockTransfer(
      {
        companyId: ctx.morocco.id, transferDate: utcDate('2026-02-03'),
        fromWarehouseId: warehouseA, toWarehouseId: warehouseB,
        lines: [{ batchId, quantityKg: '5000' }],
      },
      ctx.admin.id,
    );
    const params = { id: transfer.id, companyId: ctx.morocco.id, userId: ctx.admin.id };
    await approveStockTransfer(params);
    await dispatchStockTransfer(params);
    await receiveStockTransfer(params);

    const after = await balances();
    expect(after).toMatchObject({ a: 70000, b: 30000, total: 100000 });
  });
});

// ---------------------------------------------------------------------------
describe('Dubai — containers purchased, sold and available', () => {
  let masters: Awaited<ReturnType<typeof createMasters>>;
  let contractId: string;

  beforeAll(async () => {
    masters = await createMasters(ctx.dubai.id);
    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id, contractReference: 'DXB-3CTR', contractDate: utcDate('2026-01-05'),
        vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        freightAmount: '5760',
        lines: [1, 2, 3].map((n) => ({
          itemId: masters.item.id, lotNumber: `DXB-LOT-${n}`, batchNumber: `DXB-B00${n}`,
          containerNumber: `DXBU100000${n}`, quantity: '19200', unit: 'KG' as const,
          unitPrice: '4.50', bagWeightKg: '60',
        })),
      },
      ctx.admin.id,
    );
    contractId = contract.id;
    await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    await receiveEverything({
      companyId: ctx.dubai.id, purchaseContractId: contract.id,
      warehouseId: masters.warehouse.id, userId: ctx.admin.id, receiptDate: utcDate('2026-01-25'),
    });
  });

  it('records three containers, each with its own lot and batch', async () => {
    const containers = await prisma.container.findMany({ where: { purchaseContractId: contractId } });
    expect(containers).toHaveLength(3);
    const batches = await prisma.batch.findMany({ where: { purchaseContractId: contractId } });
    expect(batches).toHaveLength(3);
    expect(new Set(batches.map((b) => b.containerId)).size).toBe(3);
    expect(new Set(batches.map((b) => b.lotId)).size).toBe(3);
  });

  it('accounts for kilograms purchased, sold and available per container', async () => {
    const batches = await prisma.batch.findMany({
      where: { purchaseContractId: contractId }, orderBy: { batchNumber: 'asc' },
    });
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id, invoiceDate: utcDate('2026-02-01'), customerId: masters.customer.id,
        currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        lines: [{ batchId: batches[0].id, warehouseId: masters.warehouse.id, quantity: '10000', unit: 'KG', unitPrice: '6.20' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const rows = await getContainerProfitability({ companyId: ctx.dubai.id });
    const sold = rows.filter((r) => Number(r.quantityKg) > 0);
    expect(sold).toHaveLength(1);
    expect(Number(sold[0].quantityKg)).toBe(10000);

    const first = await prisma.batch.findUniqueOrThrow({ where: { id: batches[0].id } });
    expect(Number(first.orderedQuantityKg)).toBe(19200);
    expect(Number(first.soldQuantityKg)).toBe(10000);
    expect(Number(first.availableQuantityKg)).toBe(9200);
  });
});

// ---------------------------------------------------------------------------
describe('petty cash and job costing', () => {
  let masters: Awaited<ReturnType<typeof createMasters>>;
  let shipmentId: string;

  beforeAll(async () => {
    masters = await createMasters(ctx.dubai.id);
    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id, contractReference: 'DXB-JOB-1', contractDate: utcDate('2026-03-01'),
        vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        freightAmount: '0',
        lines: [{
          itemId: masters.item.id, lotNumber: 'JOB-LOT-1', batchNumber: 'JOB-B001',
          quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60',
        }],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    shipmentId = (await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;
  });

  it('pays a transport expense out of AED petty cash and reduces that balance', async () => {
    const petty = await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, accountType: 'PETTY_CASH', currency: 'AED' },
    });
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, code: 'TRANSPORT' },
    });

    const expense = await createExpense(
      {
        companyId: ctx.dubai.id, expenseDate: utcDate('2026-03-05'),
        expenseCategoryId: category.id, shipmentId,
        currency: 'AED', amount: '10000', rateToUsd: '3.6725', rateLocalPerUsd: '3.6725',
        cashBankAccountId: petty.id, paymentMethod: 'CASH',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const lines = await prisma.journalLine.findMany({
      where: { cashBankAccountId: petty.id },
    });
    const movementAed = lines.reduce((sum, l) => sum + Number(l.debitLocal) - Number(l.creditLocal), 0);
    // Cash went out: AED 10,000 credited to petty cash.
    expect(movementAed).toBeCloseTo(-10000, 2);
  });

  it('capitalises the transport cost into the job, raising the landed cost per KG', async () => {
    const batch = await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'JOB-B001' } });
    // 20,000 KG at 4.00 = 80,000, plus AED 10,000 (USD 2,723.08) of transport.
    expect(Number(batch.landedUnitCostUsd)).toBeGreaterThan(4);
    expect(Number(batch.capitalisedCostUsd)).toBeGreaterThan(0);

    const perKg = Number(batch.landedUnitCostUsd);
    const perBag = perKg * Number(batch.bagWeightKg);
    expect(perBag).toBeCloseTo(perKg * 60, 6);
  });
});

// ---------------------------------------------------------------------------
describe('receivable ageing buckets', () => {
  it('places each invoice in the right bucket by how overdue it is', async () => {
    const masters = await createMasters(ctx.dubai.id);
    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id, contractReference: 'AGE-1', contractDate: utcDate('2025-01-01'),
        vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        freightAmount: '0',
        lines: [{
          itemId: masters.item.id, lotNumber: 'AGE-LOT', batchNumber: 'AGE-B001',
          quantity: '50000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60',
        }],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    await receiveEverything({
      companyId: ctx.dubai.id, purchaseContractId: contract.id,
      warehouseId: masters.warehouse.id, userId: ctx.admin.id, receiptDate: utcDate('2025-01-10'),
    });
    const batch = await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'AGE-B001' } });

    const today = new Date();
    const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000);

    // Four invoices with zero payment terms, dated so each lands in its own bucket.
    for (const [index, age] of [5, 20, 45, 200].entries()) {
      const invoice = await createSalesInvoice(
        {
          companyId: ctx.dubai.id, invoiceDate: daysAgo(age), customerId: masters.customer.id,
          currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725', paymentTermDays: 0,
          lines: [{ batchId: batch.id, warehouseId: masters.warehouse.id, quantity: '1000', unit: 'KG', unitPrice: `${index + 1}0.00` }],
        },
        ctx.admin.id,
      );
      await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    }

    // Scoped to this customer: earlier blocks in the suite left their own
    // invoices on the Dubai books.
    const all = await getReceivables({ companyId: ctx.dubai.id, onlyOutstanding: true });
    const rows = all.filter((r) => r.customerId === masters.customer.id);
    const summary = summariseAgeing(rows);
    const byBucket = Object.fromEntries(summary.map((s) => [s.bucket, Number(s.amountUsd)]));

    // 5 days past a zero-day term → 1–30. 20 → 1–30. 45 → 31–60. 200 → 90+.
    expect(byBucket.D1_30).toBeCloseTo(10000 + 20000, 2);
    expect(byBucket.D31_60).toBeCloseTo(30000, 2);
    expect(byBucket.D90_PLUS).toBeCloseTo(40000, 2);

    const total = summary.reduce((sum, s) => sum + Number(s.amountUsd), 0);
    const listed = rows.reduce((sum, r) => sum + Number(r.outstandingAmountUsd), 0);
    expect(total).toBeCloseTo(listed, 2);

    // And nothing sits in CURRENT: every one of these is past its due date.
    expect(Number(summary.find((s) => s.bucket === 'CURRENT')!.amountUsd)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('manual journal voucher', () => {
  it('posts a balanced entry', async () => {
    const entry = await transaction(async (tx) => {
      const company = await getCompanyContext(tx, ctx.dubai.id);
      const cash = await tx.account.findFirstOrThrow({ where: { companyId: ctx.dubai.id, systemKey: 'INVENTORY_ADJUSTMENT' } });
      const other = await tx.account.findFirstOrThrow({ where: { companyId: ctx.dubai.id, type: 'EXPENSE' } });
      return postJournalEntry(tx, {
        companyId: ctx.dubai.id, entryDate: utcDate('2026-04-01'),
        description: 'Manual adjustment', sourceType: 'MANUAL', sourceId: 'JV-TEST-1',
        createdById: ctx.admin.id, localCurrency: company.localCurrency, rateLocalPerUsd: '3.6725',
        lines: [
          { accountId: other.id, direction: 'DEBIT', currency: 'USD', amount: '500', rateToUsd: '1' },
          { accountId: cash.id, direction: 'CREDIT', currency: 'USD', amount: '500', rateToUsd: '1' },
        ],
      });
    });
    expect(entry.entryNumber).toBeTruthy();
  });

  it('refuses an entry whose debits and credits differ', async () => {
    await expect(
      transaction(async (tx) => {
        const company = await getCompanyContext(tx, ctx.dubai.id);
        const cash = await tx.account.findFirstOrThrow({ where: { companyId: ctx.dubai.id, systemKey: 'INVENTORY_ADJUSTMENT' } });
        const other = await tx.account.findFirstOrThrow({ where: { companyId: ctx.dubai.id, type: 'EXPENSE' } });
        return postJournalEntry(tx, {
          companyId: ctx.dubai.id, entryDate: utcDate('2026-04-02'),
          description: 'Unbalanced', sourceType: 'MANUAL', sourceId: 'JV-TEST-2',
          createdById: ctx.admin.id, localCurrency: company.localCurrency, rateLocalPerUsd: '3.6725',
          lines: [
            { accountId: other.id, direction: 'DEBIT', currency: 'USD', amount: '500', rateToUsd: '1' },
            { accountId: cash.id, direction: 'CREDIT', currency: 'USD', amount: '400', rateToUsd: '1' },
          ],
        });
      }),
    ).rejects.toThrow();
  });

  it('leaves the trial balance in balance afterwards', async () => {
    const tb = await getTrialBalanceReport({ companyId: ctx.dubai.id });
    expect(tb.isBalanced).toBe(true);
  });
});
