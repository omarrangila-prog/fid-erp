import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, transaction, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract, getReceiptStatus } from '@/lib/services/purchase';
import { markOrderArrived } from '@/lib/services/shipment';
import { receiveContainers } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createExpense, postExpense } from '@/lib/services/expense';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import {
  getShipmentProfitability,
  getShipmentExpensesByCategory,
  getCompanyProfitSummary,
} from '@/lib/services/profitability';
import {
  getProfitAndLoss,
  getTrialBalanceReport,
  getBalanceSheet,
  getFinancialPosition,
  getSalesBy,
  getCustomerBalances,
  getVendorBalances,
  getGeneralLedgerByAccount,
} from '@/lib/services/reports';
import { getReceivables, getPayables, getReceivablesAgeing, getPayablesAgeing } from '@/lib/services/receivables';
import { getInventoryValuation, getInventoryValuationSummary, getStockMovementSummary } from '@/lib/services/stock';
import { getAllocatableOverheads, getOverheadCandidates, allocateOverheads } from '@/lib/services/overhead-allocation';
import { reconcile } from '@/lib/services/reconciliation';
import { dec, sum } from '@/lib/money';

/**
 * The client's compliance checklist, run against the books rather than read
 * off the screens. One Morocco trade is built — order, arrival, receipt into
 * two warehouses, a sale, direct costs in three categories, a general
 * overhead — and then every reconciliation the checklist names is checked,
 * followed by the postings it says must be refused.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let contractId: string;
let batchIds: string[] = [];

const FROM = utcDate('2026-06-01');
const TO = utcDate('2026-06-30');
const ALL_FROM = utcDate('2020-01-01');
const ALL_TO = utcDate('2030-12-31');

/** The direct-cost categories the requirements list, as far as the seeded chart carries them. */
const DIRECT_COSTS = [
  'Freight', 'Insurance', 'Customs', 'Import', 'Port', 'Clearing', 'Transport', 'Handling',
  'Inspection', 'Fumigation', 'Documentation', 'Demurrage', 'Detention', 'Warehouse', 'Other Direct',
];

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  const contract = await createPurchaseContract(
    {
      companyId,
      vendorId: masters.vendor.id,
      contractDate: utcDate('2026-06-01'),
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '10',
      freightAmount: '0',
      contractReference: 'ICUL/FID/PDF',
      containers: 2,
      lines: [
        { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'PDF-1' },
        { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'PDF-2' },
      ],
    },
    ctx.admin.id,
  );
  contractId = contract.id;
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  await markOrderArrived({ companyId, contractId: contract.id, userId: ctx.admin.id, ataDate: utcDate('2026-06-05') });

  // Each container into its own warehouse — lot and warehouse traceability.
  const status = await transaction((tx) => getReceiptStatus(tx, contract.id));
  await receiveContainers({
    companyId,
    purchaseContractId: contract.id,
    receiptDate: utcDate('2026-06-06'),
    receivedById: ctx.admin.id,
    lines: status.map((row, index) => ({
      batchId: row.batchId,
      quantityKg: '20000',
      warehouseId: masters.warehouses[Math.min(index, masters.warehouses.length - 1)].id,
      lotNumber: `LOT/PDF/${index + 1}`,
    })),
  });
  batchIds = status.map((row) => row.batchId);

  // Direct costs in several categories, capitalised into landed cost.
  const cash = await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'MAD', accountType: 'CASH' } });
  const shipments = await prisma.shipment.findMany({ where: { purchaseContractId: contract.id }, select: { id: true } });
  const categories = await prisma.expenseCategory.findMany({
    where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT' },
    orderBy: { code: 'asc' },
    select: { id: true, name: true, capitaliseByDefault: true },
  });
  const capitalising = categories.filter((c) => c.capitaliseByDefault).slice(0, 3);
  expect(capitalising.length).toBeGreaterThan(0);
  for (const shipment of shipments) {
    for (const category of capitalising) {
      const expense = await createExpense(
        {
          companyId,
          expenseDate: utcDate('2026-06-07'),
          expenseCategoryId: category.id,
          shipmentId: shipment.id,
          currency: 'MAD',
          amount: '3000',
          rateToUsd: '10',
          rateLocalPerUsd: '10',
          paymentMethod: 'CASH',
          cashBankAccountId: cash.id,
          kind: 'SHIPMENT',
          capitaliseToLandedCost: true,
          description: `${category.name} on arrival`,
        },
        ctx.admin.id,
      );
      await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
    }
  }

  // A company overhead with no shipment.
  const general = await prisma.expenseCategory.findFirstOrThrow({
    where: { companyId, status: 'ACTIVE', kind: 'GENERAL' },
    orderBy: { code: 'asc' },
  });
  const rent = await createExpense(
    {
      companyId,
      expenseDate: utcDate('2026-06-10'),
      expenseCategoryId: general.id,
      currency: 'MAD',
      amount: '20000',
      rateToUsd: '10',
      rateLocalPerUsd: '10',
      paymentMethod: 'CASH',
      cashBankAccountId: cash.id,
      kind: 'GENERAL',
      description: 'Office rent for June',
    },
    ctx.admin.id,
  );
  await postExpense({ id: rent.id, companyId, userId: ctx.admin.id });

  // A sale in dirhams out of the first container.
  const invoice = await createSalesInvoice(
    {
      companyId,
      invoiceDate: utcDate('2026-06-15'),
      customerId: masters.customer.id,
      currency: 'MAD',
      rateToUsd: '10',
      rateLocalPerUsd: '10',
      lines: [
        {
          batchId: batchIds[0],
          warehouseId: masters.warehouses[0].id,
          quantity: '8000',
          unit: 'KG' as const,
          unitPrice: '65.00',
        },
      ],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
}, 600_000);

