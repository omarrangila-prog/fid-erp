import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { onceForKey } from '@/lib/services/idempotency';
import { postLoan } from '@/lib/services/loan';
import { reconcile } from '@/lib/services/reconciliation';
import { getCashBankBalance } from '@/lib/services/accounting';
import { transaction } from '@/lib/db';
import { dec } from '@/lib/money';

/**
 * Several postings at once, on one connection.
 *
 * The client's deployment holds a single database connection per instance,
 * because behind a pooler that is the right number. Work that assumed it
 * could take a second one while holding the first deadlocked — every save of
 * a cost, every time — and no test noticed, because the tests ran against a
 * local database with ten connections to spare.
 *
 * So these run the real postings together rather than one after another, and
 * check what the brief asks: nothing exhausted, nothing half written,
 * nothing written twice.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let cashId: string;
let batchId: string;
let categoryId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.6', effectiveDate: utcDate('2026-01-01') },
  });
  cashId = (await getCashAccount(companyId, 'MAD')).id;
  categoryId = (await prisma.expenseCategory.findFirstOrThrow({ where: { companyId }, select: { id: true } })).id;

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0', contractReference: 'ICUL/FID/CONC',
      lines: [{ itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;

  const grn = await createGoodsReceipt(
    {
      companyId, purchaseContractId: contract.id, warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-08-10'), receivedById: ctx.admin.id,
      lines: [{ batchId, quantityKg: '10000', lotNumber: 'LOT-CONC' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });
}, 300_000);

describe('several postings at once', () => {
  it('saves six costs together without exhausting the connection', async () => {
    const before = dec(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)));

    const saves = Array.from({ length: 6 }, (_, i) =>
      onceForKey({ companyId, userId: ctx.admin.id, scope: 'EXPENSE', key: `concurrent-${i}-${Date.now()}` }, () =>
        createExpense(
          {
            companyId,
            expenseDate: utcDate('2026-09-01'),
            expenseCategoryId: categoryId,
            currency: 'MAD',
            amount: '100',
            rateToUsd: '9.6',
            rateLocalPerUsd: '9.6',
            paymentMethod: 'CASH',
            cashBankAccountId: cashId,
            description: `Concurrent cost ${i}`,
          } as never,
          ctx.admin.id,
        ),
      ),
    );

    const results = await Promise.all(saves);
    expect(results).toHaveLength(6);
    expect(new Set(results.map((r) => r.id)).size).toBe(6);

    // Post them together too, which is where the ledger work happens.
    await Promise.all(results.map((r) => postExpense({ id: r.id, companyId, userId: ctx.admin.id })));

    const after = dec(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)));
    expect(Number(before.minus(after))).toBeCloseTo(600, 2);
  }, 300_000);

  it('runs different kinds of posting side by side', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate('2026-09-05'), customerId: masters.customer.id, currency: 'MAD',
        rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        lines: [{ batchId, warehouseId: masters.warehouses[0].id, quantity: '500', unit: 'KG' as const, unitPrice: '60.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-09-06'), customerId: masters.customer.id, currency: 'MAD',
        amount: '10000', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        paymentMethod: 'CASH', cashBankAccountId: cashId,
        description: 'Concurrent receipt',
        allocations: [{ salesInvoiceId: invoice.id, amount: '10000' }],
      },
      ctx.admin.id,
    );

    // A receipt, a loan and a cost, all posting at the same moment.
    await Promise.all([
      postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id }),
      postLoan({
        companyId, userId: ctx.admin.id, loanDate: utcDate('2026-09-06'), direction: 'RECEIVED',
        counterpartyName: 'A lender', cashBankAccountId: cashId, currency: 'MAD', amount: '5000',
        description: 'Concurrent loan',
      }),
      (async () => {
        const expense = await createExpense(
          {
            companyId, expenseDate: utcDate('2026-09-06'), expenseCategoryId: categoryId,
            currency: 'MAD', amount: '75', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
            paymentMethod: 'CASH', cashBankAccountId: cashId, description: 'Concurrent alongside',
          } as never,
          ctx.admin.id,
        );
        await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
      })(),
    ]);

    const check = await reconcile(companyId);
    expect(check.checks.filter((c) => !c.passed)).toEqual([]);
  }, 300_000);

  it('writes one cost when the same submission arrives four times at once', async () => {
    const key = `double-click-${Date.now()}`;
    const submissions = Array.from({ length: 4 }, () =>
      onceForKey({ companyId, userId: ctx.admin.id, scope: 'EXPENSE', key }, () =>
        createExpense(
          {
            companyId, expenseDate: utcDate('2026-09-08'), expenseCategoryId: categoryId,
            currency: 'MAD', amount: '42', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
            paymentMethod: 'CASH', cashBankAccountId: cashId, description: 'Submitted four times at once',
          } as never,
          ctx.admin.id,
        ),
      ),
    );

    const results = await Promise.all(submissions);
    // Every caller is told about the same cost, and only one was written.
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await prisma.expense.count({ where: { companyId, description: 'Submitted four times at once' } })).toBe(1);
  }, 300_000);

  it('leaves the books whole', async () => {
    const check = await reconcile(companyId);
    expect(check.checks.filter((c) => !c.passed)).toEqual([]);
  }, 300_000);
});
