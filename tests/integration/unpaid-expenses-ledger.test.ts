import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getAgentLedger } from '@/lib/services/agent-account';
import { getCashBankBalance } from '@/lib/services/accounting';
import { getOrderCostSheets } from '@/lib/services/order-cost';
import { getUnpaidExpenseLedger, getSetOffSources, settleUnpaidExpense } from '@/lib/services/unpaid-expenses';
import { reconcile } from '@/lib/services/reconciliation';
import { transaction } from '@/lib/db';

/**
 * The unpaid expenses ledger, in the client's own example.
 *
 *   A  RADOUAN's shipment commission, MAD 30,000, unpaid     ledger 30,000
 *   B  warehouse rent, MAD 9,000, unpaid, nobody named       ledger 39,000
 *   C  the commission settled in cash                        ledger  9,000, cash −30,000
 *   D  loading, MAD 12,000, paid from the bank in two parts  partial, then settled
 *   E  inspection owed to a supplier, paid by cheque
 *   F  a second commission set off against what he holds    holding −20,000, no cash
 *      and a general cost set off against his holding too
 *   G  ten more unpaid costs: ten rows, one total
 *
 * Through all of it the shipment's cost never moves once a cost is booked,
 * cash and bank move only when money does, and the schedule agrees with the
 * liability accounts.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let agentId: string;
let cashId: string;
let bankId: string;
let shipmentId: string;
let vendorId: string;
let shipmentCategoryId: string;
let generalCategoryId: string;
const ids: Record<string, string> = {};

const balance = (id: string) => transaction((tx) => getCashBankBalance(tx, companyId, id)).then(Number);
const holding = async () => Number((await getAgentLedger({ companyId, agentId })).summary.holdingLocal);
const ledger = () => getUnpaidExpenseLedger(companyId, utcDate('2026-09-30'));
const row = async (key: string) => (await ledger()).rows.find((r) => r.expenseId === ids[key])!;
const shipmentCost = async () => {
  const sheet = (await getOrderCostSheets(companyId)).find((s) => s.contractReference === 'ICUL/UNPAID/1')!;
  return Number(sheet.expenseLocal);
};
const settle = (key: string, extra: Partial<Parameters<typeof settleUnpaidExpense>[0]>) =>
  settleUnpaidExpense(
    {
      companyId,
      expenseId: ids[key],
      settlementDate: utcDate('2026-09-20'),
      method: 'CASH',
      amount: '0',
      rateToUsd: '10',
      rateLocalPerUsd: '10',
      ...extra,
    },
    ctx.admin.id,
  );

async function book(key: string, params: { amount: string; kind?: 'SHIPMENT' | 'GENERAL'; agent?: boolean; vendor?: boolean; memo: string }) {
  const kind = params.kind ?? 'SHIPMENT';
  const expense = await createExpense(
    {
      companyId,
      expenseDate: utcDate('2026-08-31'),
      expenseCategoryId: kind === 'SHIPMENT' ? shipmentCategoryId : generalCategoryId,
      kind,
      shipmentId: kind === 'SHIPMENT' ? shipmentId : null,
      currency: 'MAD',
      amount: params.amount,
      rateToUsd: '10',
      rateLocalPerUsd: '10',
      payableToAgentId: params.agent ? agentId : null,
      vendorId: params.vendor ? vendorId : null,
      paymentMethod: 'BANK_TRANSFER',
      capitaliseToLandedCost: kind === 'SHIPMENT',
      description: params.memo,
    } as never,
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
  ids[key] = expense.id;
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  vendorId = masters.vendor.id;
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '10', effectiveDate: utcDate('2026-01-01') } });
  agentId = (await prisma.agent.create({ data: { companyId, agentCode: 'AG-RAD', agentName: 'RADOUAN MOHAMMED' } })).id;
  bankId = (await getCashAccount(companyId, 'MAD')).id;
  cashId = (await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'MAD', accountType: 'CASH' } })).id;
  shipmentCategoryId = (
    await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', status: 'ACTIVE' }, orderBy: { code: 'asc' } })
  ).id;
  generalCategoryId = (
    await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'GENERAL', status: 'ACTIVE' }, orderBy: { code: 'asc' } })
  ).id;

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10',
      freightAmount: '0', contractReference: 'ICUL/UNPAID/1',
      lines: [{ itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '2.00', bagWeightKg: '60', lotNumber: 'UNP-LOT' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  shipmentId = batch.shipmentId;
  const grn = await createGoodsReceipt(
    { companyId, purchaseContractId: contract.id, warehouseId: masters.warehouses[0].id, receiptDate: utcDate('2026-08-10'), receivedById: ctx.admin.id, lines: [{ batchId: batch.id, quantityKg: '20000' }] },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  // RADOUAN collects a customer's MAD 500,000: he holds it for FID.
  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-08-20'), customerId: masters.customer.id, currency: 'MAD', rateToUsd: '10', rateLocalPerUsd: '10',
      lines: [{ batchId: batch.id, warehouseId: masters.warehouses[0].id, quantity: '20000', unit: 'KG' as const, unitPrice: '25.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
  const receipt = await createReceipt(
    {
      companyId, receiptDate: utcDate('2026-08-25'), customerId: masters.customer.id, currency: 'MAD', amount: '500000',
      rateToUsd: '10', rateLocalPerUsd: '10', paymentMethod: 'AGENT_COLLECTION', agentId,
      allocations: [{ salesInvoiceId: invoice.id, amount: '500000' }],
    },
    ctx.admin.id,
  );
  await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });
}, 300_000);

describe('A and B — unpaid costs are costs now, and a liability until settled', () => {
  it('A: the MAD 30,000 commission owed to RADOUAN is on the shipment, on the ledger, and nowhere in cash or bank', async () => {
    const costBefore = await shipmentCost();
    await book('commission', { amount: '30000', agent: true, memo: 'Commission RADOUAN' });
    expect((await shipmentCost()) - costBefore).toBeCloseTo(30_000, 2);
    const l = await ledger();
    expect(Number(l.totals.outstandingLocal)).toBeCloseTo(30_000, 2);
    const r = l.rows.find((x) => x.expenseId === ids.commission)!;
    expect(r.party).toMatchObject({ kind: 'AGENT', name: 'RADOUAN MOHAMMED' });
    expect(r.status).toBe('UNPAID');
    expect(await balance(cashId)).toBeCloseTo(0, 2);
    expect(await balance(bankId)).toBeCloseTo(0, 2);
  }, 300_000);

  it('B: MAD 9,000 rent with nobody named takes the total to MAD 39,000, and both liabilities agree', async () => {
    await book('rent', { amount: '9000', memo: 'IPSEN warehouse rent' });
    const l = await ledger();
    expect(Number(l.totals.outstandingLocal)).toBeCloseTo(39_000, 2);
    expect(l.totals.outstandingCount).toBe(2);
    expect(l.rows.find((x) => x.expenseId === ids.rent)!.party.kind).toBe('GENERAL');
    for (const rec of l.reconciliation.filter((x) => x.ledgerLocal !== null)) expect(rec.agrees, rec.control).toBe(true);
  }, 300_000);
});

describe('C — the commission paid in cash', () => {
  it('drops the ledger from 39,000 to 9,000, takes 30,000 from cash, and leaves the shipment cost alone', async () => {
    const costBefore = await shipmentCost();
    await settle('commission', { method: 'CASH', amount: '30000', cashBankAccountId: cashId, memo: 'Paid in cash' });
    const l = await ledger();
    expect(Number(l.totals.outstandingLocal)).toBeCloseTo(9_000, 2);
    expect(await balance(cashId)).toBeCloseTo(-30_000, 2);
    expect(await shipmentCost()).toBeCloseTo(costBefore, 2);
    const r = await row('commission');
    expect(r.status).toBe('SETTLED');
    expect(r.history).toHaveLength(1);
    expect(r.history[0].method).toBe('Cash');
    expect(Number((await getAgentLedger({ companyId, agentId })).summary.commissionLocal)).toBeCloseTo(0, 2);
  }, 300_000);
});

describe('D and E — a bank payment in two parts', () => {
  it('reads partially settled after MAD 5,000 of 12,000, then settled; the bank pays 12,000 and the cost is booked once', async () => {
    await book('loading', { amount: '12000', memo: 'Loading' });
    const costBefore = await shipmentCost();
    const bankBefore = await balance(bankId);
    await settle('loading', { method: 'BANK', amount: '5000', cashBankAccountId: bankId });
    let r = await row('loading');
    expect(r.status).toBe('PARTIAL');
    expect(Number(r.settled)).toBeCloseTo(5_000, 2);
    expect(Number(r.outstanding)).toBeCloseTo(7_000, 2);
    await settle('loading', { method: 'BANK', amount: '7000', cashBankAccountId: bankId });
    r = await row('loading');
    expect(r.status).toBe('SETTLED');
    expect(r.history.map((h) => Number(h.amount))).toEqual([5000, 7000]);
    expect((await balance(bankId)) - bankBefore).toBeCloseTo(-12_000, 2);
    expect(await shipmentCost()).toBeCloseTo(costBefore, 2);
  }, 300_000);

  it('refuses to settle more than is still owed', async () => {
    await expect(settle('rent', { method: 'CASH', amount: '9000.01', cashBankAccountId: cashId })).rejects.toThrow(/still owed/);
  }, 300_000);
});

describe('Cheque — a cost owed to a supplier', () => {
  it('is settled by a cheque written against it; cash and bank wait for the cheque to clear', async () => {
    await book('inspection', { amount: '5000', vendor: true, memo: 'Inspection' });
    expect((await row('inspection')).party.kind).toBe('SUPPLIER');
    const bankBefore = await balance(bankId);
    await settle('inspection', {
      method: 'CHEQUE',
      amount: '5000',
      cashBankAccountId: bankId,
      cheque: { chequeNumber: 'CHQ-7781', chequeDate: utcDate('2026-09-20'), bankName: 'ATTIJARI' },
    });
    const r = await row('inspection');
    expect(r.status).toBe('SETTLED');
    expect(r.history[0].method).toBe('Cheque');
    expect(r.history[0].through).toMatch(/CHQ-7781/);
    expect(await balance(bankId)).toBeCloseTo(bankBefore, 2);
  }, 300_000);
});

describe('F — set off against what RADOUAN holds', () => {
  it('a second commission of MAD 20,000 is kept from his MAD 500,000: he holds 480,000; no cash or bank moves', async () => {
    await book('commission2', { amount: '20000', agent: true, memo: 'Commission RADOUAN, second shipment' });
    const cash = await balance(cashId);
    const bank = await balance(bankId);
    const sources = await getSetOffSources(companyId, 'MAD', agentId);
    expect(sources).toHaveLength(1);
    expect(Number(sources[0].available)).toBeCloseTo(500_000, 2);
    await settle('commission2', { method: 'SET_OFF', amount: '20000', setOffAgainst: `agent:${agentId}` });
    expect(await holding()).toBeCloseTo(480_000, 2);
    expect(await balance(cashId)).toBeCloseTo(cash, 2);
    expect(await balance(bankId)).toBeCloseTo(bank, 2);
    const r = await row('commission2');
    expect(r.status).toBe('SETTLED');
    expect(r.history[0].through).toMatch(/Agent Collections/);
  }, 300_000);

  it('a general cost can be set off against his holding in part, and the journal balances', async () => {
    await book('professional', { amount: '7000', kind: 'GENERAL', memo: 'Professional charges' });
    await settle('professional', { method: 'SET_OFF', amount: '4000', setOffAgainst: `agent:${agentId}` });
    expect(await holding()).toBeCloseTo(476_000, 2);
    const r = await row('professional');
    expect(r.status).toBe('PARTIAL');
    expect(Number(r.outstanding)).toBeCloseTo(3_000, 2);
    const payment = await prisma.payment.findFirstOrThrow({ where: { companyId, ledgerAgentId: agentId } });
    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { sourceType: 'PAYMENT', sourceId: payment.id }, include: { lines: true } });
    const debit = entry.lines.reduce((t, l) => t + Number(l.debitLocal), 0);
    const credit = entry.lines.reduce((t, l) => t + Number(l.creditLocal), 0);
    expect(debit).toBeCloseTo(credit, 2);
    expect(entry.lines.every((l) => l.cashBankAccountId === null)).toBe(true);
  }, 300_000);

  it('cannot set off more than the balance holds', async () => {
    const other = await prisma.agent.create({ data: { companyId, agentCode: 'AG-EMPTY', agentName: 'Agent with nothing' } });
    await expect(settle('rent', { method: 'SET_OFF', amount: '9000', setOffAgainst: `agent:${other.id}` })).rejects.toThrow(/holding/);
    expect(Number((await row('rent')).outstanding)).toBeCloseTo(9_000, 2);
  }, 300_000);
});

describe('G — many unpaid costs', () => {
  it('keeps every one as its own row and adds them to one total that agrees with the books', async () => {
    const before = await ledger();
    for (let i = 1; i <= 10; i += 1) await book(`many${i}`, { amount: String(1000 * i), memo: `Cost ${i}` });
    const l = await ledger();
    expect(l.rows.filter((r) => r.memo?.startsWith('Cost ')).length).toBe(10);
    expect(Number(l.totals.outstandingLocal) - Number(before.totals.outstandingLocal)).toBeCloseTo(55_000, 2);
    for (const rec of l.reconciliation.filter((x) => x.ledgerLocal !== null)) expect(rec.agrees, rec.control).toBe(true);
    const checks = await reconcile(companyId);
    const failing = checks.checks.filter((c) => !c.passed).map((c) => c.label);
    expect(failing).toEqual([]);
  }, 300_000);
});
