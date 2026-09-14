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
  updateSalesInvoice,
  postSalesInvoice,
  reverseSalesInvoice,
  deleteDraftSalesInvoice,
  type SalesInvoiceInput,
} from '@/lib/services/sales';
import { suggestSalesInvoiceNumber } from '@/lib/services/numbering';
import { getCustomerBalance } from '@/lib/services/accounting';
import { getInvoiceOutstanding } from '@/lib/services/receipt';
import { getReceivables } from '@/lib/services/receivables';
import { dec } from '@/lib/money';

/**
 * Sequential invoice numbers that reuse a cancelled number, and a posted
 * invoice that can still be corrected when the weighed KG comes in different.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let batchId: string;
let warehouseId: string;

function saleInput(overrides: Partial<SalesInvoiceInput> = {}): SalesInvoiceInput {
  return {
    companyId: ctx.dubai.id,
    invoiceDate: utcDate('2026-03-01'),
    customerId: masters.customer.id,
    currency: 'USD',
    rateToUsd: '1',
    rateLocalPerUsd: '3.6725',
    lines: [{ batchId, warehouseId, quantity: '1000', unit: 'KG', unitPrice: '6.00' }],
    ...overrides,
  };
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id);
  warehouseId = masters.warehouse.id;

  const contract = await createPurchaseContract(
    {
      companyId: ctx.dubai.id,
      contractReference: 'SI-NUM-PO',
      contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '3.6725',
      freightAmount: '0',
      lines: [
        {
          itemId: masters.item.id,
          lotNumber: 'SI-NUM-LOT',
          batchNumber: 'SI-NUM-B001',
          quantity: '50000',
          unit: 'KG',
          unitPrice: '4.00',
          bagWeightKg: '60',
        },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  await receiveEverything({
    companyId: ctx.dubai.id,
    purchaseContractId: contract.id,
    warehouseId,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-01-20'),
  });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'SI-NUM-B001' } })).id;
});

describe('sales invoice numbering', () => {
  it('issues 000001 then 000002', async () => {
    const first = await createSalesInvoice(saleInput({ invoiceDate: utcDate('2026-03-01') }), ctx.admin.id);
    const second = await createSalesInvoice(saleInput({ invoiceDate: utcDate('2026-03-02') }), ctx.admin.id);

    expect(first.invoiceNumber).toBe('FID-DXB-SI-000001');
    expect(second.invoiceNumber).toBe('FID-DXB-SI-000002');

    await deleteDraftSalesInvoice({ id: first.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    await deleteDraftSalesInvoice({ id: second.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  });

  it('reuses a deleted draft number instead of jumping to the next', async () => {
    const one = await createSalesInvoice(saleInput({ invoiceDate: utcDate('2026-03-03') }), ctx.admin.id);
    const two = await createSalesInvoice(saleInput({ invoiceDate: utcDate('2026-03-04') }), ctx.admin.id);
    expect(one.invoiceNumber).toBe('FID-DXB-SI-000001');
    expect(two.invoiceNumber).toBe('FID-DXB-SI-000002');

    await deleteDraftSalesInvoice({ id: two.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const suggested = await transaction((tx) => suggestSalesInvoiceNumber(tx, ctx.dubai.id));
    expect(suggested).toBe('FID-DXB-SI-000002');

    const reused = await createSalesInvoice(saleInput({ invoiceDate: utcDate('2026-03-05') }), ctx.admin.id);
    expect(reused.invoiceNumber).toBe('FID-DXB-SI-000002');

    await deleteDraftSalesInvoice({ id: one.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    await deleteDraftSalesInvoice({ id: reused.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  });

  it('reuses a reversed invoice number', async () => {
    const invoice = await createSalesInvoice(saleInput({ invoiceDate: utcDate('2026-03-06') }), ctx.admin.id);
    expect(invoice.invoiceNumber).toBe('FID-DXB-SI-000001');
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    await reverseSalesInvoice({
      id: invoice.id,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      reason: 'Customer cancelled',
    });

    const reversed = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reversed.status).toBe('REVERSED');
    expect(reversed.invoiceNumber).toBe('FID-DXB-SI-000001-REV');

    const next = await createSalesInvoice(saleInput({ invoiceDate: utcDate('2026-03-07') }), ctx.admin.id);
    expect(next.invoiceNumber).toBe('FID-DXB-SI-000001');

    await deleteDraftSalesInvoice({ id: next.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  });

  it('accepts a typed number and still fills the next gap automatically', async () => {
    const typed = await createSalesInvoice(
      saleInput({ invoiceDate: utcDate('2026-03-08'), invoiceNumber: '5' }),
      ctx.admin.id,
    );
    expect(typed.invoiceNumber).toBe('FID-DXB-SI-000005');

    const gap = await createSalesInvoice(saleInput({ invoiceDate: utcDate('2026-03-09') }), ctx.admin.id);
    expect(gap.invoiceNumber).toBe('FID-DXB-SI-000001');

    await deleteDraftSalesInvoice({ id: typed.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    await deleteDraftSalesInvoice({ id: gap.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  });
});

describe('editing a posted sales invoice', () => {
  it('corrects weighed KG and restates total, stock and the receivable', async () => {
    const invoice = await createSalesInvoice(saleInput({ invoiceDate: utcDate('2026-04-01') }), ctx.admin.id);
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const posted = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(dec(posted.totalAmount).toString()).toBe('6000');
    const postedAt = posted.postedAt;

    const stockAfterSale = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId, warehouseId } },
    });
    const availableAfterSale = dec(stockAfterSale.availableKg);

    const corrected = await updateSalesInvoice(
      invoice.id,
      saleInput({
        invoiceDate: utcDate('2026-04-01'),
        dueDate: utcDate('2026-04-20'),
        invoiceNumber: posted.invoiceNumber,
        lines: [{ batchId, warehouseId, quantity: '950', unit: 'KG', unitPrice: '6.00' }],
      }),
      ctx.admin.id,
    );

    expect(corrected.status).toBe('POSTED');
    expect(dec(corrected.totalAmount).toString()).toBe('5700');
    expect(corrected.postedAt?.getTime()).toBe(postedAt?.getTime());

    const stockAfterEdit = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId, warehouseId } },
    });
    expect(dec(stockAfterEdit.availableKg).minus(availableAfterSale).toString()).toBe('50');

    const balance = await transaction((tx) => getCustomerBalance(tx, ctx.dubai.id, masters.customer.id));
    expect(balance.toString()).toBe('5700');

    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, invoice.id));
    expect(outstanding.amount.toString()).toBe('5700');

    const receivables = await getReceivables({ companyId: ctx.dubai.id, onlyOutstanding: true });
    const row = receivables.find((r) => r.invoiceId === invoice.id);
    expect(row?.outstandingAmount.toString()).toBe('5700');

    const saved = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(saved.dueDate?.toISOString().slice(0, 10)).toBe('2026-04-20');
  });
});
