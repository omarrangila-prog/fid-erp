import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, transaction } from '../helpers';
import { resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createExpense, postExpense, createExpenseIn, postExpenseIn } from '@/lib/services/expense';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { getCashBankBalance } from '@/lib/services/accounting';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { reconcile } from '@/lib/services/reconciliation';
import { dec, toMoney } from '@/lib/money';

/**
 * The invariants, one test each.
 *
 * Every bug this application has had came back as a line in this file. They
 * are written as the client stated them, in the client's words, so that if one
 * ever fails the failure reads like the complaint that caused it rather than
 * like a stack trace. Other suites cover these paths in more depth; this one
 * exists so there is a single place that says what must never happen again.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let shipmentId: string;
let contractId: string;
let madCash: string;

/** A GL balance in USD, straight from the posted journal. */
async function control(systemKey: string) {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return toMoney(rows[0]?.bal ?? 0);
}

async function categoryId(kind: 'SHIPMENT' | 'GENERAL') {
  const found = await prisma.expenseCategory.findFirstOrThrow({
    where: { companyId, kind, status: 'ACTIVE' },
    orderBy: { code: 'asc' },
  });
  return found.id;
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  const contract = await createPurchaseContract(
    {
      companyId,
      contractReference: 'INV-GUARD-1',
      contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.6',
      freightAmount: '0',
      lines: [
        {
          itemId: masters.item.id,
          lotNumber: 'GUARD/LOT',
          batchNumber: 'GUARD-B001',
          quantity: '18000',
          unit: 'KG',
          unitPrice: '2.5',
          bagWeightKg: '60',
        },
      ],
    },
    ctx.admin.id,
  );
  contractId = contract.id;
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  shipmentId = shipment.id;
  await receiveEverything({
    companyId,
    purchaseContractId: contract.id,
    warehouseId: masters.warehouse.id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-01-20'),
  });
  madCash = (await getCashAccount(companyId, 'MAD')).id;
}, 240_000);

