import { describe, it, expect, beforeAll } from 'vitest';
import {
  prisma,
  transaction,
  resetDatabase,
  getContext,
  createMasters,
  getCashAccount,
  utcDate,
  receiveEverything,
} from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getTrialBalance } from '@/lib/services/accounting';
import {
  getTrialBalanceReport,
  getProfitAndLoss,
  getBalanceSheet,
  getFinancialPosition,
  getGeneralLedger,
  getCashBook,
  getCashFlow,
  getJournalReport,
  getExpenseReport,
} from '@/lib/services/reports';
import { getDashboard } from '@/lib/services/dashboard';
import { dec } from '@/lib/money';

/**
 * Every report, run against a real posted book.
 *
 * These exist because a report can be silently wrong — or silently broken — in
 * ways the posting tests never notice. One of these queries shipped with a
 * correlated subquery inside an aggregate that Postgres rejects outright, and
 * nothing caught it until the whole report layer was exercised end to end.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let warehouse: { id: string };
let batchId: string;
let invoiceId: string;

const ALL_TIME = { from: utcDate('2020-01-01'), to: utcDate('2035-12-31') };

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id, { currency: 'USD' });
  warehouse = masters.warehouses[0];

  // 20,000 KG at 4.50 with 1,000 freight -> landed 4.55/KG.
  const contract = await createPurchaseContract(
    {
      companyId: ctx.dubai.id,
      contractReference: 'RPT-001',
      contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '3.6725',
      freightAmount: '1000',
      paymentTermDays: 30,
      lines: [
        {
          itemId: masters.item.id,
          lotNumber: 'RPT-LOT-1',
          batchNumber: 'RPT-BAT-1',
          quantity: '20000',
          unit: 'KG',
          unitPrice: '4.50',
          bags: 334,
        },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  await receiveEverything({
    companyId: ctx.dubai.id,
    purchaseContractId: contract.id,
    warehouseId: warehouse.id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-02-01'),
  });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;

  // Sell half at 6.00.
  const invoice = await createSalesInvoice(
    {
      companyId: ctx.dubai.id,
      invoiceDate: utcDate('2026-02-10'),
      customerId: masters.customer.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '3.6725',
      paymentTermDays: 30,
      lines: [{ batchId, warehouseId: warehouse.id, quantity: '10000', unit: 'KG', unitPrice: '6.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  invoiceId = invoice.id;

  // Part payment in AED.
  const aedBank = await getCashAccount(ctx.dubai.id, 'AED');
  const receipt = await createReceipt(
    {
      companyId: ctx.dubai.id,
      receiptDate: utcDate('2026-02-20'),
      customerId: masters.customer.id,
      currency: 'AED',
      amount: '73450',
      usdEquivalent: '20000',
      rateLocalPerUsd: '3.6725',
      cashBankAccountId: aedBank.id,
      allocations: [{ salesInvoiceId: invoice.id, amount: '20000' }],
    },
    ctx.admin.id,
  );
  await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

  // One period cost, so operating expenses are non-zero.
  const bank = await prisma.expenseCategory.findFirstOrThrow({
    where: { companyId: ctx.dubai.id, code: 'BANK' },
  });
  const expense = await createExpense(
    {
      companyId: ctx.dubai.id,
      expenseDate: utcDate('2026-02-25'),
      expenseCategoryId: bank.id,
      currency: 'AED',
      amount: '3672.50',
      rateToUsd: '3.6725',
      rateLocalPerUsd: '3.6725',
      cashBankAccountId: aedBank.id,
      description: 'Bank charges',
    },
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
});

describe('trial balance', () => {
  it('balances in USD and in the local currency', async () => {
    const report = await getTrialBalanceReport({ companyId: ctx.dubai.id });
    expect(report.isBalanced).toBe(true);
    expect(report.totals.debitUsd.toString()).toBe(report.totals.creditUsd.toString());
    expect(report.totals.debitLocal.toString()).toBe(report.totals.creditLocal.toString());
    expect(report.rows.length).toBeGreaterThan(0);
  });
});

describe('profit and loss', () => {
  it('reports revenue, cost of sales and the resulting margins', async () => {
    const pl = await getProfitAndLoss({ companyId: ctx.dubai.id, ...ALL_TIME });

    expect(pl.totals.revenueUsd.toString()).toBe('60000');
    // 10,000 KG at the landed cost of 4.55.
    expect(pl.totals.costOfSalesUsd.toString()).toBe('45500');
    expect(pl.totals.grossProfitUsd.toString()).toBe('14500');
    // AED 3,672.50 at 3.6725 is USD 1,000.
    expect(pl.totals.operatingExpensesUsd.toString()).toBe('1000');
    expect(pl.totals.netProfitUsd.toString()).toBe('13500');
    expect(pl.grossMarginPct.toString()).toBe('24.17');
  });

  it('never counts unsold coffee as revenue', async () => {
    const pl = await getProfitAndLoss({ companyId: ctx.dubai.id, ...ALL_TIME });
    // Half the contract is still in the warehouse, so revenue is on half only.
    expect(pl.totals.revenueUsd.toString()).toBe('60000');
  });
});

describe('balance sheet', () => {
  it('balances, and carries the unsold coffee as an asset', async () => {
    const bs = await getBalanceSheet({ companyId: ctx.dubai.id, asOf: utcDate('2026-12-31') });

    expect(bs.balancesUsd).toBe(true);
    expect(bs.differenceUsd.toString()).toBe('0');

    const inventory = bs.assets.lines.find((l) => l.code === '1200');
    // 10,000 KG left at 4.55.
    expect(inventory?.amountUsd.toString()).toBe('45500');

    // The period result carried into equity matches the P&L.
    const result = bs.equity.lines.find((l) => l.code === '3900');
    expect(result?.amountUsd.toString()).toBe('13500');
  });
});

describe('financial position', () => {
  it('reports cash by currency without merging them', async () => {
    const position = await getFinancialPosition({ companyId: ctx.dubai.id });

    const aed = position.currencyTotals.find((c) => c.currency === 'AED');
    const usd = position.currencyTotals.find((c) => c.currency === 'USD');

    // AED 73,450 in, AED 3,672.50 out.
    expect(aed?.bank.toString()).toBe('69777.5');
    expect(usd?.bank.toString()).toBe('0');
    // Each currency is reported in its own right.
    expect(position.currencyTotals.length).toBeGreaterThanOrEqual(2);
  });

  it('reports receivables, payables and stock', async () => {
    const position = await getFinancialPosition({ companyId: ctx.dubai.id });

    // USD 60,000 invoiced less USD 20,000 received.
    expect(position.receivableUsd.toString()).toBe('40000');
    // The whole contract is still unpaid.
    expect(position.payableUsd.toString()).toBe('91000');
    expect(position.availableKg.toString()).toBe('10000');
    expect(position.inventoryValueUsd.toString()).toBe('45500');
  });
});

describe('general ledger and cash book', () => {
  it('walks one account with a running balance', async () => {
    const account = await prisma.account.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, systemKey: 'SALES_REVENUE' },
    });
    const gl = await getGeneralLedger({ companyId: ctx.dubai.id, accountId: account.id });

    expect(gl.rows.length).toBeGreaterThan(0);
    expect(gl.closingBalanceUsd.toString()).toBe('-60000'); // credit balance
  });

  it('walks one bank account with a running balance', async () => {
    const aedBank = await getCashAccount(ctx.dubai.id, 'AED');
    const book = await getCashBook({ companyId: ctx.dubai.id, cashBankAccountId: aedBank.id });

    expect(book.rows).toHaveLength(2);
    expect(book.rows[0].moneyIn.toString()).toBe('73450');
    expect(book.rows[1].moneyOut.toString()).toBe('3672.5');
    expect(book.closingBalance.toString()).toBe('69777.5');
  });
});

describe('cash flow, journal and expenses', () => {
  it('groups cash movements by what caused them', async () => {
    const flow = await getCashFlow({ companyId: ctx.dubai.id, ...ALL_TIME });
    const receipts = flow.lines.find((l) => l.sourceType === 'RECEIPT');
    const expenses = flow.lines.find((l) => l.sourceType === 'EXPENSE');

    expect(receipts?.inUsd.toString()).toBe('20000');
    expect(expenses?.outUsd.toString()).toBe('1000');
    expect(flow.netMovementUsd.toString()).toBe('19000');
  });

  it('lists posted journal entries with their lines', async () => {
    const entries = await getJournalReport({ companyId: ctx.dubai.id });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const debits = entry.lines.reduce((a, l) => a.plus(dec(l.debitUsd)), dec(0));
      const credits = entry.lines.reduce((a, l) => a.plus(dec(l.creditUsd)), dec(0));
      expect(debits.toString()).toBe(credits.toString());
    }
  });

  it('groups expenses by category and by month', async () => {
    const byCategory = await getExpenseReport({ companyId: ctx.dubai.id, groupBy: 'category' });
    // The brief splits bank charges in two: one attributable to a shipment,
    // one an overhead. This seed uses the overhead.
    expect(byCategory.find((r) => r.label === 'General Bank Charges')?.amountUsd.toString()).toBe('1000');

    const byMonth = await getExpenseReport({ companyId: ctx.dubai.id, groupBy: 'month' });
    expect(byMonth.find((r) => r.label === '2026-02')?.amountUsd.toString()).toBe('1000');
  });
});

describe('dashboard', () => {
  it('assembles without error and agrees with the reports', async () => {
    const data = await getDashboard({ companyId: ctx.dubai.id });

    expect(data.position.receivableUsd.toString()).toBe('40000');
    expect(data.profit.revenueUsd.toString()).toBe('60000');
    expect(data.profit.netProfitUsd.toString()).toBe('13500');
    expect(data.warehouseStock.length).toBeGreaterThan(0);
    expect(data.monthly).toHaveLength(12);
    expect(data.receivables.ageing).toHaveLength(5);
  });
});

describe('the ledger agrees with the operational reports', () => {
  it('matches cost of sales in the general ledger to the profitability figures', async () => {
    const tb = await transaction((tx) => getTrialBalance(tx, ctx.dubai.id));
    const cogs = tb.find((r) => r.code === '5000');
    const glCogs = dec(cogs?.debitUsd ?? 0).minus(dec(cogs?.creditUsd ?? 0));

    const invoice = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(glCogs.toString()).toBe(dec(invoice.costOfGoodsUsd).toString());
  });
});
