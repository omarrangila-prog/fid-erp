import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createAgentSettlement, postAgentSettlement } from '@/lib/services/agent-ledger';
import { postLoan } from '@/lib/services/loan';
import { settleUnpaidExpense } from '@/lib/services/unpaid-expenses';
import { getAgentStatement } from '@/lib/services/agent-statement';

/**
 * RADOUAN's relationship statement: one line per business event.
 *
 *   a customer's MAD 500,000 collected by him        he owes FID +500,000
 *   his MAD 30,000 commission on the shipment         FID owes him +30,000, Unpaid
 *   MAD 100,000 he lends FID                          FID owes him +100,000
 *   MAD 50,000 FID lends him                          he owes FID +50,000
 *   MAD 200,000 of the collection handed over         he owes FID −200,000
 *   the commission set off against what he holds      both −30,000, one line
 *
 * and the running position always equals his net balance in the books.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let agentId: string;
let bankId: string;
let cashId: string;
let shipmentId: string;
let commissionId: string;

const statement = () => getAgentStatement({ companyId, agentId });

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '10', effectiveDate: utcDate('2026-01-01') } });
  agentId = (await prisma.agent.create({ data: { companyId, agentCode: 'AG-RAD', agentName: 'RADOUAN MOHAMMED' } })).id;
  bankId = (await getCashAccount(companyId, 'MAD')).id;
  cashId = (await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'MAD', accountType: 'CASH' } })).id;

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10',
      freightAmount: '0', contractReference: 'ICUL/FID/STMT/1',
      lines: [{ itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '2.00', bagWeightKg: '60', lotNumber: 'STMT-LOT' }],
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

  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-08-18'), customerId: masters.customer.id, currency: 'MAD', rateToUsd: '10', rateLocalPerUsd: '10',
      lines: [{ batchId: batch.id, warehouseId: masters.warehouses[0].id, quantity: '20000', unit: 'KG' as const, unitPrice: '25.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

  // 18 Aug — the customer's MAD 500,000 is handed to him.
  const receipt = await createReceipt(
    {
      companyId, receiptDate: utcDate('2026-08-18'), customerId: masters.customer.id, currency: 'MAD', amount: '500000',
      rateToUsd: '10', rateLocalPerUsd: '10', paymentMethod: 'AGENT_COLLECTION', agentId,
      allocations: [{ salesInvoiceId: invoice.id, amount: '500000' }],
    },
    ctx.admin.id,
  );
  await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

  // 25 Aug — his commission on the shipment, owed to him.
  const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', status: 'ACTIVE' }, orderBy: { code: 'asc' } });
  const commission = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-08-25'), expenseCategoryId: category.id, kind: 'SHIPMENT', shipmentId,
      currency: 'MAD', amount: '30000', rateToUsd: '10', rateLocalPerUsd: '10', payableToAgentId: agentId,
      paymentMethod: 'BANK_TRANSFER', capitaliseToLandedCost: true, description: 'Commission for MSC shipment',
    } as never,
    ctx.admin.id,
  );
  await postExpense({ id: commission.id, companyId, userId: ctx.admin.id });
  commissionId = commission.id;

  // 28 Aug — he lends FID MAD 100,000; 29 Aug — FID lends him MAD 50,000.
  await postLoan({ companyId, userId: ctx.admin.id, loanDate: utcDate('2026-08-28'), direction: 'RECEIVED', agentId, cashBankAccountId: cashId, currency: 'MAD', amount: '100000' });
  await postLoan({ companyId, userId: ctx.admin.id, loanDate: utcDate('2026-08-29'), direction: 'GIVEN', agentId, cashBankAccountId: cashId, currency: 'MAD', amount: '50000' });

  // 5 Sep — he hands over MAD 200,000 of what he collected.
  const handover = await createAgentSettlement(
    { companyId, agentId, settlementDate: utcDate('2026-09-05'), direction: 'COLLECTION', cashBankAccountId: bankId, currency: 'MAD', amount: '200000', rateToUsd: '10', rateLocalPerUsd: '10', notes: 'Handed over at the bank' },
    ctx.admin.id,
  );
  await postAgentSettlement({ id: handover.id, companyId, userId: ctx.admin.id });

  // 10 Sep — the commission is kept from what he still holds.
  await settleUnpaidExpense(
    { companyId, expenseId: commissionId, settlementDate: utcDate('2026-09-10'), method: 'SET_OFF', amount: '30000', rateToUsd: '10', rateLocalPerUsd: '10', setOffAgainst: `agent:${agentId}` },
    ctx.admin.id,
  );
}, 300_000);

describe('one line per business event', () => {
  it('shows six events, oldest first, each in words', async () => {
    const { events } = await statement();
    expect(events.map((e) => e.typeLabel)).toEqual([
      'Customer Collection',
      category(),
      'Loan received from RADOUAN MOHAMMED',
      'Loan given to RADOUAN MOHAMMED',
      expect.stringMatching(/^Agent settlement — money handed over/),
      'Commission set-off against Agent Clearing',
    ]);
  }, 300_000);

  it('the commission is one line, on its shipment, with its cost and journal references, and reads settled', async () => {
    const { events } = await statement();
    const commissions = events.filter((e) => e.sourceType === 'EXPENSE');
    expect(commissions).toHaveLength(1);
    const c = commissions[0];
    expect(c.shipment?.reference).toBe('ICUL/FID/STMT/1');
    expect(c.documentNumber).toMatch(/^EXP \d+$/);
    expect(c.journalNumber).toMatch(/^JV \d+$/);
    expect(Number(c.payableChangeLocal)).toBeCloseTo(30_000, 2);
    expect(Number(c.receivableChangeLocal)).toBeCloseTo(0, 2);
    expect(c.memo).toBe('Commission for MSC shipment');
    expect(c.status).toBe('Settled');
  }, 300_000);

  it('the set-off is one line lowering both sides, and moves the net position not at all', async () => {
    const { events } = await statement();
    const setOff = events.find((e) => e.typeLabel.startsWith('Commission set-off'))!;
    expect(Number(setOff.receivableChangeLocal)).toBeCloseTo(-30_000, 2);
    expect(Number(setOff.payableChangeLocal)).toBeCloseTo(-30_000, 2);
    const before = events[events.indexOf(setOff) - 1];
    expect(Number(setOff.runningNetLocal)).toBeCloseTo(Number(before.runningNetLocal), 2);
    expect(setOff.shipment?.reference).toBe('ICUL/FID/STMT/1');
  }, 300_000);

  it('runs to his net position: holds 270,000 and owes 50,000, is owed 100,000 — net 220,000 owed to FID', async () => {
    const { events, summary } = await statement();
    expect(Number(summary.holdingLocal)).toBeCloseTo(270_000, 2);
    expect(Number(summary.loanToAgentLocal)).toBeCloseTo(50_000, 2);
    expect(Number(summary.loanFromAgentLocal)).toBeCloseTo(100_000, 2);
    expect(Number(summary.commissionLocal)).toBeCloseTo(0, 2);
    expect(Number(summary.owesFidLocal)).toBeCloseTo(320_000, 2);
    expect(Number(summary.fidOwesLocal)).toBeCloseTo(100_000, 2);
    expect(Number(summary.netLocal)).toBeCloseTo(220_000, 2);
    expect(Number(events[events.length - 1].runningNetLocal)).toBeCloseTo(220_000, 2);
    expect(Number(summary.unpaidExpensesLocal)).toBeCloseTo(0, 2);
  }, 300_000);

  it('filters narrow the same events', async () => {
    const { events } = await statement();
    const tagged = (f: string) => events.filter((e) => e.filters.includes(f as never)).map((e) => e.typeLabel);
    expect(tagged('LOANS')).toHaveLength(2);
    expect(tagged('SET_OFFS')).toEqual(['Commission set-off against Agent Clearing']);
    expect(tagged('COLLECTIONS')).toHaveLength(2);
    expect(tagged('SHIPMENTS').length).toBeGreaterThanOrEqual(2);
    expect(tagged('UNPAID_EXPENSES')).toHaveLength(1);
  }, 300_000);
});

function category() {
  // The commission reads as its category's name, whatever the chart calls it.
  return expect.any(String);
}
