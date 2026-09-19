import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, utcDate, transaction } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createPayment, postPayment } from '@/lib/services/payment';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createAgentSettlement, postAgentSettlement, getAgentPositions } from '@/lib/services/agent-ledger';
import { postCashBankTransfer } from '@/lib/services/cash-transfer';
import { markShipmentLoaded, changeShipmentStatus } from '@/lib/services/shipment';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getCashBook, getTrialBalanceReport, getBalanceSheet } from '@/lib/services/reports';
import { getCashBankBalance, getCustomerBalance, getVendorBalance } from '@/lib/services/accounting';
import { reconcile } from '@/lib/services/reconciliation';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { dec, sum, toMoney } from '@/lib/money';

/**
 * The whole Morocco trade, one step at a time, reconciled after every step.
 *
 * The client's complaint was not any single bug but that new ones kept
 * appearing: a figure would be right on one screen and wrong on another, and
 * each fix uncovered the next. A test that reconciles only at the end cannot
 * tell you which step broke it. This one asserts the invariants after every
 * posting, so the step that breaks them is the step that is named.
 *
 * Money in this scenario: coffee bought in USD, sold in MAD, local costs in
 * MAD, commission owed in USD, and a rate that moves between raising an
 * invoice and being paid for it.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let vendorId: string;
let customerId: string;
let agentId: string;
let itemId: string;
let warehouseId: string;
let shippingLineId: string;
let cashId: string;
let bankId: string;
let usdBankId: string;
let contractId: string;
let shipmentId: string;
let batchId: string;

/** Every invariant, after every step. Named so a failure says which step. */
async function checkpoint(step: string) {
  const result = await reconcile(companyId);
  const failed = result.checks.filter((c) => !c.passed).map((c) => `${c.label} (${c.left.value} vs ${c.right.value})`);
  expect(failed, `after ${step}`).toEqual([]);

  const trial = await getTrialBalanceReport({ companyId });
  expect(trial.isBalanced, `trial balance after ${step}`).toBe(true);

  const sheet = await getBalanceSheet({ companyId, asOf: new Date() });
  expect(dec(sheet.differenceUsd).abs().lessThanOrEqualTo('0.05'), `balance sheet after ${step}`).toBe(true);
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;

  vendorId = (
    await prisma.vendor.create({
      data: { companyId, vendorCode: 'E2E-SUP', vendorName: 'Ideal Commodities Uganda', country: 'Uganda', primaryCurrency: 'USD' },
    })
  ).id;
  customerId = (
    await prisma.customer.create({
      data: { companyId, customerCode: 'E2E-CUS', customerName: 'Casablanca Roasters', country: 'Morocco', primaryCurrency: 'MAD' },
    })
  ).id;
  agentId = (
    await prisma.agent.create({ data: { companyId, agentCode: 'E2E-AG', agentName: 'Radouan', commissionPct: '1' } })
  ).id;
  itemId = (
    await prisma.coffeeItem.create({
      data: {
        companyId, itemCode: 'E2E-ITM', itemName: 'Uganda Robusta Screen 18', coffeeType: 'ROBUSTA',
        originCountry: 'Uganda', grade: 'S18', process: 'NATURAL', cropYear: '2025/26', bagWeightKg: '60', defaultUnit: 'KG',
      },
    })
  ).id;
  shippingLineId = (await prisma.shippingLine.create({ data: { companyId, code: 'E2E-SL', name: 'Maersk' } })).id;
  warehouseId = (
    await prisma.warehouse.findFirstOrThrow({ where: { companyId, status: 'ACTIVE' }, orderBy: { code: 'asc' } })
  ).id;
  cashId = (
    await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'MAD', accountType: 'CASH' } })
  ).id;
  bankId = (
    await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'MAD', accountType: 'BANK' } })
  ).id;
  usdBankId = (
    await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'USD', accountType: 'BANK' } })
  ).id;
});

