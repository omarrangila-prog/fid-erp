import { describe, it, expect, beforeAll } from 'vitest';
import {
  prisma,
  transaction,
  resetDatabase,
  getContext,
  createMasters,
  getCashAccount,
  utcDate,
  receiveEverything,
} from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt, getInvoiceOutstanding, computeReceiptAmounts } from '@/lib/services/receipt';
import { createPayment, postPayment } from '@/lib/services/payment';
import { changeChequeStatus } from '@/lib/services/cheque';
import { getCustomerBalance, getVendorBalance, getCashBankBalance, getTrialBalance } from '@/lib/services/accounting';
import { getCustomerLedger, getVendorLedger } from '@/lib/services/ledger';
import { setSetting } from '@/lib/services/settings';
import { previewRevaluation, postRevaluation } from '@/lib/services/revaluation';
import { dec } from '@/lib/money';

/**
 * The multi-currency engine, the dual-view ledger and the cheque life cycle.
 *
 * The central guarantee under test: a voucher keeps the rate it was posted at
 * for ever. Changing today's rate table can never restate last month's ledger.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let warehouse: { id: string };
let batchId: string;
let invoiceId: string;
let receiptId: string;

async function purchaseAndReceive(params: {
  companyId: string;
  m: Awaited<ReturnType<typeof createMasters>>;
  reference: string;
  quantityKg: string;
  pricePerKg: string;
  rateLocalPerUsd: string;
  warehouseId: string;
}) {
  const contract = await createPurchaseContract(
    {
      companyId: params.companyId,
      contractReference: params.reference,
      contractDate: utcDate('2026-01-05'),
      vendorId: params.m.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: params.rateLocalPerUsd,
      freightAmount: '0',
      paymentTermDays: 30,
      lines: [
        {
          itemId: params.m.item.id,
          lotNumber: `LOT-${params.reference}`,
          batchNumber: `BAT-${params.reference}`,
          quantity: params.quantityKg,
          unit: 'KG',
          unitPrice: params.pricePerKg,
        },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId: params.companyId, userId: ctx.admin.id });
  await receiveEverything({
    companyId: params.companyId,
    purchaseContractId: contract.id,
    warehouseId: params.warehouseId,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-01-08'),
  });
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  return { contractId: contract.id, batchId: batch.id };
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id, { currency: 'USD' });
  warehouse = masters.warehouses[0];

  const result = await purchaseAndReceive({
    companyId: ctx.dubai.id,
    m: masters,
    reference: 'FX-2001',
    quantityKg: '20000',
    pricePerKg: '4.50',
    rateLocalPerUsd: '3.6725',
    warehouseId: warehouse.id,
  });
  batchId = result.batchId;
});

describe('exchange rate entry', () => {
  it('derives the rate when the user states the USD equivalent', () => {
    // Dubai settles USD invoices in AED at a rate agreed per payment: the user
    // types the USD value they agreed, not a rate.
    const amounts = computeReceiptAmounts({
      amount: '100000',
      currency: 'AED',
      usdEquivalent: '27240',
      localCurrency: 'AED',
      rateLocalPerUsd: '3.6725',
    });
    expect(amounts.amountUsd.toString()).toBe('27240');
    expect(amounts.rateToUsd.toString()).toBe('3.67107195');
    expect(amounts.amountLocal.toString()).toBe('100000');
  });

  it('derives the USD equivalent when the user states the rate', () => {
    const amounts = computeReceiptAmounts({
      amount: '100000',
      currency: 'AED',
      rateToUsd: '3.678',
      localCurrency: 'AED',
      rateLocalPerUsd: '3.678',
    });
    expect(amounts.amountUsd.toString()).toBe('27188.6895');
  });

  it('refuses a foreign-currency receipt with neither a rate nor a USD value', () => {
    expect(() =>
      computeReceiptAmounts({ amount: '100', currency: 'AED', localCurrency: 'AED', rateLocalPerUsd: '3.6725' }),
    ).toThrow(/exchange rate or a USD equivalent/);
  });
});

describe('Dubai — a USD receivable settled in AED', () => {
  it('raises a USD 30,000 receivable', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-01-10'),
        customerId: masters.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [{ batchId, warehouseId: warehouse.id, quantity: '5000', unit: 'KG', unitPrice: '6.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    invoiceId = invoice.id;

    const balance = await transaction((tx) => getCustomerBalance(tx, ctx.dubai.id, masters.customer.id));
    expect(balance.toString()).toBe('30000');
  });

  it('receives AED 100,000 at an agreed USD value and credits exactly that', async () => {
    const aedBank = await getCashAccount(ctx.dubai.id, 'AED');
    const openingCash = await transaction((tx) => getCashBankBalance(tx, ctx.dubai.id, aedBank.id));

    const receipt = await createReceipt(
      {
        companyId: ctx.dubai.id,
        receiptDate: utcDate('2026-01-20'),
        customerId: masters.customer.id,
        currency: 'AED',
        amount: '100000',
        // The rate is derived from the USD value the parties agreed.
        usdEquivalent: '27240',
        rateLocalPerUsd: '3.67107196',
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: aedBank.id,
        reference: 'TT-99120',
        allocations: [{ salesInvoiceId: invoiceId, amount: '27240' }],
      },
      ctx.admin.id,
    );
    receiptId = receipt.id;

    expect(dec(receipt.amount).toString()).toBe('100000');
    expect(dec(receipt.amountUsd).toString()).toBe('27240');
    expect(dec(receipt.amountLocal).toString()).toBe('100000');

    await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    // The customer's USD exposure falls by the agreed USD value.
    const balance = await transaction((tx) => getCustomerBalance(tx, ctx.dubai.id, masters.customer.id));
    expect(balance.toString()).toBe('2760');

    // The AED account rises by exactly the AED that arrived.
    const closingCash = await transaction((tx) => getCashBankBalance(tx, ctx.dubai.id, aedBank.id));
    expect(closingCash.minus(openingCash).toString()).toBe('100000');

    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, invoiceId));
    expect(outstanding.amount.toString()).toBe('2760');
  });

  it('accepts a second payment on the same invoice at a different rate', async () => {
    const aedBank = await getCashAccount(ctx.dubai.id, 'AED');
    const receipt = await createReceipt(
      {
        companyId: ctx.dubai.id,
        receiptDate: utcDate('2026-02-05'),
        customerId: masters.customer.id,
        currency: 'AED',
        amount: '10200',
        // A different rate on a different day, exactly as the business works.
        usdEquivalent: '2760',
        rateLocalPerUsd: '3.6725',
        cashBankAccountId: aedBank.id,
        allocations: [{ salesInvoiceId: invoiceId, amount: '2760' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, invoiceId));
    expect(outstanding.amount.toString()).toBe('0');

    // Both receipts keep their own rate; neither was restated by the other.
    const receipts = await prisma.receipt.findMany({
      where: { companyId: ctx.dubai.id, customerId: masters.customer.id, status: 'POSTED' },
      orderBy: { receiptDate: 'asc' },
    });
    expect(receipts.map((r) => dec(r.rateToUsd).toString())).toEqual(['3.67107195', '3.69565217']);
  });

  it('does not restate a historical receipt when the rate table changes', async () => {
    const before = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    const ledgerBefore = await getCustomerLedger({
      companyId: ctx.dubai.id,
      customerId: masters.customer.id,
      view: 'USD',
      localCurrency: 'AED',
      partyCurrency: 'USD',
    });

    await prisma.exchangeRate.create({
      data: { companyId: ctx.dubai.id, quoteCurrency: 'AED', rate: '4.50000000', effectiveDate: utcDate('2026-03-01') },
    });
    await setSetting(ctx.dubai.id, 'fx.defaultAED', '4.5');

    const after = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(dec(after.rateToUsd).toString()).toBe(dec(before.rateToUsd).toString());
    expect(dec(after.amountUsd).toString()).toBe(dec(before.amountUsd).toString());

    const ledgerAfter = await getCustomerLedger({
      companyId: ctx.dubai.id,
      customerId: masters.customer.id,
      view: 'USD',
      localCurrency: 'AED',
      partyCurrency: 'USD',
    });
    expect(ledgerAfter.closingBalance.toString()).toBe(ledgerBefore.closingBalance.toString());
    expect(ledgerAfter.closingBalance.toString()).toBe('0');
  });
});

describe('the dual-view ledger', () => {
  it('shows USD equivalents in the USD view', async () => {
    const ledger = await getCustomerLedger({
      companyId: ctx.dubai.id,
      customerId: masters.customer.id,
      view: 'USD',
      localCurrency: 'AED',
      partyCurrency: 'USD',
    });

    expect(ledger.viewCurrency).toBe('USD');
    expect(ledger.rows).toHaveLength(3);
    expect(ledger.rows[0].debitUsd.toString()).toBe('30000');
    expect(ledger.rows[1].creditUsd.toString()).toBe('27240');
    expect(ledger.rows[2].creditUsd.toString()).toBe('2760');
    expect(ledger.closingBalance.toString()).toBe('0');
  });

  it('shows the original AED amounts in the local-currency view', async () => {
    const ledger = await getCustomerLedger({
      companyId: ctx.dubai.id,
      customerId: masters.customer.id,
      view: 'LOCAL',
      localCurrency: 'AED',
      partyCurrency: 'USD',
    });

    expect(ledger.viewCurrency).toBe('AED');
    // The receipts show the AED that actually arrived.
    expect(ledger.rows[1].creditLocal.toString()).toBe('100000');
    expect(ledger.rows[2].creditLocal.toString()).toBe('10200');
    // The USD 30,000 invoice at its own captured rate: 30,000 x 3.6725.
    expect(ledger.rows[0].debitLocal.toString()).toBe('110175');
  });
});

describe('cheque life cycle', () => {
  let chequeInvoiceId: string;
  let chequeId: string;

  beforeAll(async () => {
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-03-01'),
        customerId: masters.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [{ batchId, warehouseId: warehouse.id, quantity: '2000', unit: 'KG', unitPrice: '6.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    chequeInvoiceId = invoice.id;
  });

  it('records a cheque as an asset in hand, not as bank cash', async () => {
    const receipt = await createReceipt(
      {
        companyId: ctx.dubai.id,
        receiptDate: utcDate('2026-03-05'),
        customerId: masters.customer.id,
        currency: 'USD',
        amount: '12000',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentMethod: 'CHEQUE',
        cheque: {
          chequeNumber: 'CHQ-889001',
          chequeDate: utcDate('2026-03-20'),
          bankName: 'Mashreq Bank',
        },
        allocations: [{ salesInvoiceId: chequeInvoiceId, amount: '12000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const cheque = await prisma.cheque.findFirstOrThrow({ where: { receiptId: receipt.id } });
    chequeId = cheque.id;
    expect(cheque.status).toBe('RECEIVED');

    const usdBank = await getCashAccount(ctx.dubai.id, 'USD');
    const bankBalance = await transaction((tx) => getCashBankBalance(tx, ctx.dubai.id, usdBank.id));
    expect(bankBalance.toString()).toBe('0');

    // The value sits in Cheques on Hand.
    const rows = await transaction((tx) => getTrialBalance(tx, ctx.dubai.id));
    const chequesOnHand = rows.find((r) => r.code === '1150')!;
    expect(dec(chequesOnHand.debitUsd).minus(dec(chequesOnHand.creditUsd)).toString()).toBe('12000');

    // The receivable is settled from the customer's point of view.
    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, chequeInvoiceId));
    expect(outstanding.amount.toString()).toBe('0');
  });

  it('moves the money into the bank only when the cheque clears', async () => {
    const usdBank = await getCashAccount(ctx.dubai.id, 'USD');

    await changeChequeStatus({
      chequeId,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      toStatus: 'DEPOSITED',
      cashBankAccountId: usdBank.id,
      effectiveDate: utcDate('2026-03-21'),
    });

    // Depositing moves paper, not money.
    let bankBalance = await transaction((tx) => getCashBankBalance(tx, ctx.dubai.id, usdBank.id));
    expect(bankBalance.toString()).toBe('0');

    await changeChequeStatus({
      chequeId,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      toStatus: 'CLEARED',
      cashBankAccountId: usdBank.id,
      effectiveDate: utcDate('2026-03-23'),
    });

    bankBalance = await transaction((tx) => getCashBankBalance(tx, ctx.dubai.id, usdBank.id));
    expect(bankBalance.toString()).toBe('12000');

    const rows = await transaction((tx) => getTrialBalance(tx, ctx.dubai.id));
    const chequesOnHand = rows.find((r) => r.code === '1150');
    expect(dec(chequesOnHand?.debitUsd ?? 0).minus(dec(chequesOnHand?.creditUsd ?? 0)).toString()).toBe('0');
  });

  it('reinstates the receivable when a cheque bounces', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-04-01'),
        customerId: masters.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        lines: [{ batchId, warehouseId: warehouse.id, quantity: '1000', unit: 'KG', unitPrice: '6.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const receipt = await createReceipt(
      {
        companyId: ctx.dubai.id,
        receiptDate: utcDate('2026-04-05'),
        customerId: masters.customer.id,
        currency: 'USD',
        amount: '6000',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentMethod: 'CHEQUE',
        cheque: { chequeNumber: 'CHQ-889002', chequeDate: utcDate('2026-04-20'), bankName: 'Mashreq Bank' },
        allocations: [{ salesInvoiceId: invoice.id, amount: '6000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const balanceBefore = await transaction((tx) => getCustomerBalance(tx, ctx.dubai.id, masters.customer.id));
    const cheque = await prisma.cheque.findFirstOrThrow({ where: { receiptId: receipt.id } });

    await changeChequeStatus({
      chequeId: cheque.id,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      toStatus: 'BOUNCED',
      effectiveDate: utcDate('2026-04-22'),
      reason: 'Insufficient funds',
    });

    // The customer owes the money again — a bounced cheque is not cash.
    const balanceAfter = await transaction((tx) => getCustomerBalance(tx, ctx.dubai.id, masters.customer.id));
    expect(balanceAfter.minus(balanceBefore).toString()).toBe('6000');

    const updated = await prisma.cheque.findUniqueOrThrow({ where: { id: cheque.id } });
    expect(updated.status).toBe('BOUNCED');
    expect(updated.bounceReason).toBe('Insufficient funds');
  });

  it('requires a reason before a cheque can be marked bounced', async () => {
    const cheque = await prisma.cheque.findFirstOrThrow({ where: { chequeNumber: 'CHQ-889001' } });
    await expect(
      changeChequeStatus({
        chequeId: cheque.id,
        companyId: ctx.dubai.id,
        userId: ctx.admin.id,
        toStatus: 'BOUNCED',
      }),
    ).rejects.toThrow(/cannot move from "cleared"/);
  });
});

describe('Morocco — MAD sales against a USD supplier', () => {
  let moroccoMasters: Awaited<ReturnType<typeof createMasters>>;
  let moroccoContractId: string;
  let moroccoBatchId: string;
  let moroccoWarehouse: { id: string };

  beforeAll(async () => {
    moroccoMasters = await createMasters(ctx.morocco.id, { currency: 'MAD' });
    moroccoWarehouse = moroccoMasters.warehouses[0];

    const result = await purchaseAndReceive({
      companyId: ctx.morocco.id,
      m: moroccoMasters,
      reference: 'MA-3001',
      quantityKg: '50000',
      pricePerKg: '0.40',
      rateLocalPerUsd: '9.85',
      warehouseId: moroccoWarehouse.id,
    });
    moroccoContractId = result.contractId;
    moroccoBatchId = result.batchId;
  });

  it('carries the overseas supplier payable in USD', async () => {
    const payable = await transaction((tx) => getVendorBalance(tx, ctx.morocco.id, moroccoMasters.vendor.id));
    expect(payable.toString()).toBe('20000');
  });

  it('sells in MAD and carries the customer receivable in MAD', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.morocco.id,
        invoiceDate: utcDate('2026-01-25'),
        customerId: moroccoMasters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentTermDays: 30,
        lines: [
          { batchId: moroccoBatchId, warehouseId: moroccoWarehouse.id, quantity: '20000', unit: 'KG', unitPrice: '5.91' },
        ],
      },
      ctx.morocco.id === ctx.morocco.id ? ctx.admin.id : ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const posted = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(dec(posted.totalAmount).toString()).toBe('118200'); // MAD
    expect(dec(posted.totalAmountUsd).toString()).toBe('12000'); // USD equivalent

    const balance = await transaction((tx) => getCustomerBalance(tx, ctx.morocco.id, moroccoMasters.customer.id));
    expect(balance.toString()).toBe('118200');
  });

  it('settles the USD supplier from a USD bank account', async () => {
    const usdBank = await getCashAccount(ctx.morocco.id, 'USD');
    const payment = await createPayment(
      {
        companyId: ctx.morocco.id,
        paymentDate: utcDate('2026-02-01'),
        vendorId: moroccoMasters.vendor.id,
        currency: 'USD',
        amount: '12000',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        cashBankAccountId: usdBank.id,
        allocations: [{ purchaseContractId: moroccoContractId, amount: '12000' }],
      },
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const payable = await transaction((tx) => getVendorBalance(tx, ctx.morocco.id, moroccoMasters.vendor.id));
    expect(payable.toString()).toBe('8000');
  });

  it('settles the remaining USD payable out of the MAD bank', async () => {
    const madBank = await getCashAccount(ctx.morocco.id, 'MAD');

    // USD 8,000 is owed. Paying MAD 80,000 at the day's rate of 10.00 settles
    // it exactly in USD, but the payable was booked at 9.85 — so the local
    // books now carry a rate difference that revaluation will recognise.
    const payment = await createPayment(
      {
        companyId: ctx.morocco.id,
        paymentDate: utcDate('2026-02-10'),
        vendorId: moroccoMasters.vendor.id,
        currency: 'MAD',
        amount: '80000',
        rateToUsd: '10.00',
        rateLocalPerUsd: '10.00',
        cashBankAccountId: madBank.id,
        allocations: [{ purchaseContractId: moroccoContractId, amount: '8000' }],
      },
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const payable = await transaction((tx) => getVendorBalance(tx, ctx.morocco.id, moroccoMasters.vendor.id));
    expect(payable.toString()).toBe('0');

    // The MAD that actually left the bank is recorded exactly.
    const bankBalance = await transaction((tx) => getCashBankBalance(tx, ctx.morocco.id, madBank.id));
    expect(bankBalance.toString()).toBe('-80000');
  });

  it('recognises the exchange difference through revaluation', async () => {
    // The USD supplier account is square in USD but carries a MAD difference
    // because the goods were booked at 9.85 and settled at 10.00.
    const preview = await transaction((tx) =>
      previewRevaluation(tx, {
        companyId: ctx.morocco.id,
        asOf: utcDate('2026-02-28'),
        rates: { USD: '1', MAD: '10.00' },
      }),
    );

    const payableLine = preview.lines.find((l) => l.accountCode === '2000');
    expect(payableLine).toBeDefined();
    expect(payableLine!.balanceUsd.toString()).toBe('0');
    // Booked at 9.85 (MAD 78,800) and cleared at 10.00 (MAD 80,000).
    expect(payableLine!.carriedLocal.toString()).toBe('1200');
    expect(payableLine!.differenceLocal.toString()).toBe('-1200');

    const { entry } = await postRevaluation({
      companyId: ctx.morocco.id,
      asOf: utcDate('2026-02-28'),
      rates: { USD: '1', MAD: '10.00' },
      userId: ctx.admin.id,
    });

    // The revaluation is local-only: it does not move the USD position at all.
    const debitsUsd = entry.lines.reduce((a, l) => a.plus(dec(l.debitUsd)), dec(0));
    const creditsUsd = entry.lines.reduce((a, l) => a.plus(dec(l.creditUsd)), dec(0));
    expect(debitsUsd.toString()).toBe('0');
    expect(creditsUsd.toString()).toBe('0');

    // …but it does balance, and it clears, in MAD.
    const debitsLocal = entry.lines.reduce((a, l) => a.plus(dec(l.debitLocal)), dec(0));
    const creditsLocal = entry.lines.reduce((a, l) => a.plus(dec(l.creditLocal)), dec(0));
    expect(debitsLocal.toString()).toBe(creditsLocal.toString());
    expect(debitsLocal.greaterThan(0)).toBe(true);

    const after = await transaction((tx) =>
      previewRevaluation(tx, {
        companyId: ctx.morocco.id,
        asOf: utcDate('2026-02-28'),
        rates: { USD: '1', MAD: '10.00' },
      }),
    );
    expect(after.lines.find((l) => l.accountCode === '2000')).toBeUndefined();
  });

  it('shows the supplier ledger in both USD and MAD', async () => {
    const usdView = await getVendorLedger({
      companyId: ctx.morocco.id,
      vendorId: moroccoMasters.vendor.id,
      view: 'USD',
      localCurrency: 'MAD',
      partyCurrency: 'USD',
    });
    expect(usdView.closingBalance.toString()).toBe('0');

    const localView = await getVendorLedger({
      companyId: ctx.morocco.id,
      vendorId: moroccoMasters.vendor.id,
      view: 'LOCAL',
      localCurrency: 'MAD',
      partyCurrency: 'USD',
    });
    expect(localView.rows.length).toBeGreaterThan(0);
  });

  it('refuses to pay a USD amount out of a MAD account', async () => {
    const madBank = await getCashAccount(ctx.morocco.id, 'MAD');
    await expect(
      createPayment(
        {
          companyId: ctx.morocco.id,
          paymentDate: utcDate('2026-02-20'),
          vendorId: moroccoMasters.vendor.id,
          currency: 'USD',
          amount: '1000',
          rateToUsd: '1',
          rateLocalPerUsd: '9.85',
          cashBankAccountId: madBank.id,
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/MAD account/);
  });

  it('keeps the Morocco trial balance balanced in USD', async () => {
    const rows = await transaction((tx) => getTrialBalance(tx, ctx.morocco.id));
    const debits = rows.reduce((a, r) => a.plus(dec(r.debitUsd)), dec(0));
    const credits = rows.reduce((a, r) => a.plus(dec(r.creditUsd)), dec(0));
    expect(debits.toString()).toBe(credits.toString());
  });
});

describe('allocation limits', () => {
  it('refuses to allocate more than an invoice still owes', async () => {
    const usdBank = await getCashAccount(ctx.dubai.id, 'USD');
    await expect(
      createReceipt(
        {
          companyId: ctx.dubai.id,
          receiptDate: utcDate('2026-05-01'),
          customerId: masters.customer.id,
          currency: 'USD',
          amount: '100000',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          cashBankAccountId: usdBank.id,
          allocations: [{ salesInvoiceId: invoiceId, amount: '5000' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/exceeds the 0.00 still outstanding/);
  });

  it('refuses to allocate more than the receipt is worth', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-05-02'),
        customerId: masters.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        lines: [{ batchId, warehouseId: warehouse.id, quantity: '1000', unit: 'KG', unitPrice: '6.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const usdBank = await getCashAccount(ctx.dubai.id, 'USD');
    await expect(
      createReceipt(
        {
          companyId: ctx.dubai.id,
          receiptDate: utcDate('2026-05-03'),
          customerId: masters.customer.id,
          currency: 'USD',
          amount: '100',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          cashBankAccountId: usdBank.id,
          allocations: [{ salesInvoiceId: invoice.id, amount: '2000' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/only worth USD 100/);
  });
});
