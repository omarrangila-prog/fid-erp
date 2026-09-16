import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createPayment, postPayment } from '@/lib/services/payment';
import { getReceivables, getPayables } from '@/lib/services/receivables';
import { reconcile } from '@/lib/services/reconciliation';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { dec, toMoney } from '@/lib/money';

/**
 * Invariant I: a document is settled at the value it was booked at.
 *
 * On 22 August a MAD 342,000 invoice was raised at 9.85 MAD per USD. The
 * customer paid MAD 342,000 in cash on a day the rate was 9.60. The system
 * compared the two in USD, decided the dirhams were now "worth more" than the
 * invoice, cleared only MAD 333,319.80 of the receivable and parked the other
 * MAD 8,680.20 as a customer advance. The customer's statement then showed
 * both an amount owing and a credit, for an invoice paid in full to the
 * dirham. The mirror case — booked at 9.60, paid at 9.85 — was refused
 * outright as an over-allocation.
 *
 * The receivable is cleared at 9.85, whatever the day's rate; the USD the
 * money was worth on the day differs, and that difference is an exchange
 * gain or loss in USD with nothing in MAD, because the MAD that arrived is
 * the MAD that was owed.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let batchId: string;
let contractId: string;

async function control(systemKey: string) {
  const rows = await prisma.$queryRaw<Array<{ usd: string; local: string; native: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd,
           COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local,
           COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS native
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return { usd: toMoney(rows[0]?.usd ?? 0), local: toMoney(rows[0]?.local ?? 0), native: toMoney(rows[0]?.native ?? 0) };
}

async function customerLedger(customerId: string) {
  const rows = await prisma.$queryRaw<Array<{ usd: string; local: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd,
           COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'
      AND jl."customerId" = ${customerId} AND a."subledgerType" = 'CUSTOMER'`;
  return { usd: toMoney(rows[0]?.usd ?? 0), local: toMoney(rows[0]?.local ?? 0) };
}

async function sell(quantity: string, unitPrice: string, rate: string, date: string) {
  const invoice = await createSalesInvoice(
    {
      companyId,
      invoiceDate: utcDate(date),
      customerId: masters.customer.id,
      currency: 'MAD',
      rateToUsd: rate,
      rateLocalPerUsd: rate,
      lines: [{ batchId, warehouseId: masters.warehouses[0].id, quantity, unit: 'KG', unitPrice }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
  return invoice;
}

async function pay(invoiceId: string, amount: string, rate: string, date: string) {
  const cash = await getCashAccount(companyId, 'MAD');
  const receipt = await createReceipt(
    {
      companyId,
      receiptDate: utcDate(date),
      customerId: masters.customer.id,
      currency: 'MAD',
      amount,
      rateToUsd: rate,
      rateLocalPerUsd: rate,
      paymentMethod: 'CASH',
      cashBankAccountId: cash.id,
      allocations: [{ salesInvoiceId: invoiceId, amount }],
    },
    ctx.admin.id,
  );
  return postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-07-01'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      freightAmount: '0',
      lines: [
        { itemId: masters.item.id, quantity: '40000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'FX-1', batchNumber: 'FX-B1' },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  contractId = contract.id;
  await receiveEverything({
    companyId,
    purchaseContractId: contract.id,
    warehouseId: masters.warehouses[0].id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-07-15'),
  });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;
});

describe('a MAD invoice paid in MAD after the rate moved', () => {
  it('clears the invoice exactly and books the USD difference as exchange gain, not as an advance', async () => {
    const invoice = await sell('5700', '60', '9.85', '2026-08-22'); // MAD 342,000
    expect(dec(invoice.totalAmount).toFixed(2)).toBe('342000.00');

    const advancesBefore = await control(ACCOUNT_KEYS.CUSTOMER_ADVANCES);
    const fxBefore = await control(ACCOUNT_KEYS.FX_GAIN_LOSS);

    await pay(invoice.id, '342000', '9.60', '2026-08-22');

    // Nothing owing, nothing in credit.
    const outstanding = (await getReceivables({ companyId, onlyOutstanding: true })).filter(
      (row) => row.invoiceId === invoice.id,
    );
    expect(outstanding).toHaveLength(0);
    const ledger = await customerLedger(masters.customer.id);
    expect(ledger.local.toFixed(2)).toBe('0.00');
    expect(ledger.usd.toFixed(2)).toBe('0.00');
    expect((await control(ACCOUNT_KEYS.CUSTOMER_ADVANCES)).usd.minus(advancesBefore.usd).toFixed(2)).toBe('0.00');

    // MAD 342,000 was worth USD 35,625.00 on the day and USD 34,720.81 when
    // invoiced: USD 904.19 gain, and nothing in the company's own currency.
    const fx = await control(ACCOUNT_KEYS.FX_GAIN_LOSS);
    expect(fx.usd.minus(fxBefore.usd).toFixed(2)).toBe('-904.19');
    expect(fx.local.minus(fxBefore.local).toFixed(2)).toBe('0.00');

    expect((await reconcile(companyId)).checks.filter((c) => !c.passed)).toEqual([]);
  });

  it('accepts full payment when the dirham has weakened, and books the loss', async () => {
    const invoice = await sell('1000', '60', '9.60', '2026-08-25'); // MAD 60,000 = USD 6,250.00
    const fxBefore = await control(ACCOUNT_KEYS.FX_GAIN_LOSS);

    // Refused before this change: "worth" USD 6,091.37 against an invoice
    // "worth" USD 6,250.00. It is the same MAD 60,000.
    await pay(invoice.id, '60000', '9.85', '2026-08-26');

    const outstanding = (await getReceivables({ companyId, onlyOutstanding: true })).filter(
      (row) => row.invoiceId === invoice.id,
    );
    expect(outstanding).toHaveLength(0);
    const ledger = await customerLedger(masters.customer.id);
    expect(ledger.local.toFixed(2)).toBe('0.00');
    expect(ledger.usd.toFixed(2)).toBe('0.00');

    const fx = await control(ACCOUNT_KEYS.FX_GAIN_LOSS);
    expect(fx.usd.minus(fxBefore.usd).toFixed(2)).toBe('158.63');
    expect(fx.local.minus(fxBefore.local).toFixed(2)).toBe('0.00');

    expect((await reconcile(companyId)).checks.filter((c) => !c.passed)).toEqual([]);
  });

  it('still treats genuinely unapplied money as an advance', async () => {
    const invoice = await sell('1000', '60', '9.85', '2026-08-27'); // MAD 60,000
    const advancesBefore = await control(ACCOUNT_KEYS.CUSTOMER_ADVANCES);

    const cash = await getCashAccount(companyId, 'MAD');
    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-08-28'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '70000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'CASH',
        cashBankAccountId: cash.id,
        allocations: [{ salesInvoiceId: invoice.id, amount: '60000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const advances = await control(ACCOUNT_KEYS.CUSTOMER_ADVANCES);
    expect(advances.local.minus(advancesBefore.local).toFixed(2)).toBe('-10000.00');
    expect((await reconcile(companyId)).checks.filter((c) => !c.passed)).toEqual([]);
  });
});

describe('a USD supplier paid from a MAD account', () => {
  it('clears the USD payable exactly and books the MAD difference as exchange loss', async () => {
    const madBank = await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId, currency: 'MAD', accountType: 'BANK', status: 'ACTIVE' },
    });
    const apBefore = await control(ACCOUNT_KEYS.ACCOUNTS_PAYABLE);
    const fxBefore = await control(ACCOUNT_KEYS.FX_GAIN_LOSS);

    // USD 10,000 of a contract booked at 9.85, paid with MAD 101,500 at 10.15.
    const payment = await createPayment(
      {
        companyId,
        paymentDate: utcDate('2026-09-01'),
        vendorId: masters.vendor.id,
        currency: 'MAD',
        amount: '101500',
        rateToUsd: '10.15',
        rateLocalPerUsd: '10.15',
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: madBank.id,
        allocations: [{ purchaseContractId: contractId, amount: '10000' }],
      },
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });

    const ap = await control(ACCOUNT_KEYS.ACCOUNTS_PAYABLE);
    expect(ap.usd.minus(apBefore.usd).toFixed(2)).toBe('10000.00');
    // The payable was carried at MAD 98,500 for that USD 10,000; it cost
    // MAD 101,500 to settle. MAD 3,000 loss, nothing in USD.
    expect(ap.local.minus(apBefore.local).toFixed(2)).toBe('98500.00');
    const fx = await control(ACCOUNT_KEYS.FX_GAIN_LOSS);
    expect(fx.local.minus(fxBefore.local).toFixed(2)).toBe('3000.00');
    expect(fx.usd.minus(fxBefore.usd).toFixed(2)).toBe('0.00');

    const owed = (await getPayables({ companyId, onlyOutstanding: true })).find((row) => row.contractId === contractId);
    expect(owed?.outstandingAmountUsd.toFixed(2)).toBe('150000.00');

    expect((await reconcile(companyId)).checks.filter((c) => !c.passed)).toEqual([]);
  });
});