describe('MAD 7,400 must not become MAD 8,880', () => {
  it('carries one amount from the voucher to the cash book, the ledger and the shipment', async () => {
    const before = await transaction((tx) => getCashBankBalance(tx, companyId, madCash));

    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-02-10'),
        expenseCategoryId: await categoryId('SHIPMENT'),
        shipmentId,
        currency: 'MAD',
        amount: '7400',
        rateToUsd: '9.6',
        rateLocalPerUsd: '9.6',
        cashBankAccountId: madCash,
        paymentMethod: 'CASH',
        kind: 'SHIPMENT',
        description: 'Transport',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    // 1. The document keeps what was typed.
    const saved = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(saved.amount.toString()).toBe('7400');
    expect(saved.taxAmount.toString()).toBe('0');

    // 2. Cash falls by exactly that.
    const after = await transaction((tx) => getCashBankBalance(tx, companyId, madCash));
    expect(toMoney(dec(before).minus(after)).toString()).toBe('7400');

    // 3. The journal moved exactly that, in MAD.
    const lines = await prisma.$queryRaw<Array<{ credit: string }>>`
      SELECT jl."credit"::text AS credit
      FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId"
      WHERE je."sourceId" = ${expense.id} AND je."status" = 'POSTED'
        AND jl."currency" = 'MAD' AND jl."credit" > 0`;
    expect(lines.map((l) => toMoney(l.credit).toString())).toEqual(['7400']);

    // 4. The shipment carries it once, at the same figure.
    const sheet = await getShipmentCostSheet(companyId, shipmentId);
    const mine = sheet.lines.filter((l) => l.expenseId === expense.id);
    expect(mine).toHaveLength(1);
    expect(toMoney(mine[0].amount).toString()).toBe('7400');

    // 5. Nowhere in the books does 8,880 appear for this voucher.
    const inflated = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      WHERE je."sourceId" = ${expense.id} AND (jl."debit" = 8880 OR jl."credit" = 8880)`;
    expect(inflated[0].n).toBe(0);
  }, 180_000);
});

describe('tax 0% must not add VAT', () => {
  it('leaves the amount alone when no tax code is named', async () => {
    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-02-11'),
        expenseCategoryId: await categoryId('GENERAL'),
        currency: 'MAD',
        amount: '1000',
        rateToUsd: '9.6',
        rateLocalPerUsd: '9.6',
        cashBankAccountId: madCash,
        paymentMethod: 'CASH',
        kind: 'GENERAL',
        description: 'No tax code given',
      },
      ctx.admin.id,
    );
    const saved = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(saved.taxAmount.toString()).toBe('0');
    expect(saved.taxRatePct.toString()).toBe('0');
    expect(saved.amount.toString()).toBe('1000');
  }, 120_000);
});

describe('a MAD cash account stays MAD', () => {
  it('refuses a USD amount through a MAD drawer', async () => {
    await expect(
      createExpense(
        {
          companyId,
          expenseDate: utcDate('2026-02-12'),
          expenseCategoryId: await categoryId('GENERAL'),
          currency: 'USD',
          amount: '100',
          rateToUsd: '1',
          rateLocalPerUsd: '9.6',
          cashBankAccountId: madCash,
          paymentMethod: 'CASH',
          kind: 'GENERAL',
          description: 'USD through the MAD till',
        },
        ctx.admin.id,
      ).then((e) => postExpense({ id: e.id, companyId, userId: ctx.admin.id })),
      // Refused at entry, before it ever reaches the ledger.
    ).rejects.toThrow(/is a MAD account|held in MAD|cannot be recorded through it/i);
  }, 120_000);
});

describe('nothing reverses itself', () => {
  it('leaves a posted invoice posted, with no mirror entry, when nobody asks', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-02-13'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.6',
        rateLocalPerUsd: '9.6',
        paymentType: 'CREDIT',
        lines: [
          {
            batchId: (await prisma.batch.findFirstOrThrow({ where: { companyId } })).id,
            warehouseId: masters.warehouse.id,
            quantity: '100',
            unit: 'KG',
            unitPrice: '40',
          },
        ],
      },
      ctx.admin.id,
    );
    const posted = await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
    expect(posted.status).toBe('POSTED');

    // Read it back the way a screen would, more than once: nothing about
    // looking at a document may change it.
    for (let i = 0; i < 3; i += 1) {
      const again = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(again.status).toBe('POSTED');
      expect(again.reversedAt).toBeNull();
    }
    const mirrors = await prisma.journalEntry.count({
      where: { sourceId: invoice.id, isReversal: true },
    });
    expect(mirrors).toBe(0);
  }, 180_000);
});

describe('a document posts once and only once', () => {
  it('refuses a second post of the same expense', async () => {
    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-02-14'),
        expenseCategoryId: await categoryId('GENERAL'),
        currency: 'MAD',
        amount: '250',
        rateToUsd: '9.6',
        rateLocalPerUsd: '9.6',
        cashBankAccountId: madCash,
        paymentMethod: 'CASH',
        kind: 'GENERAL',
        description: 'Posted twice on purpose',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
    await expect(postExpense({ id: expense.id, companyId, userId: ctx.admin.id })).rejects.toThrow(
      /already|cannot be posted again/i,
    );
    const entries = await prisma.journalEntry.count({ where: { sourceId: expense.id, status: 'POSTED' } });
    expect(entries).toBe(1);
  }, 120_000);

  it('adds a shipment cost to the shipment once, not twice', async () => {
    const before = await getShipmentCostSheet(companyId, shipmentId);
    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-02-15'),
        expenseCategoryId: await categoryId('SHIPMENT'),
        shipmentId,
        currency: 'MAD',
        amount: '960',
        rateToUsd: '9.6',
        rateLocalPerUsd: '9.6',
        cashBankAccountId: madCash,
        paymentMethod: 'CASH',
        kind: 'SHIPMENT',
        description: 'Counted once',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
    const after = await getShipmentCostSheet(companyId, shipmentId);
    expect(after.lines.filter((l) => l.expenseId === expense.id)).toHaveLength(1);
    expect(after.lines.length).toBe(before.lines.length + 1);
  }, 180_000);

  it('does not double-count when two vouchers are written in one transaction', async () => {
    const before = await transaction((tx) => getCashBankBalance(tx, companyId, madCash));
    await transaction(async (tx) => {
      for (const amount of ['100', '200']) {
        const e = await createExpenseIn(
          tx,
          {
            companyId,
            expenseDate: utcDate('2026-02-16'),
            expenseCategoryId: await categoryId('GENERAL'),
            currency: 'MAD',
            amount,
            rateToUsd: '9.6',
            rateLocalPerUsd: '9.6',
            cashBankAccountId: madCash,
            paymentMethod: 'CASH',
            kind: 'GENERAL',
            description: `Batch ${amount}`,
          },
          ctx.admin.id,
        );
        await postExpenseIn(tx, { id: e.id, companyId, userId: ctx.admin.id });
      }
    }, 120_000);
    const after = await transaction((tx) => getCashBankBalance(tx, companyId, madCash));
    expect(toMoney(dec(before).minus(after)).toString()).toBe('300');
  }, 180_000);
});

describe('the books agree with themselves', () => {
  it('keeps every posted journal balanced, debit for credit', async () => {
    const unbalanced = await prisma.$queryRaw<Array<{ entryNumber: string }>>`
      SELECT je."entryNumber"
      FROM journal_entries je JOIN journal_lines jl ON jl."journalEntryId" = je."id"
      WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'
      GROUP BY je."id", je."entryNumber"
      HAVING ABS(SUM(jl."debitUsd") - SUM(jl."creditUsd")) > 0.005`;
    expect(unbalanced.map((u) => u.entryNumber)).toEqual([]);
  }, 120_000);

  it('never leaves a posted document without its journal', async () => {
    const orphans = await prisma.$queryRaw<Array<{ number: string }>>`
      SELECT si."invoiceNumber" AS number FROM sales_invoices si
       WHERE si."companyId" = ${companyId} AND si."status" = 'POSTED'
         AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je."sourceId" = si."id" AND je."status" = 'POSTED')
      UNION ALL
      SELECT e."expenseNumber" FROM expenses e
       WHERE e."companyId" = ${companyId} AND e."status" = 'POSTED'
         AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je."sourceId" = e."id" AND je."status" = 'POSTED')`;
    expect(orphans.map((o) => o.number)).toEqual([]);
  }, 120_000);

  it('holds cash, bank, receivables and payables level with the ledger', async () => {
    // A receipt so the customer side is not trivially empty.
    const invoice = await prisma.salesInvoice.findFirstOrThrow({
      where: { companyId, status: 'POSTED' },
      orderBy: { invoiceNumber: 'desc' },
    });
    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-02-20'),
        customerId: invoice.customerId,
        currency: 'MAD',
        amount: '1000',
        rateToUsd: '9.6',
        rateLocalPerUsd: '9.6',
        paymentMethod: 'CASH',
        cashBankAccountId: madCash,
        allocations: [{ salesInvoiceId: invoice.id, amount: '1000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const health = await reconcile(companyId);
    const failed = health.checks.filter((c) => !c.passed);
    expect(
      failed.map((c) => `${c.label}: ${c.left.value} vs ${c.right.value}`),
      failed.map((c) => c.label).join('; '),
    ).toEqual([]);
    expect(health.healthy).toBe(true);
  }, 240_000);

  it('balances the accounting equation: assets = liabilities + equity', async () => {
    const [assets, liabilities, equity, income, expenses] = await Promise.all([
      control('ACCOUNTS_RECEIVABLE'),
      control('ACCOUNTS_PAYABLE'),
      control('OPENING_BALANCE_EQUITY'),
      control('SALES_REVENUE'),
      control('EXPENSE_DEFAULT'),
    ]);
    // Every one of these is a real number rather than NaN, which is the shape
    // the bug took the last time a control account went missing.
    for (const value of [assets, liabilities, equity, income, expenses]) {
      expect(Number.isNaN(Number(value))).toBe(false);
    }

    const totals = await prisma.$queryRaw<Array<{ dr: string; cr: string }>>`
      SELECT COALESCE(SUM(jl."debitUsd"), 0)::text AS dr, COALESCE(SUM(jl."creditUsd"), 0)::text AS cr
      FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId"
      WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'`;
    expect(toMoney(dec(totals[0].dr).minus(totals[0].cr)).abs().lessThanOrEqualTo('0.005')).toBe(true);
  }, 120_000);
});

