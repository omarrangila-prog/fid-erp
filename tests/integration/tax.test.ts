import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createCreditNote, postCreditNote, reverseCreditNote } from '@/lib/services/credit-note';
import { enableTax, listTaxCodes, resolveTaxCode, NO_TAX } from '@/lib/services/tax';
import { getTaxReturn, fileTaxReturn, currentTaxPeriod } from '@/lib/services/tax-return';
import { reconcile } from '@/lib/services/reconciliation';
import { getCompanyProfitSummary } from '@/lib/services/profitability';
import { getReceivables, getPayables } from '@/lib/services/receivables';
import { dec } from '@/lib/money';

/**
 * Tax, end to end.
 *
 * The figures are chosen so every assertion can be checked by hand: 10,000 KG
 * bought at USD 4.00 and sold at USD 6.00, VAT at 5%.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let stdCodeId: string;
let zeroCodeId: string;
let batchId: string;
let invoiceId: string;

/** Balance of a control account, in USD, from the journal itself. */
async function controlUsd(companyId: string, systemKey: string, side: 'debit' | 'credit') {
  const rows = await prisma.$queryRawUnsafe<Array<{ total: string }>>(
    `SELECT COALESCE(SUM(${side === 'debit' ? 'jl."debitUsd" - jl."creditUsd"' : 'jl."creditUsd" - jl."debitUsd"'}), 0)::text AS total
     FROM journal_lines jl
     JOIN journal_entries je ON je."id" = jl."journalEntryId"
     JOIN accounts a ON a."id" = jl."accountId"
     WHERE je."companyId" = $1 AND je."status" = 'POSTED' AND a."systemKey" = $2`,
    companyId,
    systemKey,
  );
  return dec(rows[0]?.total ?? 0);
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id);

  await enableTax({
    companyId: ctx.dubai.id,
    userId: ctx.admin.id,
    registrationNumber: '100123456700003',
  });

  const codes = await listTaxCodes(ctx.dubai.id, 'SALES');
  stdCodeId = codes.find((code) => code.treatment === 'STANDARD')!.id;
  zeroCodeId = codes.find((code) => code.treatment === 'ZERO_RATED')!.id;
});

describe('registration', () => {
  it('seeds the statutory rate for the country the company is in', async () => {
    const standard = await prisma.taxCode.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, treatment: 'STANDARD' },
    });
    expect(Number(standard.ratePct)).toBe(5);
  });

  it('refuses a registration number that is obviously not one', async () => {
    await expect(
      enableTax({ companyId: ctx.dubai.id, userId: ctx.admin.id, registrationNumber: '123' }),
    ).rejects.toThrow(/registration number/i);
  });

  it('charges nothing while a company is unregistered, whatever the client sends', async () => {
    // Morocco has not been registered in this suite. A crafted request naming a
    // real tax code must still produce no tax.
    const resolved = await resolveTaxCode(prisma, {
      companyId: ctx.morocco.id,
      taxEnabled: false,
      taxCodeId: stdCodeId,
      appliesTo: 'SALES',
    });
    expect(resolved).toEqual(NO_TAX);
  });

  it('will not let a sales code be used on a purchase', async () => {
    await expect(
      resolveTaxCode(prisma, {
        companyId: ctx.dubai.id,
        taxEnabled: true,
        taxCodeId: zeroCodeId,
        appliesTo: 'PURCHASE',
      }),
    ).rejects.toThrow(/cannot be used on a purchase/i);
  });
});

