import { beforeAll, describe, expect, it } from 'vitest';
import {
  prisma,
  transaction,
  resetDatabase,
  getContext,
  createMasters,
  utcDate,
  receiveEverything,
} from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import {
  createSalesInvoice,
  postSalesInvoice,
  cancelSalesInvoice,
  type SalesInvoiceInput,
} from '@/lib/services/sales';
import { getCustomerBalance, getSystemAccount, postJournalEntry } from '@/lib/services/accounting';
import { getCustomerLedger } from '@/lib/services/ledger';
import { customerSchema } from '@/lib/validation/masters';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { dec } from '@/lib/money';

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
    expect(cancelled.status).toBe('REVERSED');

    const reversed = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reversed.status).toBe('REVERSED');

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