describe('a failed posting leaves nothing behind', () => {
  it('rolls the whole thing back rather than leaving a document without a journal', async () => {
    const countBefore = await prisma.expense.count({ where: { companyId } });
    const journalsBefore = await prisma.journalEntry.count({ where: { companyId } });

    await expect(
      transaction(async (tx) => {
        const e = await createExpenseIn(
          tx,
          {
            companyId,
            expenseDate: utcDate('2026-02-22'),
            expenseCategoryId: await categoryId('GENERAL'),
            currency: 'MAD',
            amount: '500',
            rateToUsd: '9.6',
            rateLocalPerUsd: '9.6',
            cashBankAccountId: madCash,
            paymentMethod: 'CASH',
            kind: 'GENERAL',
            description: 'Will be rolled back',
          },
          ctx.admin.id,
        );
        await postExpenseIn(tx, { id: e.id, companyId, userId: ctx.admin.id });
        // Something goes wrong after the posting, as it would if a later step failed.
        throw new Error('deliberate failure after posting');
      }, 60_000),
    ).rejects.toThrow(/deliberate failure/);

    expect(await prisma.expense.count({ where: { companyId } })).toBe(countBefore);
    expect(await prisma.journalEntry.count({ where: { companyId } })).toBe(journalsBefore);
  }, 180_000);
});