describe('a purchase carrying recoverable input tax', () => {
  it('keeps the tax out of what the coffee cost', async () => {
    const purchaseCodes = await listTaxCodes(ctx.dubai.id, 'PURCHASE');
    const purchaseStd = purchaseCodes.find((code) => code.treatment === 'STANDARD')!.id;

    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id,
        contractReference: 'VAT-PO-1',
        contractDate: utcDate('2026-01-05'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        freightAmount: '0',
        lines: [
          {
            itemId: masters.item.id,
            lotNumber: 'VAT-LOT',
            batchNumber: 'VAT-B001',
            quantity: '10000',
            unit: 'KG',
            unitPrice: '4.00',
            bagWeightKg: '60',
            taxCodeId: purchaseStd,
          },
        ],
      },
      ctx.admin.id,
    );

    // 40,000 of coffee, 2,000 of tax.
    expect(Number(contract.totalValue)).toBeCloseTo(40_000, 2);
    expect(Number(contract.taxAmount)).toBeCloseTo(2_000, 2);
    // The cost per kilogram is 4.00, not 4.20: input tax is reclaimable, so
    // letting it into the cost would overstate every margin this batch earns.
    expect(Number(contract.lines[0].unitCostKg)).toBeCloseTo(4, 4);

    await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const batch = await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'VAT-B001' } });
    expect(Number(batch.landedUnitCostUsd)).toBeCloseTo(4, 4);
    batchId = batch.id;

    // Dr Inventory in transit 40,000 / Dr VAT recoverable 2,000 / Cr AP 42,000
    expect(Number(await controlUsd(ctx.dubai.id, 'INVENTORY_IN_TRANSIT', 'debit'))).toBeCloseTo(40_000, 2);
    expect(Number(await controlUsd(ctx.dubai.id, 'VAT_INPUT', 'debit'))).toBeCloseTo(2_000, 2);
    expect(Number(await controlUsd(ctx.dubai.id, 'ACCOUNTS_PAYABLE', 'credit'))).toBeCloseTo(42_000, 2);

    await receiveEverything({
      companyId: ctx.dubai.id,
      purchaseContractId: contract.id,
      warehouseId: masters.warehouse.id,
      userId: ctx.admin.id,
      receiptDate: utcDate('2026-01-20'),
    });
  });

  it('shows the supplier the gross of what they invoiced', async () => {
    const payables = await getPayables({ companyId: ctx.dubai.id, onlyOutstanding: true });
    const row = payables.find((entry) => entry.contractNumber.includes('PO'))!;
    expect(Number(row.outstandingAmountUsd)).toBeCloseTo(42_000, 2);
  });
});

describe('a sale charging output tax', () => {
  it('bills the customer gross and books revenue net', async () => {
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
          {
            batchId,
            warehouseId: masters.warehouse.id,
            quantity: '5000',
            unit: 'KG',
            unitPrice: '6.00',
            taxCodeId: stdCodeId,
          },
        ],
      },
      ctx.admin.id,
    );
    invoiceId = invoice.id;

    // 30,000 of coffee, 1,500 of tax, 31,500 owed.
    expect(Number(invoice.subtotal)).toBeCloseTo(30_000, 2);
    expect(Number(invoice.taxAmount)).toBeCloseTo(1_500, 2);
    expect(Number(invoice.totalAmount)).toBeCloseTo(31_500, 2);

    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    expect(Number(await controlUsd(ctx.dubai.id, 'ACCOUNTS_RECEIVABLE', 'debit'))).toBeCloseTo(31_500, 2);
    expect(Number(await controlUsd(ctx.dubai.id, 'SALES_REVENUE', 'credit'))).toBeCloseTo(30_000, 2);
    expect(Number(await controlUsd(ctx.dubai.id, 'VAT_OUTPUT', 'credit'))).toBeCloseTo(1_500, 2);
  });

  it('keeps tax collected out of revenue in the profitability report', async () => {
    const summary = await getCompanyProfitSummary({ companyId: ctx.dubai.id });
    // Revenue is the goods value; the 1,500 belongs to the authority.
    expect(Number(summary.revenueUsd)).toBeCloseTo(30_000, 2);
    expect(Number(summary.cogsUsd)).toBeCloseTo(20_000, 2);
  });

  it('shows the customer the gross of what they were billed', async () => {
    const receivables = await getReceivables({ companyId: ctx.dubai.id, onlyOutstanding: true });
    expect(Number(receivables[0].outstandingAmountUsd)).toBeCloseTo(31_500, 2);
  });

  it('charges nothing on a zero-rated export', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-02-12'),
        customerId: masters.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [
          {
            batchId,
            warehouseId: masters.warehouse.id,
            quantity: '1000',
            unit: 'KG',
            unitPrice: '6.00',
            taxCodeId: zeroCodeId,
          },
        ],
      },
      ctx.admin.id,
    );
    expect(Number(invoice.taxAmount)).toBe(0);
    expect(Number(invoice.totalAmount)).toBeCloseTo(6_000, 2);
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  });
});

