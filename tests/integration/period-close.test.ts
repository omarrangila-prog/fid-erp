import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { setClosedUntil, getClosedUntil } from '@/lib/services/period';

/**
 * A closed period must be closed to everything. The check lives in the posting
 * engine, so these tests come at it through several different document types —
 * if one of them slips past, the guard is in the wrong place.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let batchId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id);

  const contract = await createPurchaseContract(
    {
      companyId: ctx.dubai.id, contractReference: 'PC-1', contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
      freightAmount: '0',
      lines: [{ itemId: masters.item.id, lotNumber: 'PC-LOT', batchNumber: 'PC-B001',
                quantity: '30000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  await receiveEverything({
    companyId: ctx.dubai.id, purchaseContractId: contract.id,
    warehouseId: masters.warehouse.id, userId: ctx.admin.id, receiptDate: utcDate('2026-01-20'),
  });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'PC-B001' } })).id;
});

afterAll(async () => {
  await setClosedUntil(ctx.dubai.id, null);
});

function saleOn(date: Date) {
  return createSalesInvoice(
    {
      companyId: ctx.dubai.id, invoiceDate: date, customerId: masters.customer.id,
      currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
      lines: [{ batchId, warehouseId: masters.warehouse.id, quantity: '100', unit: 'KG', unitPrice: '6.00' }],
    },
    ctx.admin.id,
  );
}

describe('closing an accounting period', () => {
  it('records the close date', async () => {
    await setClosedUntil(ctx.dubai.id, utcDate('2026-02-28'));
    const closed = await prisma.$transaction((tx) => getClosedUntil(tx, ctx.dubai.id));
    expect(closed?.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('refuses a sale dated inside the closed period', async () => {
    const invoice = await saleOn(utcDate('2026-02-10'));
    await expect(
      postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ).rejects.toThrow(/closed/i);
  });

  it('refuses a sale dated exactly on the close date', async () => {
    const invoice = await saleOn(utcDate('2026-02-28'));
    await expect(
      postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ).rejects.toThrow(/closed/i);
  });

  it('allows a sale dated after the close date', async () => {
    const invoice = await saleOn(utcDate('2026-03-01'));
    await expect(
      postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ).resolves.toBeTruthy();
  });

  it('refuses a receipt inside the closed period too', async () => {
    const bank = await getCashAccount(ctx.dubai.id, 'USD');
    const receipt = await createReceipt(
      {
        companyId: ctx.dubai.id, receiptDate: utcDate('2026-02-15'), customerId: masters.customer.id,
        currency: 'USD', amount: '100', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        paymentMethod: 'BANK_TRANSFER', cashBankAccountId: bank.id,
      },
      ctx.admin.id,
    );
    await expect(
      postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ).rejects.toThrow(/closed/i);
  });

  it('refuses a purchase contract inside the closed period', async () => {
    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id, contractReference: 'PC-CLOSED', contractDate: utcDate('2026-02-02'),
        vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        freightAmount: '0',
        lines: [{ itemId: masters.item.id, lotNumber: 'PC-LOT-2', batchNumber: 'PC-B002',
                  quantity: '1000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
      },
      ctx.admin.id,
    );
    await expect(
      postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ).rejects.toThrow(/closed/i);
  });

  it('does not close the other company', async () => {
    const moroccoClosed = await prisma.$transaction((tx) => getClosedUntil(tx, ctx.morocco.id));
    expect(moroccoClosed).toBeNull();
  });

  it('lets everything post again once reopened', async () => {
    await setClosedUntil(ctx.dubai.id, null);
    const invoice = await saleOn(utcDate('2026-02-10'));
    await expect(
      postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ).resolves.toBeTruthy();
  });
});
