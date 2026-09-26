import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createAgentSettlement, postAgentSettlement, recordAgentHandover } from '@/lib/services/agent-ledger';
import { getAgentLedger } from '@/lib/services/agent-account';
import { getAgentCommissionRegister } from '@/lib/services/agent-commission';
import { getReceivables } from '@/lib/services/receivables';
import { getCashBankBalance } from '@/lib/services/accounting';
import { postLoan } from '@/lib/services/loan';
import { reconcile } from '@/lib/services/reconciliation';
import { getProfitAndLoss } from '@/lib/services/reports';
import { transaction } from '@/lib/db';

/**
 * RADOUAN MOHAMMED's daily case, in the client's own figures.
 *
 *   E  a customer's MAD 500,000 cheque is handed to him     he holds 500,000
 *   F  his commission of MAD 200,000 is agreed              FID owes him 200,000
 *   G  the commission is kept against what he holds         he holds 300,000, owed 0
 *      — a ledger settlement: no cash, no bank
 *   H  he hands over the MAD 300,000                        he holds 0
 *   I  he lends FID MAD 27,500 in cash                      FID owes him 27,500
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let agentId: string;
let cashId: string;
let bankId: string;

const balance = (id: string) => transaction((tx) => getCashBankBalance(tx, companyId, id)).then(Number);
const summary = async () => (await getAgentLedger({ companyId, agentId })).summary;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '10', effectiveDate: utcDate('2026-01-01') } });
  agentId = (await prisma.agent.create({ data: { companyId, agentCode: 'AG-RAD', agentName: 'RADOUAN MOHAMMED' } })).id;
  bankId = (await getCashAccount(companyId, 'MAD')).id;
  cashId = ((await prisma.cashBankAccount.findFirst({ where: { companyId, currency: 'MAD', accountType: 'CASH' } })) ?? { id: bankId }).id;

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1',
      rateLocalPerUsd: '10', freightAmount: '0', contractReference: 'ICUL/RAD/1',
      lines: [{ itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '2.00', bagWeightKg: '60', lotNumber: 'RAD-LOT' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  const grn = await createGoodsReceipt(
    { companyId, purchaseContractId: contract.id, warehouseId: masters.warehouses[0].id, receiptDate: utcDate('2026-08-10'), receivedById: ctx.admin.id, lines: [{ batchId: batch.id, quantityKg: '20000' }] },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  // Customer A buys 20,000 KG at MAD 25 = MAD 500,000.
  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-08-20'), customerId: masters.customer.id, currency: 'MAD', rateToUsd: '10', rateLocalPerUsd: '10',
      lines: [{ batchId: batch.id, warehouseId: masters.warehouses[0].id, quantity: '20000', unit: 'KG' as const, unitPrice: '25.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

  // E — the whole MAD 500,000 cheque is handed to him.
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

describe('E — a customer cheque held by RADOUAN', () => {
  it('clears the customer, and he holds MAD 500,000; cash and bank untouched', async () => {
    expect((await getReceivables({ companyId, onlyOutstanding: true })).length).toBe(0);
    expect(Number((await summary()).holdingLocal)).toBeCloseTo(500_000, 2);
    expect(await balance(cashId)).toBeCloseTo(0, 2);
    expect(await balance(bankId)).toBeCloseTo(0, 2);
  }, 300_000);
});

describe('F — his MAD 200,000 commission', () => {
  it('is owed to him, and what he holds is still MAD 500,000', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'GENERAL', status: 'ACTIVE' }, orderBy: { code: 'asc' } });
    const expense = await createExpense(
      {
        companyId, expenseDate: utcDate('2026-08-26'), expenseCategoryId: category.id, kind: 'GENERAL', currency: 'MAD', amount: '200000',
        rateToUsd: '10', rateLocalPerUsd: '10', payableToAgentId: agentId, agentId, paymentMethod: 'BANK_TRANSFER',
        description: 'Commission, August',
      } as never,
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
    const s = await summary();
    expect(Number(s.commissionLocal)).toBeCloseTo(200_000, 2);
    expect(Number(s.holdingLocal)).toBeCloseTo(500_000, 2);
    expect((await getAgentCommissionRegister(companyId))[0].status).toBe('UNPAID');
  }, 300_000);
});

describe('G — the commission kept against what he holds', () => {
  it('is a balanced ledger settlement that moves no money', async () => {
    const cashBefore = await balance(cashId);
    const bankBefore = await balance(bankId);
    const settlement = await createAgentSettlement(
      { companyId, agentId, settlementDate: utcDate('2026-08-27'), direction: 'COMMISSION_OFFSET', currency: 'MAD', amount: '200000', rateToUsd: '10', rateLocalPerUsd: '10', notes: 'Kept his commission' },
      ctx.admin.id,
    );
    await postAgentSettlement({ id: settlement.id, companyId, userId: ctx.admin.id });

    const s = await summary();
    expect(Number(s.holdingLocal)).toBeCloseTo(300_000, 2);
    expect(Number(s.commissionLocal)).toBeCloseTo(0, 2);
    expect(await balance(cashId)).toBeCloseTo(cashBefore, 2);
    expect(await balance(bankId)).toBeCloseTo(bankBefore, 2);

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'AGENT_SETTLEMENT', sourceId: settlement.id },
      include: { lines: true },
    });
    const debit = entry.lines.reduce((t, l) => t + Number(l.debitUsd), 0);
    const credit = entry.lines.reduce((t, l) => t + Number(l.creditUsd), 0);
    expect(debit).toBeCloseTo(credit, 4);
    expect(entry.lines.every((l) => l.cashBankAccountId === null)).toBe(true);
    expect((await getAgentCommissionRegister(companyId))[0].status).toBe('PAID');
  }, 300_000);

  it('refuses more than he is owed', async () => {
    const settlement = await createAgentSettlement(
      { companyId, agentId, settlementDate: utcDate('2026-08-27'), direction: 'COMMISSION_OFFSET', currency: 'MAD', amount: '1000', rateToUsd: '10', rateLocalPerUsd: '10' },
      ctx.admin.id,
    );
    await expect(postAgentSettlement({ id: settlement.id, companyId, userId: ctx.admin.id })).rejects.toThrow(/overpay/);
  }, 300_000);

  it('refuses an account, since no money moves', async () => {
    await expect(
      createAgentSettlement(
        { companyId, agentId, settlementDate: utcDate('2026-08-27'), direction: 'COMMISSION_OFFSET', cashBankAccountId: bankId, currency: 'MAD', amount: '10', rateToUsd: '10', rateLocalPerUsd: '10' },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/moves no cash/);
  }, 300_000);
});

describe('H — he hands over the MAD 300,000', () => {
  it('reaches the bank, clears what he holds, and is not a second customer payment', async () => {
    const receiptsBefore = await prisma.receipt.count({ where: { companyId } });
    await recordAgentHandover({
      companyId, userId: ctx.admin.id, agentId, settlementDate: utcDate('2026-08-28'), cashBankAccountId: bankId,
      currency: 'MAD', amount: '300000', rateToUsd: '10', rateLocalPerUsd: '10', excess: null,
    } as never);
    expect(await balance(bankId)).toBeCloseTo(300_000, 2);
    expect(Number((await summary()).holdingLocal)).toBeCloseTo(0, 2);
    expect(await prisma.receipt.count({ where: { companyId } })).toBe(receiptsBefore);
  }, 300_000);
});

describe('I — he lends FID MAD 27,500 in cash', () => {
  it('raises cash and what FID owes him, and touches no profit', async () => {
    const pnlBefore = await getProfitAndLoss({ companyId, from: utcDate('2026-01-01'), to: utcDate('2026-12-31') });
    const cashBefore = await balance(cashId);
    await postLoan({
      companyId, userId: ctx.admin.id, loanDate: utcDate('2026-08-29'), direction: 'RECEIVED', agentId,
      cashBankAccountId: cashId, currency: 'MAD', amount: '27500', description: 'Cash for the port',
    } as never);
    expect(await balance(cashId)).toBeCloseTo(cashBefore + 27_500, 2);
    expect(Number((await summary()).loanFromAgentLocal)).toBeCloseTo(27_500, 2);
    const pnlAfter = await getProfitAndLoss({ companyId, from: utcDate('2026-01-01'), to: utcDate('2026-12-31') });
    expect(Number(pnlAfter.totals.netProfitLocal)).toBeCloseTo(Number(pnlBefore.totals.netProfitLocal), 2);
  }, 300_000);

  it('leaves the books whole', async () => {
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
  }, 300_000);
});
