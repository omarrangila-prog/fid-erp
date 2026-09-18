import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { getSalesRegister, getPurchaseRegister } from '@/lib/services/reports';
import { getReceivables } from '@/lib/services/receivables';
import { dec } from '@/lib/money';

/**
 * The sales and purchase registers.
 *
 * Both answer a question about documents rather than about the ledger: which
 * invoice, to whom, for how much coffee, and how much of it is still owed.
 * They have to agree with the receivables report and with the warehouse, or
 * the client has two screens telling them different things.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let contractId: string;
let invoiceId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.85', effectiveDate: utcDate('2026-01-01') },
  });

  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-02-02'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      freightAmount: '2000',
      lines: [{ itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  contractId = contract.id;
  await postPurchaseContract({ id: contractId, companyId, userId: ctx.admin.id });

  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contractId } });
  // Only half of it has landed.
  const grn = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: contractId,
      warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-03-01'),
      receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '10000', lotNumber: 'REG-LOT-1' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  const invoice = await createSalesInvoice(
    {
      companyId,
      invoiceDate: utcDate('2026-03-10'),
      dueDate: utcDate('2026-04-10'),
      customerId: masters.customer.id,
      currency: 'MAD',
      rateToUsd: '9.85',
      rateLocalPerUsd: '9.85',
      lines: [
        {
          batchId: batch.id,
          warehouseId: masters.warehouses[0].id,
          quantity: '4000',
          unit: 'KG',
          unitPrice: '50.00',
        },
      ],
    },
    ctx.admin.id,
  );
  invoiceId = invoice.id;
  await postSalesInvoice({ id: invoiceId, companyId, userId: ctx.admin.id });
}, 300_000);

describe('the sales register', () => {
  it('lists the invoice with its coffee, its value and its cost', async () => {
    const rows = await getSalesRegister({ companyId });
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.customerName).toBe(masters.customer.customerName);
    expect(row.quantityKg.toString()).toBe('4000');
    expect(row.total.toString()).toBe('200000');
    expect(row.currency).toBe('MAD');
    // Gross profit is the sale less the cost frozen on the line.
    expect(Number(row.grossProfitUsd)).toBeCloseTo(Number(row.totalUsd) - Number(row.costOfGoodsUsd), 4);
    expect(row.status).toBe('Unpaid');
  }, 180_000);

  it('agrees with the receivables report about what is outstanding', async () => {
    const [register] = await getSalesRegister({ companyId });
    const receivables = await getReceivables({ companyId, onlyOutstanding: true });
    const match = receivables.find((r) => r.invoiceId === invoiceId)!;
    expect(register.outstanding.toString()).toBe(dec(match.outstandingAmount).toString());
  }, 180_000);

  it('follows a part payment through to Part paid', async () => {
    const cash = await getCashAccount(companyId, 'MAD');
    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-03-20'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '50000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'CASH',
        cashBankAccountId: cash.id,
        allocations: [{ salesInvoiceId: invoiceId, amount: '50000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const [row] = await getSalesRegister({ companyId });
    expect(row.settled.toString()).toBe('50000');
    expect(row.outstanding.toString()).toBe('150000');
    expect(row.status).toBe('Part paid');
  }, 300_000);

  it('honours the period asked for', async () => {
    const before = await getSalesRegister({ companyId, from: utcDate('2026-01-01'), to: utcDate('2026-03-09') });
    expect(before).toHaveLength(0);
    const after = await getSalesRegister({ companyId, from: utcDate('2026-03-10'), to: utcDate('2026-03-31') });
    expect(after).toHaveLength(1);
  }, 180_000);
});

describe('the purchase register', () => {
  it('lists the contract with its goods, freight and total', async () => {
    const rows = await getPurchaseRegister({ companyId });
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.vendorName).toBe(masters.vendor.vendorName);
    expect(row.quantityKg.toString()).toBe('20000');
    expect(row.goodsValue.toString()).toBe('80000');
    expect(row.freight.toString()).toBe('2000');
    expect(row.total.toString()).toBe('82000');
  }, 180_000);

  it('says how much has actually landed, not how much was ordered', async () => {
    const [row] = await getPurchaseRegister({ companyId });
    // 20,000 KG bought, 10,000 KG received so far.
    expect(row.quantityKg.toString()).toBe('20000');
    expect(row.receivedKg.toString()).toBe('10000');
  }, 180_000);

  it('shows nothing paid until a payment is posted', async () => {
    const [row] = await getPurchaseRegister({ companyId });
    expect(row.settled.toString()).toBe('0');
    expect(row.outstanding.toString()).toBe('82000');
    expect(row.status).toBe('Unpaid');
  }, 180_000);

  it('honours the period asked for', async () => {
    const outside = await getPurchaseRegister({ companyId, from: utcDate('2026-04-01') });
    expect(outside).toHaveLength(0);
  }, 180_000);
});
