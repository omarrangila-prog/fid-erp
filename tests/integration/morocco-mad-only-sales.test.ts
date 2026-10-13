import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { getReceivables } from '@/lib/services/receivables';
import { dec } from '@/lib/money';

/**
 * A Morocco sale is in dirhams, and dirhams are what the customer owes.
 *
 * The company sells locally and keeps its books in MAD, so an invoice needs no
 * foreign-exchange decision: the only rate involved states the invoice in
 * dollars for group reporting. The form used to ask for that same number
 * twice — once as the invoice rate, once as the reporting rate — which made
 * every local sale look like a currency transaction and gave two fields that
 * had to agree with each other.
 *
 * What must never change: the dirham figure the customer owes, and the
 * dirham figure they pay.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let batchId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id,
      currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0',
      lines: [{ itemId: masters.item.id, quantity: '40000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'MAD-1', batchNumber: 'MAD-B1' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  await receiveEverything({
    companyId, purchaseContractId: contract.id, warehouseId: masters.warehouses[0].id,
    userId: ctx.admin.id, receiptDate: utcDate('2026-08-15'),
  });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;
}, 300_000);

/** A dirham invoice: one rate, used for both, as the form now sends it. */
async function madInvoice(rate: string, quantity = '1411.6', price = '80') {
  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-09-01'), customerId: masters.customer.id,
      currency: 'MAD',
      // The same number for both: there is only one rate on a home sale.
      rateToUsd: rate,
      rateLocalPerUsd: rate,
      lines: [{ batchId, warehouseId: masters.warehouses[0].id, quantity, unit: 'KG', unitPrice: price }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
  return invoice;
}

describe('a Morocco sale is in dirhams', () => {
  it('owes the dirham total, whatever the reporting rate happens to be', async () => {
    // The client's own figure: 1,411.6 KG at MAD 80.
    const a = await madInvoice('9.6');
    expect(dec(a.totalAmount).toFixed(2)).toBe('112928.00');

    // A different reporting rate on another invoice of the same goods and
    // price leaves the dirhams identical: the rate is not part of the sale.
    const b = await madInvoice('9.22');
    expect(dec(b.totalAmount).toFixed(2)).toBe('112928.00');

    // Only the dollar translation differs.
    expect(dec(a.totalAmountUsd).toFixed(2)).not.toBe(dec(b.totalAmountUsd).toFixed(2));
    expect(dec(a.totalAmountUsd).toFixed(2)).toBe('11763.33');
    expect(dec(b.totalAmountUsd).toFixed(2)).toBe('12248.16');
  }, 120_000);

  it('is settled in full by the dirhams the customer pays', async () => {
    const invoice = await madInvoice('9.22');
    const cash = await getCashAccount(companyId, 'MAD');

    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-09-10'), customerId: masters.customer.id,
        currency: 'MAD', amount: '112928',
        // Again one number: a dirham receipt against a dirham invoice.
        rateToUsd: '9.22', rateLocalPerUsd: '9.22',
        paymentMethod: 'CASH', cashBankAccountId: cash.id,
        allocations: [{ salesInvoiceId: invoice.id, amount: '112928' }],
      } as never,
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const row = (await getReceivables({ companyId })).find((r) => r.invoiceId === invoice.id);
    expect(dec(row!.outstandingAmount).toFixed(2)).toBe('0.00');
    expect(row!.status).toBe('PAID');
  }, 120_000);

  it('keeps the books balanced in dollars even though the sale is in dirhams', async () => {
    const unbalanced = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT je."id" FROM journal_entries je
      JOIN journal_lines jl ON jl."journalEntryId" = je."id"
      WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'
      GROUP BY je."id"
      HAVING ABS(SUM(jl."debitUsd" - jl."creditUsd")) > 0.005
          OR ABS(SUM(jl."debitLocal" - jl."creditLocal")) > 0.05`;
    expect(unbalanced).toHaveLength(0);
  }, 120_000);
});