describe('§12 — the reconciliations the checklist requires', () => {
  it('12.1 total debit equals total credit, and 12.2 assets equal liabilities plus equity', async () => {
    const [tb, bs] = await Promise.all([getTrialBalanceReport({ companyId }), getBalanceSheet({ companyId, asOf: ALL_TO })]);
    expect(tb.isBalanced).toBe(true);
    expect(Number(tb.totals.debitUsd)).toBeCloseTo(Number(tb.totals.creditUsd), 2);
    expect(Number(tb.differenceUsd ?? 0)).toBeCloseTo(0, 2);
    expect(bs.balancesUsd).toBe(true);
    expect(Number(bs.assets.totalUsd)).toBeCloseTo(Number(bs.liabilities.totalUsd.plus(bs.equity.totalUsd)), 2);
  }, 300_000);

  it('12.3/12.4 receivables and payables equal the party ledgers and the ageing', async () => {
    const [customers, receivables, ageing, vendors, payables, payAgeing] = await Promise.all([
      getCustomerBalances(companyId),
      getReceivables({ companyId, onlyOutstanding: true }),
      getReceivablesAgeing(companyId),
      getVendorBalances(companyId),
      getPayables({ companyId, onlyOutstanding: true }),
      getPayablesAgeing(companyId),
    ]);
    const receivableTotal = sum(receivables.map((r) => r.outstandingAmountUsd));
    expect(Number(sum(customers.map((c) => c.balanceUsd)))).toBeCloseTo(Number(receivableTotal), 2);
    expect(Number(sum(ageing.map((r) => r.totalUsd)))).toBeCloseTo(Number(receivableTotal), 2);
    const payableTotal = sum(payables.map((p) => p.outstandingAmountUsd));
    expect(Number(sum(vendors.map((v) => v.balanceUsd)))).toBeCloseTo(Number(payableTotal), 2);
    expect(Number(sum(payAgeing.map((r) => r.totalUsd)))).toBeCloseTo(Number(payableTotal), 2);
    // And the control accounts agree, which is what the reconciliation screen checks.
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);

  it('12.5/12.6 every cash and bank summary equals its ledger account', async () => {
    const position = await getFinancialPosition({ companyId });
    expect(position.accounts.length).toBeGreaterThan(0);
    for (const account of position.accounts) {
      const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
        SELECT COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS bal
        FROM journal_lines jl
        JOIN journal_entries je ON je."id" = jl."journalEntryId"
        WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND jl."accountId" = ${account.glAccountId}`;
      const opening = await prisma.cashBankAccount.findUniqueOrThrow({
        where: { id: account.accountId },
        select: { openingBalance: true },
      });
      expect(Number(account.balance)).toBeCloseTo(Number(dec(rows[0].bal).plus(opening.openingBalance)), 2);
    }
  }, 300_000);

  it('12.7/12.8 inventory quantity and value agree with the movements and the ledger', async () => {
    const [valuation, summary, movement, sheet] = await Promise.all([
      getInventoryValuation(companyId),
      getInventoryValuationSummary(companyId),
      getStockMovementSummary({ companyId, from: ALL_FROM, to: ALL_TO }),
      getBalanceSheet({ companyId, asOf: ALL_TO }),
    ]);
    const onHand = sum(valuation.map((v) => v.onHandKg));
    expect(Number(onHand)).toBeCloseTo(32_000, 3);
    expect(Number(sum(movement.map((m) => m.closingKg)))).toBeCloseTo(Number(onHand), 3);
    expect(Number(sum(summary.map((s) => s.onHandKg)))).toBeCloseTo(Number(onHand), 3);

    const inventoryLine = sheet.assets.lines.find((l) => /inventory|stock/i.test(l.name))!;
    expect(Number(sum(valuation.map((v) => v.valueUsd)))).toBeCloseTo(Number(inventoryLine.amountUsd), 2);
  }, 300_000);

  it('12.9 shipment direct expense totals agree with the expenses behind them, by category', async () => {
    const [rows, byCategory] = await Promise.all([
      getShipmentProfitability({ companyId }),
      getShipmentExpensesByCategory({ companyId }),
    ]);
    for (const row of rows) {
      const categories = byCategory.get(row.shipmentId) ?? [];
      const capitalised = sum(categories.filter((c) => c.capitalised).map((c) => c.amountUsd));
      const period = sum(categories.filter((c) => !c.capitalised).map((c) => c.amountUsd));
      expect(Number(row.capitalisedCostUsd)).toBeCloseTo(Number(capitalised), 2);
      expect(Number(row.otherCostsUsd)).toBeCloseTo(Number(period), 2);
      // Three categories on each shipment, MAD 3,000 each = USD 300 each.
      expect(categories.filter((c) => c.capitalised)).toHaveLength(3);
    }
    const posted = await prisma.expense.aggregate({
      where: { companyId, status: 'POSTED', shipmentId: { not: null }, capitaliseToLandedCost: true },
      _sum: { amountUsd: true },
    });
    expect(Number(sum(rows.map((r) => r.capitalisedCostUsd)))).toBeCloseTo(Number(posted._sum.amountUsd ?? 0), 2);
  }, 300_000);

  it('12.10 the general expense report equals the overhead ledger and stays off the shipments', async () => {
    const overheads = await getAllocatableOverheads({ companyId, from: FROM, to: TO });
    const posted = await prisma.expense.aggregate({
      where: { companyId, status: 'POSTED', kind: 'GENERAL', expenseDate: { gte: FROM, lte: TO } },
      _sum: { amountUsd: true },
    });
    expect(Number(overheads.totalUsd)).toBeCloseTo(Number(posted._sum.amountUsd ?? 0), 2);
    expect(Number(overheads.totalUsd)).toBeCloseTo(2000, 2);

    const rows = await getShipmentProfitability({ companyId });
    for (const row of rows) expect(Number(row.allocatedOverheadUsd)).toBe(0);
  }, 300_000);

  it('12.11/12.12/12.13 purchased, sold and remaining quantities agree with their source records', async () => {
    const rows = await getShipmentProfitability({ companyId });
    const batches = await prisma.batch.findMany({ where: { purchaseContractId: contractId } });
    expect(Number(sum(rows.map((r) => r.purchaseQuantityKg)))).toBeCloseTo(Number(sum(batches.map((b) => dec(b.orderedQuantityKg)))), 3);
    expect(Number(sum(rows.map((r) => r.receivedQuantityKg)))).toBeCloseTo(Number(sum(batches.map((b) => dec(b.receivedQuantityKg)))), 3);

    const invoiced = await prisma.salesInvoiceLine.aggregate({
      where: { salesInvoice: { companyId, status: 'POSTED' } },
      _sum: { quantityKg: true },
    });
    expect(Number(sum(rows.map((r) => r.soldQuantityKg)))).toBeCloseTo(Number(invoiced._sum.quantityKg ?? 0), 3);

    // Remaining on hand is the stock actually in the warehouses.
    const balances = await prisma.inventoryBalance.aggregate({ where: { companyId }, _sum: { onHandKg: true } });
    expect(Number(sum(rows.map((r) => r.onHandQuantityKg)))).toBeCloseTo(Number(balances._sum.onHandKg ?? 0), 3);
    // Received = sold + on hand.
    expect(Number(sum(rows.map((r) => r.receivedQuantityKg)))).toBeCloseTo(
      Number(sum(rows.map((r) => r.soldQuantityKg)).plus(sum(rows.map((r) => r.onHandQuantityKg)))),
      3,
    );
  }, 300_000);

  it('12.14/12.15 shipment results and the company statements are the same transactions', async () => {
    const [rows, pnl, company] = await Promise.all([
      getShipmentProfitability({ companyId }),
      getProfitAndLoss({ companyId, from: ALL_FROM, to: ALL_TO }),
      getCompanyProfitSummary({ companyId }),
    ]);
    expect(Number(sum(rows.map((r) => r.salesRevenueUsd)))).toBeCloseTo(Number(pnl.totals.revenueUsd), 2);
    expect(Number(sum(rows.map((r) => r.allocatedLandedCostUsd)))).toBeCloseTo(Number(pnl.totals.costOfSalesUsd), 2);
    expect(Number(company.revenueUsd)).toBeCloseTo(Number(pnl.totals.revenueUsd), 2);

    // The shipment view is not the company view: overheads are only on the latter.
    expect(Number(pnl.totals.operatingExpensesUsd)).toBeGreaterThan(0);
    expect(Number(sum(rows.map((r) => r.netProfitUsd)))).not.toBeCloseTo(Number(pnl.totals.netProfitUsd), 2);
  }, 300_000);

  it('2.34–2.47 the profitability report carries every field the requirements name', async () => {
    const rows = await getShipmentProfitability({ companyId });
    const sold = rows.find((r) => r.soldQuantityKg.greaterThan(0))!;
    expect(Number(sold.purchaseQuantityKg)).toBe(20_000);
    expect(Number(sold.goodsCostUsd)).toBeCloseTo(80_000, 2);
    expect(Number(sold.capitalisedCostUsd)).toBeCloseTo(900, 2);
    expect(Number(sold.totalLandedCostUsd)).toBeCloseTo(80_900, 2);
    expect(Number(sold.landedCostPerKgUsd)).toBeCloseTo(4.045, 3);
    expect(Number(sold.soldQuantityKg)).toBe(8000);
    expect(Number(sold.salesRevenueUsd)).toBeCloseTo(52_000, 2);
    expect(Number(sold.averageSellingPriceUsd)).toBeCloseTo(6.5, 3);
    expect(Number(sold.onHandQuantityKg)).toBe(12_000);
    expect(Number(sold.closingStockValueUsd)).toBeCloseTo(12_000 * 4.045, 1);
    expect(Number(sold.grossProfitUsd)).toBeCloseTo(52_000 - 8000 * 4.045, 1);
    expect(Number(sold.grossMarginPct)).toBeGreaterThan(0);
    // Local figures at the order's rate.
    expect(Number(sold.totalLandedCostLocal)).toBeCloseTo(809_000, 1);
    expect(Number(sold.averageSellingPriceLocal)).toBeCloseTo(65, 2);
  }, 300_000);

  it('12.16 no report invents a figure: an empty company reports nothing, not a sample', async () => {
    const empty = ctx.dubai.id;
    const [pnl, bs, tb, valuation, sales] = await Promise.all([
      getProfitAndLoss({ companyId: empty, from: ALL_FROM, to: ALL_TO }),
      getBalanceSheet({ companyId: empty, asOf: ALL_TO }),
      getTrialBalanceReport({ companyId: empty }),
      getInventoryValuation(empty),
      getSalesBy({ companyId: empty, from: ALL_FROM, to: ALL_TO, by: 'customer' }),
    ]);
    expect(Number(pnl.totals.revenueUsd)).toBe(0);
    expect(Number(bs.assets.totalUsd)).toBe(0);
    expect(tb.isBalanced).toBe(true);
    expect(valuation).toEqual([]);
    expect(sales).toEqual([]);
  }, 300_000);
});

describe('§3C — the optional overhead allocation, on all four bases', () => {
  it('shares the period overhead by weight, by sales value, by percentage and equally, without duplicating it', async () => {
    const candidates = await getOverheadCandidates({ companyId, from: FROM, to: TO });
    expect(candidates.length).toBe(2);
    const total = (await getAllocatableOverheads({ companyId, from: FROM, to: TO })).totalUsd;

    for (const basis of ['QUANTITY', 'SALES_VALUE', 'PERCENTAGE', 'EQUAL'] as const) {
      const allocation = await allocateOverheads({
        companyId,
        userId: ctx.admin.id,
        from: FROM,
        to: TO,
        basis,
        shipments:
          basis === 'PERCENTAGE'
            ? [{ shipmentId: candidates[0].shipmentId, percentage: '70' }, { shipmentId: candidates[1].shipmentId, percentage: '30' }]
            : basis === 'SALES_VALUE'
              ? candidates.filter((c) => c.salesUsd.greaterThan(0)).map((c) => ({ shipmentId: c.shipmentId }))
              : candidates.map((c) => ({ shipmentId: c.shipmentId })),
      });
      // 3.23: the shares add up to the expense, never more.
      expect(Number(sum(allocation.lines.map((l) => dec(l.amountUsd))))).toBeCloseTo(Number(total), 2);
      if (basis === 'PERCENTAGE') {
        expect(Number(allocation.lines.find((l) => l.shipmentId === candidates[0].shipmentId)!.amountUsd)).toBeCloseTo(1400, 2);
      }
      if (basis === 'EQUAL') {
        for (const line of allocation.lines) expect(Number(line.amountUsd)).toBeCloseTo(1000, 2);
      }
      // 3.24/3.26: one active view per period, the expense still posted and whole.
      const active = await prisma.overheadAllocation.count({ where: { companyId, status: 'ACTIVE' } });
      expect(active).toBe(1);
      const expense = await prisma.expense.findFirstOrThrow({ where: { companyId, kind: 'GENERAL' } });
      expect(expense.status).toBe('POSTED');
      expect(Number(expense.amountUsd)).toBe(2000);
    }

    // 3.3: the allocation never reaches landed cost or the ledger.
    const pnl = await getProfitAndLoss({ companyId, from: FROM, to: TO });
    expect(Number(pnl.totals.operatingExpensesUsd)).toBeCloseTo(2000, 2);
    const rows = await getShipmentProfitability({ companyId, from: FROM, to: TO });
    for (const row of rows) {
      expect(Number(row.capitalisedCostUsd)).toBeCloseTo(900, 2);
      expect(Number(row.profitAfterOverheadUsd)).toBeCloseTo(Number(row.netProfitUsd) - Number(row.allocatedOverheadUsd), 2);
    }
  }, 600_000);
});

describe('§13 — what the system must refuse', () => {
  it('13.1/13.2 an unbalanced journal is refused and leaves nothing behind', async () => {
    const accounts = await prisma.account.findMany({
      where: { companyId, status: 'ACTIVE', children: { none: {} } },
      take: 2,
      orderBy: { code: 'asc' },
    });
    const before = await prisma.journalEntry.count({ where: { companyId } });
    await expect(
      transaction(async (tx) => {
        const company = await getCompanyContext(tx, companyId);
        return postJournalEntry(tx, {
          companyId,
          entryDate: utcDate('2026-06-20'),
          description: 'Deliberately unbalanced',
          sourceType: 'MANUAL',
          sourceId: `JV-TEST-${Date.now()}`,
          createdById: ctx.admin.id,
          localCurrency: company.localCurrency,
          rateLocalPerUsd: '10',
          lines: [
            { accountId: accounts[0].id, direction: 'DEBIT', currency: 'MAD', amount: '1000', rateToUsd: '10' },
            { accountId: accounts[1].id, direction: 'CREDIT', currency: 'MAD', amount: '900', rateToUsd: '10' },
          ],
        });
      }),
    ).rejects.toThrow();
    expect(await prisma.journalEntry.count({ where: { companyId } })).toBe(before);
    expect(await prisma.journalEntry.count({ where: { companyId, description: 'Deliberately unbalanced' } })).toBe(0);
  }, 300_000);

  it('8.12–8.15 a journal entry keeps its date, its narration, its lines and its author', async () => {
    // Two expense heads, so no cash drawer's currency is involved.
    const accounts = await prisma.account.findMany({
      where: { companyId, status: 'ACTIVE', type: 'EXPENSE', children: { none: {} }, cashBankAccounts: { none: {} } },
      take: 2,
      orderBy: { code: 'asc' },
    });
    const entry = await transaction(async (tx) => {
      const company = await getCompanyContext(tx, companyId);
      return postJournalEntry(tx, {
        companyId,
        entryDate: utcDate('2026-06-28'),
        description: 'Accrue June warehouse rent',
        sourceType: 'MANUAL',
        sourceId: `JV-REF-${Date.now()}`,
        createdById: ctx.admin.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: '10',
        lines: [
          { accountId: accounts[0].id, direction: 'DEBIT', currency: 'MAD', amount: '1000', rateToUsd: '10', description: 'Rent for June' },
          { accountId: accounts[1].id, direction: 'CREDIT', currency: 'MAD', amount: '1000', rateToUsd: '10' },
        ],
      });
    });

    const saved = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: { lines: { orderBy: { lineNumber: 'asc' } }, createdBy: { select: { id: true } } },
    });
    expect(saved.entryDate.toISOString().slice(0, 10)).toBe('2026-06-28');
    expect(saved.description).toBe('Accrue June warehouse rent');
    expect(saved.createdBy.id).toBe(ctx.admin.id);
    // The entry's own reference, and the document it came from.
    expect(saved.entryNumber).toBeTruthy();
    expect(saved.sourceType).toBe('MANUAL');
    expect(saved.sourceId).toBeTruthy();
    expect(saved.lines[0].description).toBe('Rent for June');
    expect(Number(saved.lines[0].debit)).toBe(1000);
    expect(Number(saved.lines[1].credit)).toBe(1000);

    // And it reads back on the general ledger under that narration.
    const ledger = await getGeneralLedgerByAccount({ companyId, from: ALL_FROM, to: ALL_TO });
    const line = ledger.flatMap((group) => group.lines).find((l) => l.description === 'Rent for June');
    expect(line, 'the entry reaches the general ledger').toBeTruthy();
  }, 300_000);

  it('13.3 posting the same document twice does not post it twice', async () => {
    const invoice = await prisma.salesInvoice.findFirstOrThrow({ where: { companyId, status: 'POSTED' } });
    const before = await prisma.journalLine.count({ where: { journalEntry: { companyId } } });
    await expect(postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id })).rejects.toThrow();
    expect(await prisma.journalLine.count({ where: { journalEntry: { companyId } } })).toBe(before);
  }, 300_000);

  it('13.4/13.5/13.6 the original currency and amount survive a later rate change', async () => {
    const expense = await prisma.expense.findFirstOrThrow({ where: { companyId, kind: 'GENERAL' } });
    expect(expense.currency).toBe('MAD');
    expect(Number(expense.amount)).toBe(20_000);
    expect(Number(expense.amountUsd)).toBe(2000);

    // A new rate today, far from the one used in June.
    await prisma.exchangeRate.create({
      data: { companyId, quoteCurrency: 'MAD', rate: '12', effectiveDate: utcDate('2026-09-01') },
    });
    const after = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(Number(after.amount)).toBe(20_000);
    expect(Number(after.amountUsd)).toBe(2000);
    expect(after.currency).toBe('MAD');

    const invoice = await prisma.salesInvoice.findFirstOrThrow({ where: { companyId, status: 'POSTED' } });
    expect(invoice.currency).toBe('MAD');
    expect(Number(invoice.totalAmount)).toBeCloseTo(520_000, 2);
    expect(Number(invoice.rateToUsd)).toBe(10);
  }, 300_000);

  it('13.7/13.8 a general expense needs no shipment, and a shipment cost cannot be capitalised without one', async () => {
    const general = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, status: 'ACTIVE', kind: 'GENERAL' } });
    const cash = await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'MAD', accountType: 'CASH' } });
    const fuel = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-06-25'),
        expenseCategoryId: general.id,
        currency: 'MAD',
        amount: '500',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        paymentMethod: 'CASH',
        cashBankAccountId: cash.id,
        kind: 'GENERAL',
        description: 'Fuel',
      },
      ctx.admin.id,
    );
    expect(fuel.shipmentId).toBeNull();
    await postExpense({ id: fuel.id, companyId, userId: ctx.admin.id });

    const shipmentCategory = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT', capitaliseByDefault: true },
    });
    await expect(
      createExpense(
        {
          companyId,
          expenseDate: utcDate('2026-06-25'),
          expenseCategoryId: shipmentCategory.id,
          currency: 'MAD',
          amount: '500',
          rateToUsd: '10',
          rateLocalPerUsd: '10',
          paymentMethod: 'CASH',
          cashBankAccountId: cash.id,
          kind: 'SHIPMENT',
          capitaliseToLandedCost: true,
          description: 'Clearing with no shipment named',
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
  }, 300_000);
});

describe('§2 — one reference joins purchase, stock, sale, expense and profitability', () => {
  it('follows the order reference all the way through', async () => {
    const rows = await getShipmentProfitability({ companyId });
    for (const row of rows) expect(row.contractReference).toBe('ICUL/FID/PDF');

    const batches = await prisma.batch.findMany({
      where: { purchaseContractId: contractId },
      select: { id: true, shipmentId: true, lot: { select: { lotNumber: true } }, container: { select: { containerNumber: true } } },
    });
    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      expect(batch.shipmentId).toBeTruthy();
      expect(batch.container?.containerNumber).toMatch(/PDF-/);
      expect(batch.lot.lotNumber).toBeTruthy();
    }

    // Sale, stock and expense all reach the same shipment.
    const line = await prisma.salesInvoiceLine.findFirstOrThrow({ where: { batchId: batchIds[0] }, select: { batchId: true } });
    expect(line.batchId).toBe(batchIds[0]);
    const expenses = await prisma.expense.count({ where: { companyId, shipmentId: batches[0].shipmentId, status: 'POSTED' } });
    expect(expenses).toBe(3);
    const balances = await prisma.inventoryBalance.findMany({ where: { batchId: batchIds[0] }, select: { warehouseId: true, onHandKg: true } });
    expect(balances.length).toBeGreaterThan(0);
  }, 300_000);

  it('2.13–2.29 the chart carries the direct-cost categories the requirements list', async () => {
    const categories = await prisma.expenseCategory.findMany({ where: { companyId, kind: 'SHIPMENT' }, select: { name: true } });
    const names = categories.map((c) => c.name.toLowerCase());
    const missing = DIRECT_COSTS.filter((wanted) => !names.some((n) => n.includes(wanted.toLowerCase())));
    expect(missing, `missing direct-cost categories: ${missing.join(', ')}`).toEqual([]);
  }, 300_000);
});
