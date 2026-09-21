import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, receiveEverything, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice, updateSalesInvoice, reverseSalesInvoice } from '@/lib/services/sales';
import { createExpense, postExpense } from '@/lib/services/expense';
import { reconcile } from '@/lib/services/reconciliation';

/**
 * Invoice 1 on the client's books: sold, then freight landed on the shipment
 * (its share for the sold coffee went to cost of sales and onto the invoice
 * lines), then the invoice was corrected. The correction gave back only the
 * cost the sale was first posted at, re-posted at today's landed cost, and
 * left inventory USD 25.04 short and cost of sales USD 25.04 long.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let invoiceId: string;
let batchId: string;

const failing = async () => (await reconcile(companyId)).checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.differenceUsd}`);

const invoiceInput = (price: string) => ({
  companyId,
  invoiceDate: utcDate('2026-08-12'),
  customerId: masters.customer.id,
  currency: 'MAD',
  rateToUsd: '9.85',
  rateLocalPerUsd: '9.85',
  lines: [{ batchId, warehouseId: masters.warehouse.id, quantity: '359.2', unit: 'KG' as const, unitPrice: price }],
});

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  const contract = await createPurchaseContract(
    {
      companyId, vendorId: masters.vendor.id, contractDate: utcDate('2026-05-21'), currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.85', freightAmount: '0',
      lines: [{ itemId: masters.item.id, quantity: '20040', unit: 'KG', unitPrice: '4.108', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const { batches } = await receiveEverything({ companyId, purchaseContractId: contract.id, warehouseId: masters.warehouse.id, userId: ctx.admin.id, receiptDate: utcDate('2026-08-10') });
  batchId = batches[0].id;

  const invoice = await createSalesInvoice(invoiceInput('63.00'), ctx.admin.id);
  invoiceId = invoice.id;
  await postSalesInvoice({ id: invoiceId, companyId, userId: ctx.admin.id });

  // Freight lands after the sale: part of it belongs to the coffee already sold.
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', capitaliseByDefault: true } });
  const cash = await getCashAccount(companyId, 'MAD');
  const expense = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-08-20'), expenseCategoryId: category.id, shipmentId: shipment.id,
      currency: 'MAD', amount: '14000', rateToUsd: '9.6', rateLocalPerUsd: '9.6', paymentMethod: 'CASH',
      cashBankAccountId: cash.id, kind: 'SHIPMENT', capitaliseToLandedCost: true, description: 'Freight fees in Morocco',
    },
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
}, 300_000);

describe('an invoice corrected after later shipment cost reached it', () => {
  it('starts reconciled, with the later cost on the invoice line', async () => {
    const line = await prisma.salesInvoiceLine.findFirstOrThrow({ where: { salesInvoiceId: invoiceId } });
    expect(Number(line.costTotalUsd)).toBeGreaterThan(359.2 * 4.108);
    expect(await failing()).toEqual([]);
  }, 300_000);

  it('stays reconciled when the invoice is corrected', async () => {
    await updateSalesInvoice(invoiceId, invoiceInput('63.00'), ctx.admin.id);
    expect(await failing()).toEqual([]);
  }, 300_000);

  it('stays reconciled when the invoice is deleted', async () => {
    await reverseSalesInvoice({ id: invoiceId, companyId, userId: ctx.admin.id, reason: 'Entered in error' });
    expect(await failing()).toEqual([]);
  }, 300_000);
});
