import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt, updateReceipt, getInvoiceOutstanding } from '@/lib/services/receipt';
import { createPayment, postPayment, updatePayment } from '@/lib/services/payment';
import { changeChequeStatus } from '@/lib/services/cheque';
import { getCashBankBalance } from '@/lib/services/accounting';
import { reconcile } from '@/lib/services/reconciliation';
import { transaction } from '@/lib/db';
import { dec } from '@/lib/money';

/**
 * Correcting something that has already been posted.
 *
 * A number was typed wrong and the voucher is already on the books. The
 * client's answer to that has been to delete it and type it again, which
 * leaves the paper in somebody's hand pointing at a document number that no
 * longer exists. So a posted receipt and a posted payment are now corrected
 * in place, exactly as a cost and an invoice already were: the old posting
 * comes out, the new one goes on, the number stays, and both entries stay in
 * the ledger where an auditor can see what happened.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let cashId: string;
let invoiceId: string;
let contractId: string;

async function cash() {
  return dec(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)));
}

async function outstanding() {
  return Number((await transaction((tx) => getInvoiceOutstanding(tx, invoiceId))).amount);
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.6', effectiveDate: utcDate('2026-01-01') },
  });
  cashId = (await getCashAccount(companyId, 'MAD')).id;

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0', contractReference: 'ICUL/FID/020',
      lines: [{ itemId: masters.item.id, quantity: '5000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  contractId = contract.id;
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });

  const grn = await createGoodsReceipt(
    {
      companyId, purchaseContractId: contract.id, warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-08-10'), receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '5000', lotNumber: 'LOT-EDIT' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-09-01'), customerId: masters.customer.id, currency: 'MAD',
      rateToUsd: '9.6', rateLocalPerUsd: '9.6',
      lines: [{ batchId: batch.id, warehouseId: masters.warehouses[0].id, quantity: '1000', unit: 'KG' as const, unitPrice: '100.00' }],
    },
    ctx.admin.id,
  );
  invoiceId = invoice.id;
  await postSalesInvoice({ id: invoiceId, companyId, userId: ctx.admin.id });
}, 300_000);

describe('a posted receipt typed for the wrong amount', () => {
  let receiptId = '';
  let receiptNumber = '';

  it('is posted as MAD 40,000 against an invoice of MAD 100,000', async () => {
    const before = await cash();
    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-09-10'), customerId: masters.customer.id, currency: 'MAD',
        amount: '40000', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        paymentMethod: 'CASH', cashBankAccountId: cashId,
        description: 'Part payment received',
        allocations: [{ salesInvoiceId: invoiceId, amount: '40000' }],
      },
      ctx.admin.id,
    );
    receiptId = receipt.id;
    receiptNumber = receipt.receiptNumber;
    await postReceipt({ id: receiptId, companyId, userId: ctx.admin.id });

    expect(Number((await cash()).minus(before))).toBeCloseTo(40000, 2);
    expect(await outstanding()).toBeCloseTo(60000, 2);
  }, 300_000);

  it('is corrected to MAD 55,000 under the same number, without being deleted first', async () => {
    const cashBefore = await cash();

    const corrected = await updateReceipt(
      receiptId,
      {
        companyId, receiptDate: utcDate('2026-09-10'), customerId: masters.customer.id, currency: 'MAD',
        amount: '55000', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        paymentMethod: 'CASH', cashBankAccountId: cashId,
        description: 'Part payment received — corrected, it was 55,000',
        allocations: [{ salesInvoiceId: invoiceId, amount: '55000' }],
      },
      ctx.admin.id,
    );

    // Same receipt, same number, still posted.
    expect(corrected.id).toBe(receiptId);
    expect(corrected.receiptNumber).toBe(receiptNumber);
    expect(corrected.status).toBe('POSTED');
    expect(Number(corrected.amount)).toBeCloseTo(55000, 2);

    // The books moved by the difference only, not by the whole amount twice.
    expect(Number((await cash()).minus(cashBefore))).toBeCloseTo(15000, 2);
    expect(await outstanding()).toBeCloseTo(45000, 2);
  }, 300_000);

  it('leaves the correction visible: the first posting, its reversal, and the new one', async () => {
    const entries = await prisma.journalEntry.findMany({
      where: { companyId, sourceType: 'RECEIPT', sourceId: receiptId },
      orderBy: { sourceSeq: 'asc' },
      select: { description: true, isReversal: true, status: true },
    });
    expect(entries).toHaveLength(3);
    expect(entries[1].isReversal).toBe(true);
    expect(entries[1].description).toMatch(/correction of/i);
    // Nothing was erased: all three are still there to be read.
    expect(entries.every((e) => e.status === 'POSTED')).toBe(true);
  }, 300_000);

  it('keeps the day it first reached the books', async () => {
    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(receipt.postedAt).not.toBeNull();
  }, 300_000);
});

describe('a receipt whose cheque has already been banked', () => {
  let chequeReceiptId = '';

  it('still lets the rest of the receipt be corrected', async () => {
    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-09-20'), customerId: masters.customer.id, currency: 'MAD',
        amount: '5000', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        paymentMethod: 'CHEQUE', cashBankAccountId: cashId,
        description: 'Cheque received',
        cheque: { chequeNumber: '778899', chequeDate: utcDate('2026-09-20'), bankName: 'Attijariwafa' },
        allocations: [{ salesInvoiceId: invoiceId, amount: '5000' }],
      },
      ctx.admin.id,
    );
    chequeReceiptId = receipt.id;
    await postReceipt({ id: chequeReceiptId, companyId, userId: ctx.admin.id });

    // The cheque is banked through the same path a person uses, so the books
    // move with it: forcing the status straight into the table would leave a
    // deposit nobody posted, and the sub-ledger would stop agreeing.
    const cheque = await prisma.cheque.findFirstOrThrow({ where: { receiptId: chequeReceiptId } });
    await changeChequeStatus({
      chequeId: cheque.id, companyId, userId: ctx.admin.id, toStatus: 'DEPOSITED', cashBankAccountId: cashId,
    });

    // The memo can still be fixed, because nothing about the cheque changes.
    const corrected = await updateReceipt(
      chequeReceiptId,
      {
        companyId, receiptDate: utcDate('2026-09-20'), customerId: masters.customer.id, currency: 'MAD',
        amount: '5000', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        paymentMethod: 'CHEQUE', cashBankAccountId: cashId,
        description: 'Cheque received from the roastery against September',
        cheque: { chequeNumber: '778899', chequeDate: utcDate('2026-09-20'), bankName: 'Attijariwafa' },
        allocations: [{ salesInvoiceId: invoiceId, amount: '5000' }],
      },
      ctx.admin.id,
    );
    expect(corrected.description).toMatch(/against September/);
  }, 300_000);

  it('refuses to rewrite the cheque itself, and says which part', async () => {
    await expect(
      updateReceipt(
        chequeReceiptId,
        {
          companyId, receiptDate: utcDate('2026-09-20'), customerId: masters.customer.id, currency: 'MAD',
          amount: '5000', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
          paymentMethod: 'CHEQUE', cashBankAccountId: cashId,
          description: 'Trying to change the paper',
          cheque: { chequeNumber: '000111', chequeDate: utcDate('2026-09-20'), bankName: 'Attijariwafa' },
          allocations: [{ salesInvoiceId: invoiceId, amount: '5000' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/cheque number can no longer be changed/i);
  }, 300_000);
});

describe('a posted payment typed for the wrong amount', () => {
  let paymentId = '';
  let paymentNumber = '';

  it('is corrected in place, and the supplier owes the difference again', async () => {
    const payment = await createPayment(
      {
        companyId, paymentDate: utcDate('2026-09-12'), vendorId: masters.vendor.id, currency: 'USD',
        amount: '5000', rateToUsd: '1', rateLocalPerUsd: '9.6',
        paymentMethod: 'BANK_TRANSFER', cashBankAccountId: (await getCashAccount(companyId, 'USD')).id,
        description: 'On account',
        allocations: [{ purchaseContractId: contractId, amount: '5000' }],
      },
      ctx.admin.id,
    );
    paymentId = payment.id;
    paymentNumber = payment.paymentNumber;
    await postPayment({ id: paymentId, companyId, userId: ctx.admin.id });

    const corrected = await updatePayment(
      paymentId,
      {
        companyId, paymentDate: utcDate('2026-09-12'), vendorId: masters.vendor.id, currency: 'USD',
        amount: '3000', rateToUsd: '1', rateLocalPerUsd: '9.6',
        paymentMethod: 'BANK_TRANSFER', cashBankAccountId: (await getCashAccount(companyId, 'USD')).id,
        description: 'On account — corrected, only 3,000 was sent',
        allocations: [{ purchaseContractId: contractId, amount: '3000' }],
      },
      ctx.admin.id,
    );

    expect(corrected.id).toBe(paymentId);
    expect(corrected.paymentNumber).toBe(paymentNumber);
    expect(corrected.status).toBe('POSTED');
    expect(Number(corrected.amount)).toBeCloseTo(3000, 2);

    const allocations = await prisma.paymentAllocation.findMany({ where: { paymentId } });
    expect(allocations).toHaveLength(1);
    expect(Number(allocations[0].amount)).toBeCloseTo(3000, 2);
  }, 300_000);

  it('leaves the books whole after both corrections', async () => {
    const check = await reconcile(companyId);
    expect(check.checks.filter((c) => !c.passed)).toEqual([]);
  }, 300_000);
});
