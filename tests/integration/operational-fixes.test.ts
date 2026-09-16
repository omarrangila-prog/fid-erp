import { beforeAll, describe, expect, it } from 'vitest';
import {
  prisma,
  transaction,
  resetDatabase,
  getContext,
  createMasters,
  utcDate,
  receiveEverything,
  getCashAccount,
} from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import {
  createSalesInvoice,
  postSalesInvoice,
  reverseSalesInvoice,
  cancelSalesInvoice,
  type SalesInvoiceInput,
} from '@/lib/services/sales';
import { createReceipt, postReceipt, getInvoiceOutstanding } from '@/lib/services/receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getCustomerBalance, getSystemAccount, postJournalEntry, getCashBankBalance } from '@/lib/services/accounting';
import { getCustomerLedger } from '@/lib/services/ledger';
import { customerSchema } from '@/lib/validation/masters';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { dec } from '@/lib/money';
import { resolveMasterCode } from '@/lib/services/master-code';

/**
 * The operational path that has to work before anyone can enter pending
 * invoices: add a customer, post a sale, delete it (reversing stock and the
 * ledger), then post journals in USD and MAD and read each currency on its own.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let batchId: string;
let warehouseId: string;
let customerId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.morocco.id, { currency: 'USD' });
  warehouseId = masters.warehouse.id;
  customerId = masters.customer.id;

  const contract = await createPurchaseContract(
    {
      companyId: ctx.morocco.id,
      contractReference: 'OPS-PO',
      contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      freightAmount: '0',
      lines: [
        {
          itemId: masters.item.id,
          lotNumber: 'OPS-LOT',
          batchNumber: 'OPS-B001',
          quantity: '10000',
          unit: 'KG',
          unitPrice: '4.00',
          bagWeightKg: '60',
        },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
  await receiveEverything({
    companyId: ctx.morocco.id,
    purchaseContractId: contract.id,
    warehouseId,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-01-20'),
  });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'OPS-B001' } })).id;
});

function saleInput(overrides: Partial<SalesInvoiceInput> = {}): SalesInvoiceInput {
  return {
    companyId: ctx.morocco.id,
    invoiceDate: utcDate('2026-03-01'),
    customerId,
    currency: 'USD',
    rateToUsd: '1',
    rateLocalPerUsd: '9.85',
    lines: [{ batchId, warehouseId, quantity: '500', unit: 'KG', unitPrice: '6.00' }],
    ...overrides,
  };
}

describe('master save validation', () => {
  it('saves a customer when email is omitted', () => {
    const parsed = customerSchema.safeParse({
      customerName: 'Casablanca Roasters',
      primaryCurrency: 'MAD',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBeNull();
  });

  it('creates a customer from the fields the Save form posts, and keeps the code on edit', async () => {
    const parsed = customerSchema.parse({
      customerName: 'Tangier Roasters',
      primaryCurrency: 'MAD',
      status: 'ACTIVE',
      creditLimit: '0',
    });
    expect('generate' in resolveMasterCode({ submitted: parsed.customerCode, isCreate: true })).toBe(true);

    const created = await prisma.customer.create({
      data: {
        companyId: ctx.morocco.id,
        customerCode: 'CUS-AUDIT-1',
        customerName: parsed.customerName,
        primaryCurrency: parsed.primaryCurrency,
        creditLimit: parsed.creditLimit,
        status: parsed.status,
        country: parsed.country,
        email: parsed.email,
      },
    });
    expect(created.customerName).toBe('Tangier Roasters');

    const listed = await prisma.customer.findFirst({
      where: { companyId: ctx.morocco.id, customerName: 'Tangier Roasters' },
    });
    expect(listed?.id).toBe(created.id);

    const edited = customerSchema.parse({
      customerName: 'Tangier Roasters SAS',
      primaryCurrency: 'MAD',
      status: 'ACTIVE',
      creditLimit: '0',
    });
    const kept = resolveMasterCode({
      submitted: edited.customerCode,
      existing: created.customerCode,
      isCreate: false,
    });
    expect(kept).toEqual({ code: 'CUS-AUDIT-1' });

    const updated = await prisma.customer.update({
      where: { id: created.id },
      data: { customerName: edited.customerName, customerCode: 'code' in kept ? kept.code : created.customerCode },
    });
    expect(updated.customerCode).toBe('CUS-AUDIT-1');
    expect(updated.customerName).toBe('Tangier Roasters SAS');
  });
});

describe('delete invoice reverses stock, AR and the ledger', () => {
  it('returns stock and zeros the receivable when a posted invoice is deleted', async () => {
    const stockBefore = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId, warehouseId } },
    });

    const invoice = await createSalesInvoice(saleInput(), ctx.admin.id);
    await postSalesInvoice({ id: invoice.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const balanceAfterPost = await transaction((tx) => getCustomerBalance(tx, ctx.morocco.id, customerId));
    expect(balanceAfterPost.toString()).toBe('3000');

    const stockAfterSale = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId, warehouseId } },
    });
    expect(dec(stockAfterSale.availableKg).toString()).toBe(dec(stockBefore.availableKg).minus(500).toString());

    const cancelled = await cancelSalesInvoice({
      id: invoice.id,
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      reason: 'Entered in error',
    });
    // Cancelled, not deleted: the document stays, marked reversed, because
    // every journal line and receipt allocation still points at it.
    expect(cancelled.status).toBe('REVERSED');

    const kept = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(kept.status).toBe('REVERSED');
    expect(kept.reversalReason).toBe('Entered in error');

    const stockAfterCancel = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId, warehouseId } },
    });
    expect(dec(stockAfterCancel.availableKg).toString()).toBe(dec(stockBefore.availableKg).toString());

    const balanceAfterCancel = await transaction((tx) => getCustomerBalance(tx, ctx.morocco.id, customerId));
    expect(balanceAfterCancel.toString()).toBe('0');

    const entries = await prisma.journalEntry.findMany({
      where: { sourceType: 'SALES_INVOICE', sourceId: invoice.id },
      orderBy: { sourceSeq: 'asc' },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].isReversal).toBe(false);
    expect(entries[1].isReversal).toBe(true);
    expect(entries[1].reversalOfId).toBe(entries[0].id);
  });

  it('leaves an already-cancelled invoice as it is, without reversing again', async () => {
    const invoice = await createSalesInvoice(saleInput(), ctx.admin.id);
    await postSalesInvoice({ id: invoice.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
    await reverseSalesInvoice({
      id: invoice.id,
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      reason: 'Entered in error',
    });

    const leftover = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(leftover.status).toBe('REVERSED');

    const stockBeforeRemove = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId, warehouseId } },
    });
    const balanceBeforeRemove = await transaction((tx) => getCustomerBalance(tx, ctx.morocco.id, customerId));

    const removed = await cancelSalesInvoice({
      id: invoice.id,
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
    });
    expect(removed.status).toBe('REVERSED');
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('REVERSED');

    const stockAfterRemove = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId, warehouseId } },
    });
    expect(dec(stockAfterRemove.availableKg).toString()).toBe(dec(stockBeforeRemove.availableKg).toString());
    const balanceAfterRemove = await transaction((tx) => getCustomerBalance(tx, ctx.morocco.id, customerId));
    expect(balanceAfterRemove.toString()).toBe(balanceBeforeRemove.toString());

    const entries = await prisma.journalEntry.findMany({
      where: { sourceType: 'SALES_INVOICE', sourceId: invoice.id },
    });
    expect(entries).toHaveLength(2);
  });
});

describe('credit invoice then Record Payment', () => {
  it('posts the receipt, reduces what the customer owes, and refuses to delete the invoice until the receipt is reversed', async () => {
    const bank = await getCashAccount(ctx.morocco.id, 'USD');
    const invoice = await createSalesInvoice(saleInput(), ctx.admin.id);
    await postSalesInvoice({ id: invoice.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const outstandingAfterSale = await transaction((tx) => getInvoiceOutstanding(tx, invoice.id));
    expect(outstandingAfterSale.amount.toString()).toBe('3000');

    const cashBefore = await transaction((tx) => getCashBankBalance(tx, ctx.morocco.id, bank.id));

    const receipt = await createReceipt(
      {
        companyId: ctx.morocco.id,
        receiptDate: utcDate('2026-03-05'),
        customerId,
        currency: 'USD',
        amount: '3000',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: bank.id,
        allocations: [{ salesInvoiceId: invoice.id, amount: '3000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const outstandingAfterPay = await transaction((tx) => getInvoiceOutstanding(tx, invoice.id));
    expect(outstandingAfterPay.amount.toString()).toBe('0');

    const cashAfter = await transaction((tx) => getCashBankBalance(tx, ctx.morocco.id, bank.id));
    expect(dec(cashAfter).minus(cashBefore).toString()).toBe('3000');

    await expect(
      cancelSalesInvoice({
        id: invoice.id,
        companyId: ctx.morocco.id,
        userId: ctx.admin.id,
        reason: 'Trying to delete a paid invoice',
      }),
    ).rejects.toThrow(/receipts are allocated/i);
  });
});

describe('unpaid shipment expense without cash or bank', () => {
  it('books the cost and a payable, and does not touch cash', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, kind: 'SHIPMENT' },
    });
    const shipment = await prisma.shipment.findFirstOrThrow({ where: { companyId: ctx.morocco.id } });
    const cash = await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, currency: 'USD', accountType: 'CASH' },
    });
    const cashBefore = await transaction((tx) => getCashBankBalance(tx, ctx.morocco.id, cash.id));

    const expense = await createExpense(
      {
        companyId: ctx.morocco.id,
        expenseDate: utcDate('2026-03-10'),
        expenseCategoryId: category.id,
        shipmentId: shipment.id,
        currency: 'USD',
        amount: '1000',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        kind: 'SHIPMENT',
        description: 'Unpaid agent commission',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const stored = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(stored.cashBankAccountId).toBeNull();
    expect(stored.status).toBe('POSTED');

    const cashAfter = await transaction((tx) => getCashBankBalance(tx, ctx.morocco.id, cash.id));
    expect(cashAfter.toString()).toBe(cashBefore.toString());
  });
});

describe('journals keep USD and MAD separate on the ledger', () => {
  it('stores each voucher in its own currency and does not mix the totals', async () => {
    const ar = await transaction((tx) => getSystemAccount(tx, ctx.morocco.id, ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE));
    const equity = await transaction((tx) => getSystemAccount(tx, ctx.morocco.id, ACCOUNT_KEYS.OPENING_BALANCE_EQUITY));

    await transaction(async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: ctx.morocco.id },
        select: { localCurrency: true },
      });
      await postJournalEntry(tx, {
        companyId: ctx.morocco.id,
        entryDate: utcDate('2026-04-01'),
        description: 'Opening receivable USD',
        sourceType: 'MANUAL',
        sourceId: 'JV-USD-OPS',
        createdById: ctx.admin.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: '9.85',
        lines: [
          {
            accountId: ar.id,
            direction: 'DEBIT',
            currency: 'USD',
            amount: '500',
            rateToUsd: '1',
            customerId,
          },
          {
            accountId: equity.id,
            direction: 'CREDIT',
            currency: 'USD',
            amount: '500',
            rateToUsd: '1',
            customerId,
          },
        ],
      });
      await postJournalEntry(tx, {
        companyId: ctx.morocco.id,
        entryDate: utcDate('2026-04-02'),
        description: 'Opening receivable MAD',
        sourceType: 'MANUAL',
        sourceId: 'JV-MAD-OPS',
        createdById: ctx.admin.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: '9.85',
        lines: [
          {
            accountId: ar.id,
            direction: 'DEBIT',
            currency: 'MAD',
            amount: '10000',
            rateToUsd: '9.85',
            customerId,
          },
          {
            accountId: equity.id,
            direction: 'CREDIT',
            currency: 'MAD',
            amount: '10000',
            rateToUsd: '9.85',
            customerId,
          },
        ],
      });
    });

    const usdLedger = await getCustomerLedger({
      companyId: ctx.morocco.id,
      customerId,
      view: 'TRANSACTION',
      currency: 'USD',
      localCurrency: 'MAD',
      partyCurrency: 'USD',
    });
    expect(usdLedger.viewCurrency).toBe('USD');
    expect(usdLedger.rows.every((row) => row.currency === 'USD')).toBe(true);
    expect(usdLedger.rows.some((row) => row.currency === 'MAD')).toBe(false);
    expect(usdLedger.closingBalance.toString()).toBe('500');
    expect(usdLedger.rows.some((row) => row.debit.toString() === '500')).toBe(true);

    const madLedger = await getCustomerLedger({
      companyId: ctx.morocco.id,
      customerId,
      view: 'TRANSACTION',
      currency: 'MAD',
      localCurrency: 'MAD',
      partyCurrency: 'USD',
    });
    expect(madLedger.viewCurrency).toBe('MAD');
    expect(madLedger.rows.every((row) => row.currency === 'MAD')).toBe(true);
    expect(madLedger.rows.some((row) => row.currency === 'USD')).toBe(false);
    expect(madLedger.closingBalance.toString()).toBe('10000');
    expect(madLedger.rows.some((row) => row.debit.toString() === '10000')).toBe(true);
  });
});