describe('the Morocco trade, reconciled at every step', () => {
  it('1–5 buys 40,000 KG in USD and puts it on the loading sheet', async () => {
    const contract = await createPurchaseContract(
      {
        companyId, contractDate: utcDate('2026-07-01'), vendorId,
        currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.85', freightAmount: '0', containers: 2,
        lines: [
          { itemId, quantity: '21000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'L-12', batchNumber: 'B-12' },
          { itemId, quantity: '19000', unit: 'KG', unitPrice: '4.10', bagWeightKg: '60', lotNumber: 'L-15', batchNumber: 'B-15' },
        ],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
    contractId = contract.id;
    shipmentId = (await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;

    // Bought in USD from a Ugandan exporter: no Moroccan TVA on the payable.
    const payable = await transaction((tx) => getVendorBalance(tx, companyId, vendorId));
    expect(payable.toFixed(2)).toBe('161900.00');
    await checkpoint('purchase order');
  });

  it('6–9 loads, sails and arrives as one consignment of two containers', async () => {
    await markShipmentLoaded(
      {
        companyId, shipmentId, loadingDate: utcDate('2026-07-10'), shippingLineId,
        etaDate: utcDate('2026-08-05'), containerNumbers: ['MSKU1000001', 'MSKU1000002'],
        bookingNumber: 'BK-001', portOfLoading: 'Mombasa', portOfDischarge: 'Casablanca',
      },
      ctx.admin.id,
    );
    const loaded = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    expect(loaded.status).toBe('LOADED');
    expect(loaded.containers).toBe(2);

    await changeShipmentStatus({
      companyId, shipmentId, userId: ctx.admin.id, toStatus: 'ARRIVED', ataDate: utcDate('2026-08-06'),
    });
    await checkpoint('loaded and arrived');
  });

  it('10–11 receives both containers into the warehouse', async () => {
    const batches = await prisma.batch.findMany({ where: { purchaseContractId: contractId }, orderBy: { batchNumber: 'asc' } });
    const receipt = await createGoodsReceipt(
      {
        companyId, purchaseContractId: contractId, warehouseId,
        receiptDate: utcDate('2026-08-07'), receivedById: ctx.admin.id,
        lines: batches.map((b) => ({ batchId: b.id, quantityKg: b.orderedQuantityKg.toString(), bags: b.orderedBags })),
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });
    batchId = batches[0].id;

    const onHand = await prisma.inventoryBalance.findMany({ where: { companyId, warehouseId } });
    expect(onHand.reduce((t, b) => t.plus(b.onHandKg), dec(0)).toFixed(0)).toBe('40000');
    await checkpoint('goods receipt');
  });

  it('12–14 pays a MAD 7,400 local cost in cash: 7,400 everywhere, never 8,880', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT', capitaliseByDefault: true },
      orderBy: { code: 'asc' },
    });
    const cashBefore = await transaction((tx) => getCashBankBalance(tx, companyId, cashId));

    const expense = await createExpense(
      {
        companyId, expenseDate: utcDate('2026-08-08'), expenseCategoryId: category.id, shipmentId,
        currency: 'MAD', amount: '7400', rateToUsd: '9.60', rateLocalPerUsd: '9.60',
        cashBankAccountId: cashId, paymentMethod: 'CASH', kind: 'SHIPMENT', description: 'Freight fees in Morocco, local',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    // No tax code named: the amount typed is the amount that left cash.
    const stored = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(stored.amount.toFixed(2)).toBe('7400.00');
    expect(stored.taxAmount.toFixed(2)).toBe('0.00');

    const cashAfter = await transaction((tx) => getCashBankBalance(tx, companyId, cashId));
    expect(cashBefore.minus(cashAfter).toFixed(2)).toBe('7400.00');

    const book = await getCashBook({ companyId, cashBankAccountId: cashId });
    expect(Number(book.rows.find((r) => r.sourceId === expense.id)?.moneyOut)).toBeCloseTo(7400, 2);

    // The cost was booked against one shipment and shared across the order;
    // it is listed on the sheet of the shipment it was filed under.
    const sheet = await getShipmentCostSheet(companyId, shipmentId);
    expect(Number(sheet.lines.find((l) => l.expenseId === expense.id)?.amount)).toBe(7400);
    await checkpoint('cash expense');
  });

  it('15–16 accrues USD 1,000 of commission to the agent without moving cash', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT' },
      orderBy: { code: 'asc' },
    });
    const cashBefore = await transaction((tx) => getCashBankBalance(tx, companyId, cashId));

    const expense = await createExpense(
      {
        companyId, expenseDate: utcDate('2026-08-09'), expenseCategoryId: category.id, shipmentId,
        payableToAgentId: agentId, currency: 'USD', amount: '1000', rateToUsd: '1', rateLocalPerUsd: '9.85',
        kind: 'SHIPMENT', description: 'Agent commission, payable later',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    expect((await transaction((tx) => getCashBankBalance(tx, companyId, cashId))).toFixed(2)).toBe(cashBefore.toFixed(2));
    const position = (await getAgentPositions(companyId)).find((p) => p.agentId === agentId)!;
    expect(Number(position.commissionPayableUsd)).toBeCloseTo(1000, 2);
    await checkpoint('agent commission accrued');
  });

  it('17–20 sells 12,000 KG in MAD with no tax by default', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate('2026-08-12'), customerId,
        currency: 'MAD', rateToUsd: '9.85', rateLocalPerUsd: '9.85',
        lines: [{ batchId, warehouseId, quantity: '12000', unit: 'KG', unitPrice: '60' }],
      },
      ctx.admin.id,
    );
    // TVA defaults to 0: a rate is chosen, never assumed.
    expect(invoice.taxAmount.toFixed(2)).toBe('0.00');
    expect(invoice.totalAmount.toFixed(2)).toBe('720000.00');
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

    const stock = await prisma.inventoryBalance.findMany({ where: { companyId, warehouseId } });
    expect(stock.reduce((t, b) => t.plus(b.onHandKg), dec(0)).toFixed(0)).toBe('28000');

    const owed = await transaction((tx) => getCustomerBalance(tx, companyId, customerId));
    expect(owed.toFixed(2)).toBe('720000.00');
    await checkpoint('sales invoice');
  });

  it('21–22 takes a partial payment at a rate that has moved, and the ledger stays exact', async () => {
    const invoice = await prisma.salesInvoice.findFirstOrThrow({ where: { companyId, status: 'POSTED' } });
    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-08-20'), customerId,
        currency: 'MAD', amount: '300000', rateToUsd: '9.60', rateLocalPerUsd: '9.60',
        paymentMethod: 'CASH', cashBankAccountId: cashId,
        allocations: [{ salesInvoiceId: invoice.id, amount: '300000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    // MAD 720,000 less MAD 300,000, to the dirham — no residue from the rate.
    const owed = await transaction((tx) => getCustomerBalance(tx, companyId, customerId));
    expect(owed.toFixed(2)).toBe('420000.00');
    await checkpoint('partial customer payment');
  });

  it('23–24 records a collection by the agent: the customer is settled, cash is not touched', async () => {
    const invoice = await prisma.salesInvoice.findFirstOrThrow({ where: { companyId, status: 'POSTED' } });
    const cashBefore = await transaction((tx) => getCashBankBalance(tx, companyId, cashId));

    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-08-22'), customerId,
        currency: 'MAD', amount: '120000', rateToUsd: '9.85', rateLocalPerUsd: '9.85',
        paymentMethod: 'AGENT_COLLECTION', agentId,
        allocations: [{ salesInvoiceId: invoice.id, amount: '120000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    expect((await transaction((tx) => getCashBankBalance(tx, companyId, cashId))).toFixed(2)).toBe(cashBefore.toFixed(2));
    expect((await transaction((tx) => getCustomerBalance(tx, companyId, customerId))).toFixed(2)).toBe('300000.00');
    const position = (await getAgentPositions(companyId)).find((p) => p.agentId === agentId)!;
    expect(Number(position.holdingUsd)).toBeCloseTo(120000 / 9.85, 2);
    await checkpoint('agent collection');
  });

  it('the agent hands the money over, and the clearing balance goes', async () => {
    const cashBefore = await transaction((tx) => getCashBankBalance(tx, companyId, cashId));
    const settlement = await createAgentSettlement(
      {
        companyId, agentId, settlementDate: utcDate('2026-08-25'), direction: 'COLLECTION',
        cashBankAccountId: cashId, currency: 'MAD', amount: '120000', rateToUsd: '9.85', rateLocalPerUsd: '9.85',
      },
      ctx.admin.id,
    );
    await postAgentSettlement({ id: settlement.id, companyId, userId: ctx.admin.id });

    const cashAfter = await transaction((tx) => getCashBankBalance(tx, companyId, cashId));
    expect(cashAfter.minus(cashBefore).toFixed(2)).toBe('120000.00');
    const position = (await getAgentPositions(companyId)).find((p) => p.agentId === agentId)!;
    expect(Number(position.holdingUsd)).toBeCloseTo(0, 2);
    await checkpoint('agent settlement');
  });

  it('25–27 posts a MAD journal and a USD journal without mixing them', async () => {
    const equity = await prisma.account.findFirstOrThrow({ where: { companyId, systemKey: 'OPENING_BALANCE_EQUITY' } });
    const ahmed = await prisma.account.create({
      data: { companyId, code: '1290', name: 'Ahmed — current account', type: 'ASSET', reportGroup: 'CURRENT_ASSET' },
    });

    await transaction(async (tx) => {
      const company = await getCompanyContext(tx, companyId);
      await postJournalEntry(tx, {
        companyId, entryDate: utcDate('2026-08-28'), description: 'Loan to Ahmed, MAD',
        sourceType: 'MANUAL', sourceId: 'JV-E2E-MAD', createdById: ctx.admin.id,
        localCurrency: company.localCurrency, rateLocalPerUsd: '9.85',
        lines: [
          { accountId: ahmed.id, direction: 'DEBIT', currency: 'MAD', amount: '50000', rateToUsd: '9.85' },
          { cashBankAccountId: cashId, direction: 'CREDIT', currency: 'MAD', amount: '50000', rateToUsd: '9.85' },
        ],
      });
      await postJournalEntry(tx, {
        companyId, entryDate: utcDate('2026-08-29'), description: 'Ahmed holds USD for us',
        sourceType: 'MANUAL', sourceId: 'JV-E2E-USD', createdById: ctx.admin.id,
        localCurrency: company.localCurrency, rateLocalPerUsd: '9.85',
        lines: [
          { accountId: ahmed.id, direction: 'DEBIT', currency: 'USD', amount: '2000', rateToUsd: '1' },
          { accountId: equity.id, direction: 'CREDIT', currency: 'USD', amount: '2000', rateToUsd: '1' },
        ],
      });
    });

    const { getGeneralLedger } = await import('@/lib/services/reports');
    const mad = await getGeneralLedger({ companyId, accountId: ahmed.id, currency: 'MAD' });
    expect(mad.rows.every((r) => r.currency === 'MAD')).toBe(true);
    expect(dec(mad.closingBalance).toFixed(2)).toBe('50000.00');
    const usd = await getGeneralLedger({ companyId, accountId: ahmed.id, currency: 'USD' });
    expect(usd.rows.every((r) => r.currency === 'USD')).toBe(true);
    expect(dec(usd.closingBalance).toFixed(2)).toBe('2000.00');
    await checkpoint('manual journals');
  });

  it('28–29 moves cash to the bank, and both books move', async () => {
    const cashBefore = await transaction((tx) => getCashBankBalance(tx, companyId, cashId));
    const bankBefore = await transaction((tx) => getCashBankBalance(tx, companyId, bankId));

    await postCashBankTransfer({
      companyId, userId: ctx.admin.id, transferDate: utcDate('2026-08-30'),
      fromAccountId: cashId, toAccountId: bankId, amount: '200000',
    });

    expect(cashBefore.minus(await transaction((tx) => getCashBankBalance(tx, companyId, cashId))).toFixed(2)).toBe('200000.00');
    expect((await transaction((tx) => getCashBankBalance(tx, companyId, bankId))).minus(bankBefore).toFixed(2)).toBe('200000.00');
    await checkpoint('cash to bank');
  });

  it('pays the USD supplier from a USD bank and clears the payable exactly', async () => {
    const payment = await createPayment(
      {
        companyId, paymentDate: utcDate('2026-09-01'), vendorId,
        currency: 'USD', amount: '50000', rateToUsd: '1', rateLocalPerUsd: '9.85',
        paymentMethod: 'BANK_TRANSFER', cashBankAccountId: usdBankId,
        allocations: [{ purchaseContractId: contractId, amount: '50000' }],
      },
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });

    const owed = await transaction((tx) => getVendorBalance(tx, companyId, vendorId));
    expect(owed.toFixed(2)).toBe('111900.00');
    await checkpoint('supplier payment');
  });

  it('30–33 reports the same figures the ledger holds', async () => {
    // Two lines, two shipments, one order: the order's costing is the two
    // sheets added together. USD 161,900 of coffee, MAD 7,400 of local cost
    // and USD 1,000 of commission — the shared costs counted once between
    // them, never once each.
    const shipments = await prisma.shipment.findMany({ where: { purchaseContractId: contractId }, select: { id: true } });
    const sheets = await Promise.all(shipments.map((sh) => getShipmentCostSheet(companyId, sh.id)));
    const goodsUsd = Number(sum(sheets.map((x) => x.goodsUsd)));
    const capitalisedUsd = Number(sum(sheets.map((x) => x.capitalisedUsd)));
    const totalUsd = Number(sum(sheets.map((x) => x.totalShipmentCostUsd)));
    const totalLocal = Number(sum(sheets.map((x) => x.totalShipmentCostLocal)));
    const receivedKg = Number(sum(sheets.map((x) => x.receivedKg)));
    expect(goodsUsd).toBeCloseTo(161_900, 2);
    expect(capitalisedUsd).toBeCloseTo(7400 / 9.6 + 1000, 2);
    expect(totalUsd).toBeCloseTo(161_900 + 7400 / 9.6 + 1000, 2);
    expect(receivedKg).toBe(40_000);
    // Per kilo across the order, and the same figure in dirhams.
    expect(totalUsd / receivedKg).toBeCloseTo(totalUsd / 40_000, 6);
    expect(totalLocal / receivedKg).toBeCloseTo(totalLocal / 40_000, 6);

    const book = await getCashBook({ companyId, cashBankAccountId: cashId });
    const ledgerCash = await transaction((tx) => getCashBankBalance(tx, companyId, cashId));
    expect(toMoney(book.closingBalance).toFixed(2)).toBe(ledgerCash.toFixed(2));

    await checkpoint('reports');
  });

  it('34–36 reverses the supplier payment on request only, and the books still balance', async () => {
    const payment = await prisma.payment.findFirstOrThrow({ where: { companyId, status: 'POSTED' } });
    const owedBefore = await transaction((tx) => getVendorBalance(tx, companyId, vendorId));

    const { reversePayment } = await import('@/lib/services/payment');
    await reversePayment({ id: payment.id, companyId, userId: ctx.admin.id, reason: 'Paid the wrong supplier' });

    const reversed = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reversed.status).toBe('REVERSED');
    expect(reversed.reversalReason).toBe('Paid the wrong supplier');

    const owedAfter = await transaction((tx) => getVendorBalance(tx, companyId, vendorId));
    expect(owedAfter.minus(owedBefore).toFixed(2)).toBe('50000.00');

    // Both entries stay in the books: the original and the contra.
    const entries = await prisma.journalEntry.findMany({ where: { companyId, sourceType: 'PAYMENT', sourceId: payment.id } });
    expect(entries).toHaveLength(2);
    await checkpoint('payment reversal');
  });

  it('nothing reversed itself along the way', async () => {
    const invoices = await prisma.salesInvoice.findMany({ where: { companyId } });
    expect(invoices.filter((i) => i.status === 'REVERSED')).toHaveLength(0);
    const receipts = await prisma.receipt.findMany({ where: { companyId } });
    expect(receipts.filter((r) => r.status === 'REVERSED')).toHaveLength(0);
    const expenses = await prisma.expense.findMany({ where: { companyId } });
    expect(expenses.filter((e) => e.status === 'REVERSED')).toHaveLength(0);
  });
});