describe('an expense carrying input tax', () => {
  it('pays the supplier gross while expensing only the net', async () => {
    const purchaseCodes = await listTaxCodes(ctx.dubai.id, 'PURCHASE');
    const purchaseStd = purchaseCodes.find((code) => code.treatment === 'STANDARD')!.id;
    const cash = await getCashAccount(ctx.dubai.id, 'AED');

    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, capitaliseByDefault: false },
    });

    const before = await controlUsd(ctx.dubai.id, 'VAT_INPUT', 'debit');

    const expense = await createExpense(
      {
        companyId: ctx.dubai.id,
        expenseDate: utcDate('2026-02-15'),
        expenseCategoryId: category.id,
        currency: 'AED',
        amount: '1000',
        rateToUsd: '3.6725',
        rateLocalPerUsd: '3.6725',
        cashBankAccountId: cash.id,
        taxCodeId: purchaseStd,
      },
      ctx.admin.id,
    );

    expect(Number(expense.taxAmount)).toBeCloseTo(50, 2);
    await postExpense({ id: expense.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const after = await controlUsd(ctx.dubai.id, 'VAT_INPUT', 'debit');
    // AED 50 of tax at 3.6725 is USD 13.62.
    // AED 50 at 3.6725 to the dollar.
    expect(Number(after.minus(before))).toBeCloseTo(13.6147, 3);
  });
});

describe('a credit note that gives back the tax', () => {
  let noteId: string;

  it('credits the customer gross, revenue net, and returns the coffee', async () => {
    const note = await createCreditNote(
      {
        companyId: ctx.dubai.id,
        type: 'CUSTOMER',
        creditDate: utcDate('2026-03-01'),
        customerId: masters.customer.id,
        salesInvoiceId: invoiceId,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        reason: 'Quality claim, 500 KG returned',
        lines: [
          {
            description: '500 KG returned',
            batchId,
            warehouseId: masters.warehouse.id,
            quantityKg: '500',
            unitPrice: '6.00',
            taxCodeId: stdCodeId,
          },
        ],
      },
      ctx.admin.id,
    );
    noteId = note.id;

    expect(Number(note.subtotalAmount)).toBeCloseTo(3_000, 2);
    expect(Number(note.taxAmount)).toBeCloseTo(150, 2);
    expect(Number(note.totalAmount)).toBeCloseTo(3_150, 2);

    const outputBefore = await controlUsd(ctx.dubai.id, 'VAT_OUTPUT', 'credit');
    await postCreditNote({ id: note.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    const outputAfter = await controlUsd(ctx.dubai.id, 'VAT_OUTPUT', 'credit');

    // The 150 charged on those 500 KG goes back.
    expect(Number(outputBefore.minus(outputAfter))).toBeCloseTo(150, 2);
    expect(Number(await controlUsd(ctx.dubai.id, 'SALES_RETURNS', 'debit'))).toBeCloseTo(3_000, 2);
  });

  it('puts the coffee back on the shelf', async () => {
    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, batchId, warehouseId: masters.warehouse.id },
    });
    // 10,000 in, 6,000 sold across two invoices, 500 returned.
    expect(Number(balance.onHandKg)).toBeCloseTo(4_500, 3);
  });

  it('takes the coffee back off the shelf when the note is reversed', async () => {
    await reverseCreditNote({
      id: noteId,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      reason: 'Claim withdrawn by the customer',
    });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, batchId, warehouseId: masters.warehouse.id },
    });
    // Back to 4,000 — reversing the note has to unwind the physical return too,
    // or the inventory account and the stock ledger disagree by the cost of it.
    expect(Number(balance.onHandKg)).toBeCloseTo(4_000, 3);
  });

  it('leaves the books reconciled after all of it', async () => {
    const result = await reconcile(ctx.dubai.id);
    const failures = result.checks.filter((check) => !check.passed);
    expect(failures.map((check) => `${check.label}: ${check.differenceUsd}`)).toEqual([]);
  });
});

