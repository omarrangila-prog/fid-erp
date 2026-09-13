import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { dec } from '@/lib/money';

/**
 * A Moroccan invoice with VAT on it has to post.
 *
 * The receivable is one MAD figure; revenue and output tax are two. Converting
 * each to USD separately rounds each separately, and the two sides can land a
 * ten-thousandth of a dollar apart — which used to be refused outright as an
 * unbalanced entry, with the invoice stuck in draft and no way forward.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let batchId: string;
let taxCodeId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.company.update({ where: { id: companyId }, data: { taxEnabled: true } });

  const taxCode = await prisma.taxCode.findFirst({
    where: { companyId, ratePct: { gt: 0 }, appliesTo: { in: ['SALES', 'BOTH'] }, status: 'ACTIVE' },
    orderBy: { code: 'asc' },
  });
  taxCodeId =
    taxCode?.id ??
    (
      await prisma.taxCode.create({
        data: { companyId, code: `VAT20-${Date.now()}`, name: 'VAT 20%', ratePct: '20', appliesTo: 'BOTH' },
      })
    ).id;

  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      freightAmount: '0',
      lines: [{ itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  await receiveEverything({
    companyId,
    purchaseContractId: contract.id,
    warehouseId: masters.warehouses[0].id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-02-01'),
  });

  batchId = (await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;
});

describe('a MAD invoice carrying VAT', () => {
  it('posts, and the entry balances in USD', async () => {
    // MAD 100,000 + 20% at 9.85: 10,152.2843 + 2,030.4569 one way,
    // 12,182.7411 the other.
    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-02-10'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        lines: [
          {
            batchId,
            warehouseId: masters.warehouses[0].id,
            quantity: '10000',
            unit: 'KG',
            unitPrice: '10',
            taxCodeId,
          },
        ],
      },
      ctx.admin.id,
    );

    expect(dec(invoice.subtotal).toFixed(2)).toBe('100000.00');
    expect(dec(invoice.taxAmount).toFixed(2)).toBe('20000.00');

    const posted = await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
    expect(posted.status).toBe('POSTED');

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId, sourceType: 'SALES_INVOICE', sourceId: invoice.id },
      include: { lines: true },
    });

    const debits = entry.lines.reduce((total, line) => total.plus(line.debitUsd), dec(0));
    const credits = entry.lines.reduce((total, line) => total.plus(line.creditUsd), dec(0));
    expect(debits.toFixed(4)).toBe(credits.toFixed(4));

    // The residue lands on a translated line, never on the USD cost lines.
    const cogsLine = entry.lines.find((line) => dec(line.debitUsd).equals('40000'));
    expect(cogsLine).toBeDefined();
  });

  it('reduces the stock it sold', async () => {
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(dec(batch.soldQuantityKg).toFixed(0)).toBe('10000');
    expect(dec(batch.availableQuantityKg).toFixed(0)).toBe('10000');
  });
});
