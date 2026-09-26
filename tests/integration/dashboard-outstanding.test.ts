import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { postLoan } from '@/lib/services/loan';
import { getOutstandingSummary } from '@/lib/services/outstanding';

/**
 * The dashboard's "still to be paid or collected", against the documents
 * behind each card: an unpaid invoice, a part-paid one, a cheque the agent
 * holds, his commission, a loan from him, and a shipment and a general cost
 * still to pay — each in its own card, none counted twice.
 */

let companyId: string;
let agentId: string;

beforeAll(async () => {
  await resetDatabase();
  const ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '10', effectiveDate: utcDate('2026-01-01') } });
  agentId = (await prisma.agent.create({ data: { companyId, agentCode: 'AG-RAD2', agentName: 'RADOUAN MOHAMMED' } })).id;
  const cashId = (await getCashAccount(companyId, 'MAD')).id;

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10',
      freightAmount: '0', contractReference: 'ICUL/DASH/1',
      lines: [{ itemId: masters.item.id, quantity: '40000', unit: 'KG', unitPrice: '2.00', bagWeightKg: '60', lotNumber: 'DASH-LOT' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  const grn = await createGoodsReceipt(
    { companyId, purchaseContractId: contract.id, warehouseId: masters.warehouses[0].id, receiptDate: utcDate('2026-08-05'), receivedById: ctx.admin.id, lines: [{ batchId: batch.id, quantityKg: '40000' }] },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  const sell = async (kg: string) => {
    const invoice = await createSalesInvoice(
      {
        companyId, invoiceDate: utcDate('2026-08-10'), customerId: masters.customer.id, currency: 'MAD', rateToUsd: '10', rateLocalPerUsd: '10',
        lines: [{ batchId: batch.id, warehouseId: masters.warehouses[0].id, quantity: kg, unit: 'KG' as const, unitPrice: '25.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
    return invoice.id;
  };
  const collect = async (invoiceId: string, amount: string, agent: boolean) => {
    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-08-12'), customerId: masters.customer.id, currency: 'MAD', amount, rateToUsd: '10', rateLocalPerUsd: '10',
        ...(agent ? { paymentMethod: 'AGENT_COLLECTION', agentId } : { paymentMethod: 'CASH', cashBankAccountId: cashId }),
        allocations: [{ salesInvoiceId: invoiceId, amount }],
      } as never,
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });
  };

  await sell('4000'); // MAD 100,000, unpaid
  const partial = await sell('8000'); // MAD 200,000, MAD 50,000 received
  await collect(partial, '50000', false);
  const held = await sell('20000'); // MAD 500,000, the whole cheque with RADOUAN
  await collect(held, '500000', true);

  const general = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'GENERAL', status: 'ACTIVE' }, orderBy: { code: 'asc' } });
  const shipment = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', status: 'ACTIVE' }, orderBy: { code: 'asc' } });
  const cost = async (categoryId: string, kind: 'GENERAL' | 'SHIPMENT', amount: string, extra: object = {}) => {
    const e = await createExpense(
      { companyId, expenseDate: utcDate('2026-08-15'), expenseCategoryId: categoryId, kind, currency: 'MAD', amount, rateToUsd: '10', rateLocalPerUsd: '10', paymentMethod: 'BANK_TRANSFER', ...extra } as never,
      ctx.admin.id,
    );
    await postExpense({ id: e.id, companyId, userId: ctx.admin.id });
  };
  await cost(general.id, 'GENERAL', '5000');
  await cost(shipment.id, 'SHIPMENT', '7400', { shipmentId: batch.shipmentId, capitaliseToLandedCost: true });
  await cost(general.id, 'GENERAL', '200000', { payableToAgentId: agentId, agentId, description: 'Commission' });
  await postLoan({ companyId, userId: ctx.admin.id, loanDate: utcDate('2026-08-20'), direction: 'RECEIVED', agentId, cashBankAccountId: cashId, currency: 'MAD', amount: '27500' } as never);
}, 300_000);

describe('still to be paid or collected', () => {
  it('counts each thing once, in its own card', async () => {
    const o = await getOutstandingSummary(companyId);
    expect(o.invoicesUnpaid.count).toBe(1);
    expect(Number(o.invoicesUnpaid.local)).toBeCloseTo(100_000, 2);
    expect(o.invoicesPartial.count).toBe(1);
    expect(Number(o.invoicesPartial.local)).toBeCloseTo(150_000, 2);
    expect(Number(o.generalExpensesUnpaid.local)).toBeCloseTo(5_000, 2);
    expect(Number(o.shipmentExpensesUnpaid.local)).toBeCloseTo(7_400, 2);
    // The commission is the agent's card, not a general cost as well.
    expect(o.generalExpensesUnpaid.count).toBe(1);
    expect(Number(o.agentCollections.local)).toBeCloseTo(500_000, 2);
    expect(Number(o.agentCommission.local)).toBeCloseTo(200_000, 2);
    expect(Number(o.loansPayable.local)).toBeCloseTo(27_500, 2);
  }, 300_000);

  it('gives RADOUAN a card of his own', async () => {
    const o = await getOutstandingSummary(companyId);
    const radouan = o.agents.find((a) => a.agentId === agentId)!;
    expect(radouan.agentName).toBe('RADOUAN MOHAMMED');
    expect(Number(radouan.holdingLocal)).toBeCloseTo(500_000, 2);
    expect(Number(radouan.commissionLocal)).toBeCloseTo(200_000, 2);
    expect(Number(radouan.loanFromLocal)).toBeCloseTo(27_500, 2);
  }, 300_000);
});