describe('the return itself', () => {
  it('agrees with the tax control accounts', async () => {
    const figures = await getTaxReturn({
      companyId: ctx.dubai.id,
      from: utcDate('2026-01-01'),
      to: utcDate('2026-03-31'),
    });

    expect(figures.reconciled).toBe(true);
    // Sub-cent, not zero: the ledger rounds the local equivalent once per
    // journal line while the return rounds once per document line, so the two
    // can differ in the last place. No authority cares about a hundredth of a
    // dirham, and `reconciled` states the tolerance rather than hiding it.
    expect(Math.abs(Number(figures.outputDifference))).toBeLessThan(0.05);
    expect(Math.abs(Number(figures.inputDifference))).toBeLessThan(0.05);
  });

  it('separates a zero-rated export from a standard-rated sale', async () => {
    const figures = await getTaxReturn({
      companyId: ctx.dubai.id,
      from: utcDate('2026-01-01'),
      to: utcDate('2026-03-31'),
    });

    // 6,000 USD of exports at 3.6725 = 22,035 AED, reported with no tax.
    expect(Number(figures.zeroRatedSales)).toBeCloseTo(22_035, 0);
    const zeroBand = figures.sales.find((band) => band.treatment === 'ZERO_RATED');
    expect(Number(zeroBand?.taxLocal ?? -1)).toBe(0);
  });

  it('refuses to file a period whose figures it cannot trace to a posting', async () => {
    // A manual journal straight into the VAT account is exactly the case the
    // check exists for: real money, no document behind it.
    const vatAccount = await prisma.account.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, systemKey: 'VAT_OUTPUT' },
    });
    const cash = await getCashAccount(ctx.dubai.id, 'AED');
    const cashAccount = await prisma.account.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, id: cash.glAccountId! },
    });

    const { postJournalEntry } = await import('@/lib/services/accounting');
    const { transaction } = await import('@/lib/db');
    await transaction((tx) =>
      postJournalEntry(tx, {
        companyId: ctx.dubai.id,
        entryDate: utcDate('2026-03-15'),
        description: 'Unexplained VAT adjustment',
        sourceType: 'MANUAL',
        sourceId: `VAT-ADJ-${Date.now()}`,
        createdById: ctx.admin.id,
        localCurrency: 'AED',
        rateLocalPerUsd: '3.6725',
        lines: [
          { accountId: cashAccount.id, direction: 'DEBIT', currency: 'AED', amount: '500', rateToUsd: '3.6725', description: 'x' },
          { accountId: vatAccount.id, direction: 'CREDIT', currency: 'AED', amount: '500', rateToUsd: '3.6725', description: 'x' },
        ],
      }),
    );

    await expect(
      fileTaxReturn({
        companyId: ctx.dubai.id,
        userId: ctx.admin.id,
        from: utcDate('2026-01-01'),
        to: utcDate('2026-03-31'),
      }),
    ).rejects.toThrow(/does not agree with the ledger/i);
  });
});

describe('the filing period', () => {
  it('offers the quarter that has just ended', () => {
    // Mid-May 2026 sits in Q2, so the return to prepare is Q1.
    const period = currentTaxPeriod(3, new Date('2026-05-14T00:00:00.000Z'));
    expect(period.from.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(period.to.toISOString().slice(0, 10)).toBe('2026-03-31');
  });

  it('offers the month that has just ended when filing monthly', () => {
    const period = currentTaxPeriod(1, new Date('2026-05-14T00:00:00.000Z'));
    expect(period.from.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(period.to.toISOString().slice(0, 10)).toBe('2026-04-30');
  });
});
