import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createCreditNote, postCreditNote } from '@/lib/services/credit-note';
import { getFinancialPosition } from '@/lib/services/reports';
import { getReceivables } from '@/lib/services/receivables';
import { reconcile } from '@/lib/services/reconciliation';
import { getCashAccount } from '../helpers';

/**
 * A draft sales invoice, and an over-credited one.
 *
 * Both are ordinary situations that a trading business reaches within its
 * first week, and both used to put the reconciliation report into a false
 * failure — or, worse in the case of the balance sheet, quietly understate a
 * real number. These are the regression tests for that.
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
      companyId: ctx.dubai.id,
      contractReference: 'RES-PO-1',
      contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '3.6725',
      freightAmount: '0',
      lines: [
        {
          itemId: masters.item.id,
          lotNumber: 'RES-LOT',
          batchNumber: 'RES-B001',
          quantity: '10000',
          unit: 'KG',
          unitPrice: '5.00',
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
    warehouseId: masters.warehouse.id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-01-20'),
  });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'RES-B001' } })).id;
});

describe('a draft sales invoice', () => {
  it('reserves stock without removing it from the balance sheet', async () => {
    const before = await getFinancialPosition({ companyId: ctx.dubai.id });

    await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-02-01'),
        customerId: masters.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [
          { batchId, warehouseId: masters.warehouse.id, quantity: '4000', unit: 'KG', unitPrice: '7.00' },
        ],
      },
      ctx.admin.id,
    );

    const after = await getFinancialPosition({ companyId: ctx.dubai.id });

    // The coffee is spoken for, but it is still owned and still in the
    // warehouse. Valuing only what is unreserved understated the asset by the
    // whole of the reservation.
    expect(Number(after.inventoryValueUsd)).toBeCloseTo(Number(before.inventoryValueUsd), 2);
    expect(Number(after.inventoryValueUsd)).toBeCloseTo(50_000, 2);
  });

  it('leaves the reconciliation report clean', async () => {
    const result = await reconcile(ctx.dubai.id);
    const failures = result.checks.filter((check) => !check.passed);
    // A reservation is not a movement. Counting it as one made the stock ledger
    // and batch roll-up checks fail for every unposted invoice in the system.
    expect(failures.map((check) => check.label)).toEqual([]);
  });
});

describe('a customer credited more than they still owe', () => {
  it('keeps the credit balance on the receivables report', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-02-10'),
        customerId: masters.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [
          { batchId, warehouseId: masters.warehouse.id, quantity: '1000', unit: 'KG', unitPrice: '7.00' },
        ],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    // Paid in full…
    const cash = await getCashAccount(ctx.dubai.id, 'USD');
    const receipt = await createReceipt(
      {
        companyId: ctx.dubai.id,
        receiptDate: utcDate('2026-02-20'),
        customerId: masters.customer.id,
        currency: 'USD',
        amount: '7000',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: cash.id,
        allocations: [{ salesInvoiceId: invoice.id, amount: '7000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    // …and then credited, which leaves the customer in credit.
    const note = await createCreditNote(
      {
        companyId: ctx.dubai.id,
        type: 'CUSTOMER',
        creditDate: utcDate('2026-03-01'),
        customerId: masters.customer.id,
        salesInvoiceId: invoice.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        reason: 'Allowance agreed after settlement',
        lines: [{ description: 'Agreed allowance', amount: '900' }],
      },
      ctx.admin.id,
    );
    await postCreditNote({ id: note.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const outstanding = await getReceivables({ companyId: ctx.dubai.id, onlyOutstanding: true });
    const row = outstanding.find((entry) => entry.invoiceId === invoice.id);

    // Filtering to *positive* balances hid this row entirely, while the control
    // account still carried it — money the business owes, invisible on the
    // report that exists to show what is owed.
    expect(row, 'a credit balance must still appear on the receivables report').toBeDefined();
    expect(Number(row!.outstandingAmount)).toBeCloseTo(-900, 2);
  });

  it('still reconciles', async () => {
    const result = await reconcile(ctx.dubai.id);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.label)).toEqual([]);
  });
});
