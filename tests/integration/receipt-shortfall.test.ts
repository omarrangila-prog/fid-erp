import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import {
  createReceipt,
  postReceipt,
  reverseReceipt,
  type ReceiptOverpayment,
  type SettlementShortfall,
} from '@/lib/services/receipt';
import { getReceivables } from '@/lib/services/receivables';
import { ACCOUNT_KEYS, ROUND_OFF_LIMIT, TIP_LIMIT } from '@/lib/constants';
import { dec, toMoney } from '@/lib/money';

/**
 * A customer settles MAD 112,928 with MAD 112,920.
 *
 * The eight dirhams are a real shortfall, and the client decides what happens
 * to them: left owed (the invoice stays part paid), or written off, in which
 * case the invoice clears exactly and the giveaway lands on the profit and
 * loss rather than sitting as a debtor nobody will collect.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let batchId: string;

async function control(systemKey: string) {
  const rows = await prisma.$queryRaw<Array<{ local: string }>>`
    SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return toMoney(rows[0]?.local ?? 0);
}

/** Every posted entry balances, in both currencies. */
async function unbalanced() {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT je."id" FROM journal_entries je
    JOIN journal_lines jl ON jl."journalEntryId" = je."id"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'
    GROUP BY je."id"
    HAVING ABS(SUM(jl."debit" - jl."credit")) > 0.005
        OR ABS(SUM(jl."debitUsd" - jl."creditUsd")) > 0.005
        OR ABS(SUM(jl."debitLocal" - jl."creditLocal")) > 0.005`;
  return rows.length;
}

async function invoiceFor(total: string) {
  // 1,411.6 KG at MAD 80 is exactly the client's MAD 112,928.
  const invoice = await createSalesInvoice(
    {
      companyId,
      invoiceDate: utcDate('2026-09-01'),
      customerId: masters.customer.id,
      currency: 'MAD',
      rateToUsd: '9.6',
      rateLocalPerUsd: '9.6',
      lines: [{ batchId, warehouseId: masters.warehouses[0].id, quantity: '1411.6', unit: 'KG', unitPrice: '80' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
  expect(dec(invoice.totalAmount).toFixed(2)).toBe(total);
  return invoice;
}

async function receive(
  invoiceId: string,
  amount: string,
  shortfall: SettlementShortfall,
  writeOffReason?: string,
) {
  const cash = await getCashAccount(companyId, 'MAD');
  const receipt = await createReceipt(
    {
      companyId,
      receiptDate: utcDate('2026-09-10'),
      customerId: masters.customer.id,
      currency: 'MAD',
      amount,
      rateToUsd: '9.6',
      rateLocalPerUsd: '9.6',
      paymentMethod: 'CASH',
      cashBankAccountId: cash.id,
      allocations: [{ salesInvoiceId: invoiceId, amount, shortfall, writeOffReason }],
    },
    ctx.admin.id,
  );
  await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });
  return receipt;
}

const outstandingOn = async (invoiceId: string) => {
  const row = (await getReceivables({ companyId })).find((r) => r.invoiceId === invoiceId);
  return { amount: row?.outstandingAmount ?? dec(0), status: row?.status };
};

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-08-01'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.6',
      freightAmount: '0',
      lines: [
        { itemId: masters.item.id, quantity: '40000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'SF-1', batchNumber: 'SF-B1' },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  await receiveEverything({
    companyId,
    purchaseContractId: contract.id,
    warehouseId: masters.warehouses[0].id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-08-15'),
  });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;
}, 300_000);

describe('MAD 112,928 settled with MAD 112,920', () => {
  it('keeps the eight dirhams owed when that is what the user chose', async () => {
    const invoice = await invoiceFor('112928.00');
    await receive(invoice.id, '112920', 'KEEP_OUTSTANDING');

    const after = await outstandingOn(invoice.id);
    expect(after.amount.toFixed(2)).toBe('8.00');
    // Still unpaid, as the client reads it — and part paid in detail.
    expect(after.status).toBe('PARTIAL');
    // Nothing was written off.
    expect((await control(ACCOUNT_KEYS.SETTLEMENT_ROUNDING)).toFixed(2)).toBe('0.00');
    expect(await unbalanced()).toBe(0);
  }, 120_000);

  it('writes the eight dirhams off as a round-off: the invoice clears and the giveaway is on the profit and loss', async () => {
    const invoice = await invoiceFor('112928.00');
    const before = await control(ACCOUNT_KEYS.SETTLEMENT_ROUNDING);

    await receive(invoice.id, '112920', 'ROUND_OFF');

    const after = await outstandingOn(invoice.id);
    expect(after.amount.toFixed(2)).toBe('0.00');
    expect(after.status).toBe('PAID');
    // The eight dirhams are an expense, not a debtor.
    expect((await control(ACCOUNT_KEYS.SETTLEMENT_ROUNDING)).minus(before).toFixed(2)).toBe('8.00');
    expect(await unbalanced()).toBe(0);
  }, 120_000);

  it('sends an other adjustment to its own account, with the reason on the entry', async () => {
    const invoice = await invoiceFor('112928.00');
    const before = await control(ACCOUNT_KEYS.SETTLEMENT_ADJUSTMENT);

    await receive(invoice.id, '112920', 'OTHER_ADJUSTMENT', 'Bank charge deducted by the customer');

    expect((await outstandingOn(invoice.id)).status).toBe('PAID');
    expect((await control(ACCOUNT_KEYS.SETTLEMENT_ADJUSTMENT)).minus(before).toFixed(2)).toBe('8.00');
    // Round-off stays clean: the two kinds are told apart in the books.
    const line = await prisma.journalLine.findFirst({
      where: { salesInvoiceId: invoice.id, account: { systemKey: ACCOUNT_KEYS.SETTLEMENT_ADJUSTMENT } },
      select: { description: true },
    });
    expect(line?.description).toContain('Bank charge deducted by the customer');
    expect(await unbalanced()).toBe(0);
  }, 120_000);

  it('refuses a large round-off with no reason, and takes it with one', async () => {
    const invoice = await invoiceFor('112928.00');
    const tooMuch = dec(112928).minus(ROUND_OFF_LIMIT).minus(1).toFixed(2);

    await expect(receive(invoice.id, tooMuch, 'ROUND_OFF')).rejects.toThrow(/not a rounding|more than a rounding/i);
    // Nothing was written off by the attempt.
    expect((await outstandingOn(invoice.id)).status).toBe('UNPAID');

    await receive(invoice.id, tooMuch, 'ROUND_OFF', 'Settled short by agreement with the customer');
    expect((await outstandingOn(invoice.id)).status).toBe('PAID');
    expect(await unbalanced()).toBe(0);
  }, 120_000);

  it('refuses an other adjustment with no reason at all', async () => {
    const invoice = await invoiceFor('112928.00');
    await expect(receive(invoice.id, '112920', 'OTHER_ADJUSTMENT')).rejects.toThrow(/what the .* is for|Say what/i);
    expect((await outstandingOn(invoice.id)).status).toBe('UNPAID');
  }, 120_000);

  it('refuses to write off anything on an invoice the money settles in full', async () => {
    const invoice = await invoiceFor('112928.00');
    await expect(receive(invoice.id, '112928', 'ROUND_OFF')).rejects.toThrow(/settled in full|nothing to write off/i);
  }, 120_000);

  it('puts the debt back when the receipt is reversed', async () => {
    const invoice = await invoiceFor('112928.00');
    const before = await control(ACCOUNT_KEYS.SETTLEMENT_ROUNDING);
    const receipt = await receive(invoice.id, '112920', 'ROUND_OFF');
    expect((await outstandingOn(invoice.id)).status).toBe('PAID');

    await reverseReceipt({ id: receipt.id, companyId, userId: ctx.admin.id, reason: 'Paid by the wrong customer' });

    // The whole invoice is owed again and the write-off is undone with it:
    // reversing a receipt must not leave eight dirhams of expense behind.
    const after = await outstandingOn(invoice.id);
    expect(after.amount.toFixed(2)).toBe('112928.00');
    expect(after.status).toBe('UNPAID');
    expect((await control(ACCOUNT_KEYS.SETTLEMENT_ROUNDING)).minus(before).toFixed(2)).toBe('0.00');
    expect(await unbalanced()).toBe(0);
  }, 120_000);
});

/**
 * The other direction: the customer pays MORE than the invoice.
 *
 * Unasked-for money is theirs until somebody says otherwise, so it is an
 * advance by default. When they tell us to keep it, it is a tip: income, and
 * emphatically not a balance the company owes back.
 */
async function overpay(
  invoiceId: string,
  invoiceAmount: string,
  received: string,
  overpayment: ReceiptOverpayment,
  tipReason?: string,
) {
  const cash = await getCashAccount(companyId, 'MAD');
  const receipt = await createReceipt(
    {
      companyId,
      receiptDate: utcDate('2026-09-10'),
      customerId: masters.customer.id,
      currency: 'MAD',
      amount: received,
      rateToUsd: '9.6',
      rateLocalPerUsd: '9.6',
      paymentMethod: 'CASH',
      cashBankAccountId: cash.id,
      allocations: [{ salesInvoiceId: invoiceId, amount: invoiceAmount, shortfall: 'KEEP_OUTSTANDING' }],
      keepRemainderAsAdvance: true,
      overpayment,
      tipReason,
    },
    ctx.admin.id,
  );
  await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });
  return receipt;
}

describe('MAD 112,928 settled with MAD 112,936', () => {
  it('holds the extra eight dirhams for the customer by default', async () => {
    const invoice = await invoiceFor('112928.00');
    const before = await control(ACCOUNT_KEYS.CUSTOMER_ADVANCES);

    await overpay(invoice.id, '112928', '112936', 'ADVANCE');

    const after = await outstandingOn(invoice.id);
    expect(after.amount.toFixed(2)).toBe('0.00');
    expect(after.status).toBe('PAID');
    // A liability: credited, so the movement is negative in debit-less-credit.
    expect((await control(ACCOUNT_KEYS.CUSTOMER_ADVANCES)).minus(before).toFixed(2)).toBe('-8.00');
    // Not income.
    expect((await control(ACCOUNT_KEYS.TIPS_RECEIVED)).toFixed(2)).toBe('0.00');
    expect(await unbalanced()).toBe(0);
  }, 120_000);

  it('takes the extra as income when the customer gives it, and owes nothing back', async () => {
    const invoice = await invoiceFor('112928.00');
    const beforeTips = await control(ACCOUNT_KEYS.TIPS_RECEIVED);
    const beforeAdvances = await control(ACCOUNT_KEYS.CUSTOMER_ADVANCES);

    await overpay(invoice.id, '112928', '112936', 'TIP');

    expect((await outstandingOn(invoice.id)).status).toBe('PAID');
    // Income is a credit, hence negative on debit-less-credit.
    expect((await control(ACCOUNT_KEYS.TIPS_RECEIVED)).minus(beforeTips).toFixed(2)).toBe('-8.00');
    // The crucial half: a tip is not held for the customer.
    expect((await control(ACCOUNT_KEYS.CUSTOMER_ADVANCES)).minus(beforeAdvances).toFixed(2)).toBe('0.00');
    expect(await unbalanced()).toBe(0);
  }, 120_000);

  it('refuses a large tip with no reason, and takes it with one', async () => {
    const invoice = await invoiceFor('112928.00');
    const over = dec(112928).plus(TIP_LIMIT).plus(1).toFixed(2);
    const before = await control(ACCOUNT_KEYS.TIPS_RECEIVED);

    await expect(overpay(invoice.id, '112928', over, 'TIP')).rejects.toThrow(/more than a rounding to keep as a tip/i);
    // The refusal booked nothing.
    expect((await control(ACCOUNT_KEYS.TIPS_RECEIVED)).minus(before).toFixed(2)).toBe('0.00');

    await overpay(invoice.id, '112928', over, 'TIP', 'Customer rounded the payment up as a bonus');
    expect((await control(ACCOUNT_KEYS.TIPS_RECEIVED)).minus(before).toFixed(2)).toBe(
      dec(TIP_LIMIT).plus(1).negated().toFixed(2),
    );
    expect(await unbalanced()).toBe(0);
  }, 120_000);

  it('puts a tip back when the receipt is reversed', async () => {
    const invoice = await invoiceFor('112928.00');
    const before = await control(ACCOUNT_KEYS.TIPS_RECEIVED);
    const receipt = await overpay(invoice.id, '112928', '112936', 'TIP');

    await reverseReceipt({ id: receipt.id, companyId, userId: ctx.admin.id, reason: 'Paid by the wrong customer' });

    expect((await outstandingOn(invoice.id)).amount.toFixed(2)).toBe('112928.00');
    // The company does not keep income on a payment it gave back.
    expect((await control(ACCOUNT_KEYS.TIPS_RECEIVED)).minus(before).toFixed(2)).toBe('0.00');
    expect(await unbalanced()).toBe(0);
  }, 120_000);
});
