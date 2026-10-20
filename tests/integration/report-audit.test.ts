import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract, reversePurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createExpense, postExpense } from '@/lib/services/expense';
import {
  getCashFlow,
  getExpenseReport,
  getExpenseSplit,
  getGeneralLedger,
  getPurchaseRegister,
  getSalesBy,
  getTrialBalanceReport,
} from '@/lib/services/reports';
import { getCogsReport } from '@/lib/services/profitability';
import { getPayables } from '@/lib/services/receivables';
import { dec, sum } from '@/lib/money';

/**
 * The live report audit of 20 Oct 2026, kept as tests.
 *
 * Each case is a difference found in the client's own books: a report that
 * did not agree with the ledger, or that stated a dirham figure as dollars.
 * Every figure here is compared with the source documents or the ledger, not
 * with another report.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let contractId: string;
let reversedId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-02-02'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '10',
      freightAmount: '0',
      lines: [{ itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  contractId = contract.id;
  await postPurchaseContract({ id: contractId, companyId, userId: ctx.admin.id });

  // A second order, posted by mistake and reversed: it was never bought.
  const mistaken = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-02-03'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '10',
      freightAmount: '0',
      lines: [{ itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '5.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  reversedId = mistaken.id;
  await postPurchaseContract({ id: reversedId, companyId, userId: ctx.admin.id });
  await reversePurchaseContract({ id: reversedId, companyId, userId: ctx.admin.id, reason: 'Posted by mistake' });

  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contractId } });
  const grn = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: contractId,
      warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-03-01'),
      receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '20000', lotNumber: 'AUDIT-LOT-1' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  // MAD 12,000 of clearing on the shipment, and MAD 500 of office rent.
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contractId } });
  const cash = await getCashAccount(companyId, 'MAD');
  const category = async (code: string) => (await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, code } })).id;
  for (const [code, amount, kind] of [
    ['CLEARING', '12000', 'SHIPMENT'],
    ['RENT', '500', 'GENERAL'],
  ] as const) {
    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-03-02'),
        expenseCategoryId: await category(code),
        shipmentId: kind === 'SHIPMENT' ? shipment.id : null,
        currency: 'MAD',
        amount,
        rateToUsd: '9.6',
        rateLocalPerUsd: '9.6',
        cashBankAccountId: cash.id,
        kind,
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
  }

  // 5,000 KG sold for MAD 60 a KG, invoiced in dirhams.
  const invoice = await createSalesInvoice(
    {
      companyId,
      invoiceDate: utcDate('2026-03-10'),
      dueDate: utcDate('2026-04-10'),
      customerId: masters.customer.id,
      currency: 'MAD',
      rateToUsd: '9.6',
      rateLocalPerUsd: '9.6',
      lines: [{ batchId: batch.id, warehouseId: masters.warehouses[0].id, quantity: '5000', unit: 'KG', unitPrice: '60.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
}, 300_000);

async function ledgerLocal(systemKey: string) {
  const rows = await prisma.$queryRaw<Array<{ local: string }>>`
    SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local
      FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId" JOIN accounts a ON a."id" = jl."accountId"
     WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return dec(rows[0]?.local ?? 0);
}

describe('Purchase Report', () => {
  it('lists posted orders only — a reversed order was never bought and is not owed', async () => {
    const rows = await getPurchaseRegister({ companyId });
    expect(rows.map((r) => r.contractId)).toEqual([contractId]);
    expect(sum(rows.map((r) => r.total)).toFixed(2)).toBe('80000.00');
  });

  it('agrees with the payables report and the payables ledger', async () => {
    const register = sum((await getPurchaseRegister({ companyId })).map((r) => r.outstanding));
    const payables = sum((await getPayables({ companyId, onlyOutstanding: true })).map((r) => r.outstandingAmount));
    expect(register.toFixed(2)).toBe(payables.toFixed(2));
    // USD 80,000 at MAD 10 = MAD 800,000 owed.
    expect((await ledgerLocal('ACCOUNTS_PAYABLE')).negated().toFixed(2)).toBe('800000.00');
  });
});

describe('Expense Report', () => {
  it('totals in dirhams, as the bills were paid, with the USD value beside it', async () => {
    const rows = await getExpenseReport({ companyId, groupBy: 'type' });
    expect(sum(rows.map((r) => r.amountLocal)).toFixed(2)).toBe('12500.00');
    const split = await getExpenseSplit({ companyId });
    expect(split.capitalisedLocal.toFixed(2)).toBe('12000.00');
    expect(split.generalLocal.toFixed(2)).toBe('500.00');
    expect(split.totalSpendLocal.toFixed(2)).toBe('12500.00');
    // USD 12,500 / 9.6, never MAD 12,500 called dollars.
    expect(split.totalSpendUsd.toFixed(2)).toBe('1302.08');
  });
});

describe('Cash Flow', () => {
  it('states the dirhams that left the drawer, and agrees with the cash ledger', async () => {
    const flow = await getCashFlow({ companyId, from: utcDate('2026-01-01'), to: utcDate('2026-12-31') });
    expect(flow.totalOutLocal.toFixed(2)).toBe('12500.00');
    const cash = await getCashAccount(companyId, 'MAD');
    const rows = await prisma.$queryRaw<Array<{ net: string }>>`
      SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS net
        FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId"
       WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND jl."cashBankAccountId" = ${cash.id}`;
    expect(flow.netMovementLocal.toFixed(2)).toBe(dec(rows[0].net).toFixed(2));
  });
});

describe('Sales by customer', () => {
  it('states revenue as invoiced in MAD and cost as the COGS report has it', async () => {
    const rows = await getSalesBy({ companyId, from: utcDate('2026-01-01'), to: utcDate('2026-12-31'), by: 'customer' });
    const cogs = await getCogsReport({ companyId, from: utcDate('2026-01-01'), to: utcDate('2026-12-31') });
    expect(sum(rows.map((r) => r.revenueLocal)).toFixed(2)).toBe('300000.00');
    expect(sum(rows.map((r) => r.costLocal)).toFixed(2)).toBe(sum(cogs.map((l) => l.cogsLocal)).toFixed(2));
    expect(sum(rows.map((r) => r.revenueLocal)).toFixed(2)).toBe((await ledgerLocal('SALES_REVENUE')).negated().toFixed(2));
  });
});

describe('General Ledger', () => {
  it('reads an account at its MAD value, agreeing with the trial balance to the cent', async () => {
    const inventory = await prisma.account.findFirstOrThrow({ where: { companyId, systemKey: 'INVENTORY' }, select: { id: true } });
    const ledger = await getGeneralLedger({ companyId, accountId: inventory.id, currency: 'LOCAL' });
    expect(ledger.viewCurrency).toBe('LOCAL');
    expect(ledger.displayCurrency).toBe('MAD');
    const tb = await getTrialBalanceReport({ companyId });
    const row = tb.rows.find((r) => r.accountId === inventory.id)!;
    expect(ledger.closingBalance.toFixed(2)).toBe(dec(row.debitLocal).minus(row.creditLocal).toFixed(2));
    expect(ledger.closingBalance.toFixed(2)).toBe((await ledgerLocal('INVENTORY')).toFixed(2));
  });

  it('still lets the reader ask for the USD view', async () => {
    const inventory = await prisma.account.findFirstOrThrow({ where: { companyId, systemKey: 'INVENTORY' }, select: { id: true } });
    const ledger = await getGeneralLedger({ companyId, accountId: inventory.id, currency: 'REPORTING' });
    expect(ledger.displayCurrency).toBe('USD');
  });
});
