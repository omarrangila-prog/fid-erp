import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createPayment, postPayment } from '@/lib/services/payment';
import { createCreditNote, postCreditNote, reverseCreditNote } from '@/lib/services/credit-note';
import { getTrialBalanceReport } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';

/**
 * Credit notes and advances — the documents an accountant needs that a
 * reversal cannot stand in for.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let batchId: string;
let invoiceId: string;

const balanceOf = async (companyId: string, systemKey: string) => {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return Number(rows[0]?.bal ?? 0);
};

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id);

  const contract = await createPurchaseContract(
    {
      companyId: ctx.dubai.id, contractReference: 'CN-PO-1', contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
      freightAmount: '0',
      lines: [{ itemId: masters.item.id, lotNumber: 'CN-LOT', batchNumber: 'CN-B001',
                quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  await receiveEverything({
    companyId: ctx.dubai.id, purchaseContractId: contract.id,
    warehouseId: masters.warehouse.id, userId: ctx.admin.id, receiptDate: utcDate('2026-01-20'),
  });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'CN-B001' } })).id;

  const invoice = await createSalesInvoice(
    {
      companyId: ctx.dubai.id, invoiceDate: utcDate('2026-02-01'), customerId: masters.customer.id,
      currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725', paymentTermDays: 30,
      lines: [{ batchId, warehouseId: masters.warehouse.id, quantity: '10000', unit: 'KG', unitPrice: '6.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  invoiceId = invoice.id;
});

describe('customer advances', () => {
  it('puts an unallocated receipt into Customer Advances, not receivables', async () => {
    const bank = await getCashAccount(ctx.dubai.id, 'USD');
    const before = await balanceOf(ctx.dubai.id, 'CUSTOMER_ADVANCES');

    const receipt = await createReceipt(
      {
        companyId: ctx.dubai.id, receiptDate: utcDate('2026-02-05'), customerId: masters.customer.id,
        currency: 'USD', amount: '15000', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        paymentMethod: 'BANK_TRANSFER', cashBankAccountId: bank.id,
        // Deliberately no allocations: money arrived before it was applied.
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const after = await balanceOf(ctx.dubai.id, 'CUSTOMER_ADVANCES');
    // A liability, so it moves credit-ward: the signed balance falls by 15,000.
    expect(after - before).toBeCloseTo(-15000, 2);
  });

  it('still relieves receivables when the receipt is allocated', async () => {
    const bank = await getCashAccount(ctx.dubai.id, 'USD');
    const arBefore = await balanceOf(ctx.dubai.id, 'ACCOUNTS_RECEIVABLE');

    const receipt = await createReceipt(
      {
        companyId: ctx.dubai.id, receiptDate: utcDate('2026-02-06'), customerId: masters.customer.id,
        currency: 'USD', amount: '20000', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        paymentMethod: 'BANK_TRANSFER', cashBankAccountId: bank.id,
        allocations: [{ salesInvoiceId: invoiceId, amount: '20000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const arAfter = await balanceOf(ctx.dubai.id, 'ACCOUNTS_RECEIVABLE');
    expect(arAfter - arBefore).toBeCloseTo(-20000, 2);
  });
});

describe('supplier advances', () => {
  it('puts an unallocated payment into Advances to Suppliers', async () => {
    const bank = await getCashAccount(ctx.dubai.id, 'USD');
    const before = await balanceOf(ctx.dubai.id, 'SUPPLIER_ADVANCES');

    const payment = await createPayment(
      {
        companyId: ctx.dubai.id, paymentDate: utcDate('2026-02-07'), vendorId: masters.vendor.id,
        currency: 'USD', amount: '9000', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        paymentMethod: 'BANK_TRANSFER', cashBankAccountId: bank.id,
      },
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const after = await balanceOf(ctx.dubai.id, 'SUPPLIER_ADVANCES');
    // An asset: the signed balance rises.
    expect(after - before).toBeCloseTo(9000, 2);
  });
});

describe('customer credit note', () => {
  it('credits the customer and reduces revenue without touching the invoice', async () => {
    const arBefore = await balanceOf(ctx.dubai.id, 'ACCOUNTS_RECEIVABLE');

    const note = await createCreditNote(
      {
        companyId: ctx.dubai.id, type: 'CUSTOMER', creditDate: utcDate('2026-02-10'),
        customerId: masters.customer.id, salesInvoiceId: invoiceId,
        currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        reason: 'Quality claim — 2% allowance',
        lines: [{ description: 'Quality allowance', amount: '1200' }],
      },
      ctx.admin.id,
    );
    await postCreditNote({ id: note.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    expect((await balanceOf(ctx.dubai.id, 'ACCOUNTS_RECEIVABLE')) - arBefore).toBeCloseTo(-1200, 2);
    expect(await balanceOf(ctx.dubai.id, 'SALES_RETURNS')).toBeCloseTo(1200, 2);

    // The invoice itself is untouched — both documents stay on file.
    const invoice = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('POSTED');
    expect(Number(invoice.totalAmountUsd)).toBeCloseTo(60000, 2);
  });

  it('returns coffee to the warehouse and reverses its cost of sale', async () => {
    const stockBefore = await prisma.inventoryBalance.findFirstOrThrow({
      where: { batchId, warehouseId: masters.warehouse.id },
    });
    const cogsBefore = await balanceOf(ctx.dubai.id, 'COST_OF_GOODS_SOLD');

    const note = await createCreditNote(
      {
        companyId: ctx.dubai.id, type: 'CUSTOMER', creditDate: utcDate('2026-02-12'),
        customerId: masters.customer.id,
        currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        reason: 'Goods returned — wrong grade shipped',
        lines: [{
          description: 'Return of 500 KG', batchId, warehouseId: masters.warehouse.id,
          quantityKg: '500', unitPrice: '6.00',
        }],
      },
      ctx.admin.id,
    );
    await postCreditNote({ id: note.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const stockAfter = await prisma.inventoryBalance.findFirstOrThrow({
      where: { batchId, warehouseId: masters.warehouse.id },
    });
    expect(Number(stockAfter.onHandKg) - Number(stockBefore.onHandKg)).toBeCloseTo(500, 3);

    // 500 KG at the batch's 4.00 landed cost comes back out of cost of sales.
    expect((await balanceOf(ctx.dubai.id, 'COST_OF_GOODS_SOLD')) - cogsBefore).toBeCloseTo(-2000, 2);
  });

  it('refuses to credit more than the invoice is worth', async () => {
    await expect(
      createCreditNote(
        {
          companyId: ctx.dubai.id, type: 'CUSTOMER', creditDate: utcDate('2026-02-13'),
          customerId: masters.customer.id, salesInvoiceId: invoiceId,
          currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
          reason: 'Excessive',
          lines: [{ description: 'Too much', amount: '999999' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/left to credit/i);
  });

  it('refuses to return more than the batch ever sold', async () => {
    await expect(
      createCreditNote(
        {
          companyId: ctx.dubai.id, type: 'CUSTOMER', creditDate: utcDate('2026-02-14'),
          customerId: masters.customer.id,
          currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
          reason: 'Impossible return',
          lines: [{ description: 'Too much stock', batchId, warehouseId: masters.warehouse.id,
                    quantityKg: '50000', unitPrice: '6.00' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/recorded as sold/i);
  });
});

describe('supplier credit note', () => {
  it('reduces what we owe the supplier', async () => {
    const apBefore = await balanceOf(ctx.dubai.id, 'ACCOUNTS_PAYABLE');

    const note = await createCreditNote(
      {
        companyId: ctx.dubai.id, type: 'VENDOR', creditDate: utcDate('2026-02-15'),
        vendorId: masters.vendor.id,
        currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        reason: 'Short shipment allowance',
        lines: [{ description: 'Weight shortage', amount: '800' }],
      },
      ctx.admin.id,
    );
    await postCreditNote({ id: note.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    // Payables is a credit balance, so debiting it raises the signed figure.
    expect((await balanceOf(ctx.dubai.id, 'ACCOUNTS_PAYABLE')) - apBefore).toBeCloseTo(800, 2);
  });
});

describe('the books survive all of it', () => {
  it('keeps the trial balance balanced', async () => {
    const tb = await getTrialBalanceReport({ companyId: ctx.dubai.id });
    expect(tb.isBalanced).toBe(true);
  });

  it('passes every reconciliation check', async () => {
    const result = await reconcile(ctx.dubai.id);
    const failed = result.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.differenceUsd}`);
    expect(failed).toEqual([]);
  });

  it('reverses a credit note and leaves the books balanced', async () => {
    const note = await createCreditNote(
      {
        companyId: ctx.dubai.id, type: 'CUSTOMER', creditDate: utcDate('2026-02-16'),
        customerId: masters.customer.id,
        currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        reason: 'Raised in error',
        lines: [{ description: 'Mistake', amount: '300' }],
      },
      ctx.admin.id,
    );
    await postCreditNote({ id: note.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    await reverseCreditNote({ id: note.id, companyId: ctx.dubai.id, userId: ctx.admin.id, reason: 'Duplicate' });

    const tb = await getTrialBalanceReport({ companyId: ctx.dubai.id });
    expect(tb.isBalanced).toBe(true);
    const result = await reconcile(ctx.dubai.id);
    expect(result.failed).toBe(0);
  });
});
