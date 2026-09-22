import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt, getInvoiceOutstanding } from '@/lib/services/receipt';
import { recordAgentHandover, offsetAgentBalances } from '@/lib/services/agent-ledger';
import { getAgentLedger, getAgentControlTotals } from '@/lib/services/agent-account';
import { createStockTransfer, approveStockTransfer, dispatchStockTransfer, receiveStockTransfer } from '@/lib/services/stock-transfer';
import { postLoan } from '@/lib/services/loan';
import { getBalanceSheet } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';
import { transaction } from '@/lib/db';
import { getCashBankBalance } from '@/lib/services/accounting';
import { dec } from '@/lib/money';

/**
 * One man, several accounts, and the rules that keep them apart.
 *
 * He collects customers' money for the company, he lends the company money
 * of his own, he keeps coffee in a warehouse in his name, and he buys coffee
 * for himself. Each of those is a different account, and the point of these
 * tests is that none of them quietly pays off another: the only way one
 * balance meets another is somebody asking for it, in words, on the page.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let agentId: string;
let hisCustomerId: string;
let cashId: string;
let batchId: string;
let firstInvoiceId: string;

const AS_OF = utcDate('2026-12-31');

async function cash() {
  return dec(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)));
}

async function ledger(tab?: Parameters<typeof getAgentLedger>[0]['tab']) {
  return getAgentLedger({ companyId, agentId, tab });
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.6', effectiveDate: utcDate('2026-01-01') },
  });
  cashId = (await getCashAccount(companyId, 'MAD')).id;

  agentId = (
    await prisma.agent.create({
      data: { companyId, agentCode: 'AGT-0001', agentName: 'RADOUAN MOHAMMED', commissionPct: '0' },
    })
  ).id;

  // The same man's customer record: this is the link that puts what he buys
  // for himself on his page, without touching what he collects for us.
  hisCustomerId = (
    await prisma.customer.create({
      data: {
        companyId,
        customerCode: 'CUS-RAD',
        customerName: 'RADOUAN MOHAMMED',
        primaryCurrency: 'MAD',
        paymentTermDays: 30,
        agentId,
      },
    })
  ).id;

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0', contractReference: 'ICUL/FID/010',
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
      lines: [{ batchId, quantityKg: '10000', lotNumber: 'LOT-RAD' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  // A customer's invoice, for the cheque he collects on the company's behalf.
  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-09-01'), customerId: masters.customer.id, currency: 'MAD',
      rateToUsd: '9.6', rateLocalPerUsd: '9.6',
      lines: [{ batchId, warehouseId: masters.warehouses[0].id, quantity: '1000', unit: 'KG' as const, unitPrice: '46.00' }],
    },
    ctx.admin.id,
  );
  firstInvoiceId = invoice.id;
  await postSalesInvoice({ id: firstInvoiceId, companyId, userId: ctx.admin.id });
}, 300_000);

// A ---------------------------------------------------------------------------

describe('A. he lends the company money', () => {
  it('is a liability in dirhams, not income, and reads as the company owing him', async () => {
    const before = await cash();
    await postLoan({
      companyId, userId: ctx.admin.id, loanDate: utcDate('2026-08-12'), direction: 'RECEIVED',
      agentId, cashBankAccountId: cashId, currency: 'MAD', amount: '27000',
      description: 'Loan received from RADOUAN MOHAMMED on 12 August',
    });

    expect(Number((await cash()).minus(before))).toBeCloseTo(27000, 2);

    const { rows, summary } = await ledger();
    const loan = rows.filter((r) => r.accountKind === 'Loan from agent');
    expect(loan).toHaveLength(1);
    expect(loan[0].currency).toBe('MAD');
    expect(Number(loan[0].credit)).toBeCloseTo(27000, 2);
    expect(loan[0].direction).toBe('FID owes him more');
    expect(Number(summary.loanFromAgentLocal)).toBeCloseTo(27000, 2);
    // Borrowing is not earning.
    expect(Number(summary.holdingLocal)).toBe(0);
  }, 300_000);
});

// B ---------------------------------------------------------------------------

describe('B. a customer pays cash, and he collects a cheque', () => {
  it('keeps the two apart: only what he holds is his to hand over', async () => {
    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, firstInvoiceId));
    const cashBefore = await cash();

    const collected = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-09-15'), customerId: masters.customer.id, currency: 'MAD',
        amount: outstanding.amount.toString(), rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        paymentMethod: 'AGENT_COLLECTION', agentId,
        description: 'Customer cheque collected by RADOUAN MOHAMMED',
        allocations: [{ salesInvoiceId: firstInvoiceId, amount: outstanding.amount.toString() }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: collected.id, companyId, userId: ctx.admin.id });

    // The customer has paid, the company's cash has not moved, he owes it.
    expect(Number((await transaction((tx) => getInvoiceOutstanding(tx, firstInvoiceId))).amount)).toBe(0);
    expect(Number((await cash()).minus(cashBefore))).toBe(0);

    const { summary } = await ledger();
    expect(Number(summary.holdingLocal)).toBeCloseTo(46000, 2);
    // The loan he made is untouched by a collection.
    expect(Number(summary.loanFromAgentLocal)).toBeCloseTo(27000, 2);
  }, 300_000);

  it('shows him owing the company and the company owing him, without netting either away', async () => {
    const { summary } = await ledger();
    expect(Number(summary.netLocal)).toBeCloseTo(19000, 2);

    // Both balances are still on the balance sheet, on their own sides.
    const sheet = await getBalanceSheet({ companyId, asOf: AS_OF });
    expect(sheet.assets.lines.some((l) => /agent clearing/i.test(l.name))).toBe(true);
    expect(sheet.liabilities.lines.some((l) => /loan from radouan/i.test(l.name))).toBe(true);
    expect(sheet.balancesUsd).toBe(true);
  }, 300_000);
});

// C ---------------------------------------------------------------------------

describe('C. he collects again before handing anything over', () => {
  it('adds up rather than replacing', async () => {
    const second = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate('2026-09-18'), customerId: masters.customer.id, currency: 'MAD',
        rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        lines: [{ batchId, warehouseId: masters.warehouses[0].id, quantity: '500', unit: 'KG' as const, unitPrice: '20.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: second.id, companyId, userId: ctx.admin.id });

    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-09-20'), customerId: masters.customer.id, currency: 'MAD',
        amount: '10000', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        paymentMethod: 'AGENT_COLLECTION', agentId,
        description: 'Second cheque collected by RADOUAN MOHAMMED',
        allocations: [{ salesInvoiceId: second.id, amount: '10000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const { summary, rows } = await ledger('CLEARING');
    expect(Number(summary.holdingLocal)).toBeCloseTo(56000, 2);
    // The clearing tab reads as the clearing account, and nothing else.
    expect(rows.every((r) => r.accountKind === 'Agent Clearing')).toBe(true);
    expect(Number(rows[rows.length - 1].balanceLocal)).toBeCloseTo(56000, 2);
  }, 300_000);
});

// D ---------------------------------------------------------------------------

describe('D. he hands over more than he collected', () => {
  it('refuses the excess rather than guessing what it is', async () => {
    await expect(
      recordAgentHandover({
        companyId, userId: ctx.admin.id, agentId, settlementDate: utcDate('2026-09-25'),
        cashBankAccountId: cashId, currency: 'MAD', amount: '200000',
        rateToUsd: '9.6', rateLocalPerUsd: '9.6', notes: 'He handed over 200,000',
      }),
    ).rejects.toThrow(/say what the extra mad 144,?000/i);

    // And nothing was written on the way to refusing.
    const { summary } = await ledger();
    expect(Number(summary.holdingLocal)).toBeCloseTo(56000, 2);
  }, 300_000);

  it('splits it once told: what he collected settles, the rest is his loan', async () => {
    const cashBefore = await cash();
    const result = await recordAgentHandover({
      companyId, userId: ctx.admin.id, agentId, settlementDate: utcDate('2026-09-25'),
      cashBankAccountId: cashId, currency: 'MAD', amount: '200000',
      rateToUsd: '9.6', rateLocalPerUsd: '9.6', excess: 'LOAN',
      notes: 'Handed over 200,000: 56,000 collected, 144,000 his own',
    });

    expect(Number(result.settled)).toBeCloseTo(56000, 2);
    expect(Number(result.lent)).toBeCloseTo(144000, 2);
    expect(Number((await cash()).minus(cashBefore))).toBeCloseTo(200000, 2);

    const { summary } = await ledger();
    // He is holding nothing now, and the company owes him the 27,000 and the
    // 144,000 — as a loan, because that is what it was told it was.
    expect(Number(summary.holdingLocal)).toBeCloseTo(0, 2);
    expect(Number(summary.loanFromAgentLocal)).toBeCloseTo(171000, 2);
    expect(Number(summary.netLocal)).toBeCloseTo(-171000, 2);
  }, 300_000);

  it('leaves the subledger explaining the control account exactly', async () => {
    const control = await getAgentControlTotals(companyId);
    const { summary } = await ledger();
    expect(control.clearingTaggedLocal.toString()).toBe(summary.holdingLocal.toString());
    expect(control.untaggedLocal.toString()).toBe('0');
  }, 300_000);
});

// E ---------------------------------------------------------------------------

describe('E. he buys coffee for himself', () => {
  it('is a trade receivable on his page, and not money he is holding', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate('2026-10-01'), customerId: hisCustomerId, currency: 'MAD',
        rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        lines: [{ batchId, warehouseId: masters.warehouses[0].id, quantity: '200', unit: 'KG' as const, unitPrice: '50.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

    const { summary, rows } = await ledger();
    expect(Number(summary.tradeReceivableLocal)).toBeCloseTo(10000, 2);
    // Still nothing in the clearing account: this is his own purchase.
    expect(Number(summary.holdingLocal)).toBeCloseTo(0, 2);

    const sale = rows.filter((r) => r.accountKind === 'Trade receivable');
    expect(sale).toHaveLength(1);
    expect(sale[0].direction).toBe('He owes FID more');

    const onlySales = await ledger('SALES');
    expect(onlySales.rows).toHaveLength(1);
    expect(Number(onlySales.rows[0].balanceLocal)).toBeCloseTo(10000, 2);
  }, 300_000);

  it('does not let his purchase pay off the loan the company owes him', async () => {
    const { summary } = await ledger();
    expect(Number(summary.loanFromAgentLocal)).toBeCloseTo(171000, 2);
    expect(Number(summary.tradeReceivableLocal)).toBeCloseTo(10000, 2);
    // The net is a reading of both, not an entry that moved either.
    expect(Number(summary.netLocal)).toBeCloseTo(-161000, 2);
  }, 300_000);
});

// F ---------------------------------------------------------------------------

describe('F. coffee moved into the warehouse in his name', () => {
  it('moves stock and touches none of his balances', async () => {
    const his = masters.warehouses[1];
    const before = await ledger();

    const transfer = await createStockTransfer(
      {
        companyId, transferDate: utcDate('2026-10-05'),
        fromWarehouseId: masters.warehouses[0].id, toWarehouseId: his.id,
        notes: 'To the warehouse in his name',
        lines: [{ batchId, quantityKg: '3000' }],
      },
      ctx.admin.id,
    );
    await approveStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });
    await dispatchStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });
    await receiveStockTransfer({ id: transfer.id, companyId, userId: ctx.admin.id });

    const stock = await prisma.inventoryBalance.findFirstOrThrow({ where: { companyId, warehouseId: his.id, batchId } });
    expect(Number(stock.onHandKg)).toBeCloseTo(3000, 2);

    const after = await ledger();
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.summary.netLocal.toString()).toBe(before.summary.netLocal.toString());
  }, 300_000);

  it('sells from his warehouse as the company’s own coffee', async () => {
    const his = masters.warehouses[1];
    const before = await ledger();

    const invoice = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate('2026-10-08'), customerId: masters.customer.id, currency: 'MAD',
        rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        lines: [{ batchId, warehouseId: his.id, quantity: '500', unit: 'KG' as const, unitPrice: '55.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

    // The stock left his warehouse; his ledger did not move, because the
    // coffee was never his.
    const stock = await prisma.inventoryBalance.findFirstOrThrow({ where: { companyId, warehouseId: his.id, batchId } });
    expect(Number(stock.onHandKg)).toBeCloseTo(2500, 2);

    const after = await ledger();
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.summary.netLocal.toString()).toBe(before.summary.netLocal.toString());
  }, 300_000);
});

// G ---------------------------------------------------------------------------

describe('G. setting one balance against the other', () => {
  it('never happens on its own', async () => {
    const { rows } = await ledger('JOURNAL');
    expect(rows.filter((r) => /settled against each other/i.test(r.memo ?? '')).length).toBe(0);
  }, 300_000);

  it('is refused when there is nothing on both sides to settle', async () => {
    // He is holding nothing at this point, so there is nothing to set off.
    await expect(
      offsetAgentBalances({
        companyId, userId: ctx.admin.id, agentId, date: utcDate('2026-10-10'),
        amount: '5000', reason: 'Trying it on',
      }),
    ).rejects.toThrow(/nothing to settle/i);
  }, 300_000);

  it('posts only what someone asked for, with the reason on both sides', async () => {
    // He collects again, so there is something on both sides.
    const invoice = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate('2026-10-11'), customerId: masters.customer.id, currency: 'MAD',
        rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        lines: [{ batchId, warehouseId: masters.warehouses[0].id, quantity: '400', unit: 'KG' as const, unitPrice: '50.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-10-12'), customerId: masters.customer.id, currency: 'MAD',
        amount: '20000', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        paymentMethod: 'AGENT_COLLECTION', agentId,
        description: 'Cheque collected by RADOUAN MOHAMMED',
        allocations: [{ salesInvoiceId: invoice.id, amount: '20000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const before = await ledger();
    expect(Number(before.summary.holdingLocal)).toBeCloseTo(20000, 2);

    // More than the smaller of the two is refused.
    await expect(
      offsetAgentBalances({
        companyId, userId: ctx.admin.id, agentId, date: utcDate('2026-10-13'),
        amount: '50000', reason: 'Too much',
      }),
    ).rejects.toThrow(/only mad 20,?000/i);

    const entry = await offsetAgentBalances({
      companyId, userId: ctx.admin.id, agentId, date: utcDate('2026-10-13'),
      amount: '20000', reason: 'Agreed on the phone: he keeps what he collected against the loan',
    });

    const after = await ledger();
    expect(Number(after.summary.holdingLocal)).toBeCloseTo(0, 2);
    expect(Number(after.summary.loanFromAgentLocal)).toBeCloseTo(151000, 2);
    // The net is where it was: an offset moves two balances, not the position.
    expect(Number(after.summary.netLocal)).toBeCloseTo(Number(before.summary.netLocal), 2);

    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: entry.id },
      include: { account: true },
      orderBy: { lineNumber: 'asc' },
    });
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.currency === 'MAD')).toBe(true);
    expect(lines.every((l) => l.agentId === agentId)).toBe(true);
    expect(lines.every((l) => /agreed on the phone/i.test(l.description ?? ''))).toBe(true);
    expect(lines.find((l) => Number(l.debit) > 0)?.account.name).toMatch(/loan from radouan/i);
    expect(lines.find((l) => Number(l.credit) > 0)?.account.systemKey).toBe('AGENT_CLEARING');
  }, 300_000);

  it('leaves the books whole', async () => {
    const check = await reconcile(companyId);
    expect(check.checks.filter((c) => !c.passed)).toEqual([]);
    const sheet = await getBalanceSheet({ companyId, asOf: AS_OF });
    expect(sheet.balancesUsd).toBe(true);
    const control = await getAgentControlTotals(companyId);
    expect(control.untaggedLocal.toString()).toBe('0');
  }, 300_000);
});
