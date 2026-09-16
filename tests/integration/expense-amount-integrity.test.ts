import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createExpense, postExpense, updateExpense, reverseExpense, stripUnselectedExpenseTax } from '@/lib/services/expense';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getCashBook, getTrialBalanceReport, getGeneralLedger } from '@/lib/services/reports';
import { postCashBankTransfer } from '@/lib/services/cash-transfer';
import { enableTax } from '@/lib/services/tax';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { toMoney, dec, convertToUsd } from '@/lib/money';
import { formatMoney } from '@/lib/format';

/**
 * MAD 7,400 must stay MAD 7,400.
 *
 * With Moroccan TVA registered, omitting a tax code used to apply the 20%
 * default: 7,400 × 1.20 = 8,880 left cash while the expense screen still
 * showed 7,400. Tax is only added when the user names a tax code.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let shipmentId: string;
let cashId: string;
let bankId: string;
let transportId: string;
let standardPurchaseTaxId: string;

async function cashMovement(accountId: string) {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."status" = 'POSTED' AND jl."cashBankAccountId" = ${accountId}`;
  return Number(rows[0]?.bal ?? 0);
}

async function glUsd(systemKey: string) {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${ctx.morocco.id} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return Number(rows[0]?.bal ?? 0);
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.morocco.id, { currency: 'MAD' });

  await enableTax({
    companyId: ctx.morocco.id,
    userId: ctx.admin.id,
    registrationNumber: 'IF-TEST-7400',
  });

  const std = await prisma.taxCode.findFirstOrThrow({
    where: { companyId: ctx.morocco.id, treatment: 'STANDARD', appliesTo: { in: ['PURCHASE', 'BOTH'] } },
  });
  standardPurchaseTaxId = std.id;
  expect(Number(std.ratePct)).toBe(20);

  const contract = await createPurchaseContract(
    {
      companyId: ctx.morocco.id,
      contractReference: 'MA-7400-2026',
      contractDate: utcDate('2026-07-01'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '10',
      freightAmount: '0',
      lines: [
        {
          itemId: masters.item.id,
          lotNumber: 'MA/7400/LOT',
          batchNumber: 'MA-7400-B001',
          quantity: '20000',
          unit: 'KG',
          unitPrice: '5.00',
          bagWeightKg: '60',
        },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
  shipmentId = (await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).id;
  await receiveEverything({
    companyId: ctx.morocco.id,
    purchaseContractId: contract.id,
    warehouseId: masters.warehouses[0].id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-07-20'),
  });

  cashId = (
    await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, currency: 'MAD', accountType: 'CASH' },
    })
  ).id;
  bankId = (
    await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, currency: 'MAD', accountType: 'BANK' },
    })
  ).id;
  transportId = (
    await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, code: 'TRANSPORT' },
    })
  ).id;
});

describe('a plain MAD 7,400 shipment expense', () => {
  it('does not become 8,880 in cash, journal, GL or shipment cost', async () => {
    const cashBefore = await cashMovement(cashId);

    const expense = await createExpense(
      {
        companyId: ctx.morocco.id,
        expenseDate: utcDate('2026-07-28'),
        expenseCategoryId: transportId,
        shipmentId,
        currency: 'MAD',
        amount: '7400',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        cashBankAccountId: cashId,
        paymentMethod: 'CASH',
        kind: 'SHIPMENT',
        description: 'Transport FID-075',
      },
      ctx.admin.id,
    );

    expect(Number(expense.amount)).toBe(7400);
    expect(Number(expense.taxAmount)).toBe(0);
    expect(Number(expense.taxRatePct)).toBe(0);
    expect(expense.taxCodeId).toBeNull();

    await postExpense({ id: expense.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const cashAfter = await cashMovement(cashId);
    expect(cashBefore - cashAfter).toBeCloseTo(7400, 2);
    expect(cashBefore - cashAfter).not.toBeCloseTo(8880, 2);

    const book = await getCashBook({ companyId: ctx.morocco.id, cashBankAccountId: cashId });
    const row = book.rows.find((line) => Number(line.moneyOut) === 7400 || Number(line.moneyOut) === 8880);
    expect(row).toBeTruthy();
    expect(Number(row?.moneyOut)).toBeCloseTo(7400, 2);

    const vat = await glUsd(ACCOUNT_KEYS.VAT_INPUT);
    expect(vat).toBe(0);

    const sheet = await getShipmentCostSheet(ctx.morocco.id, shipmentId);
    const transport = sheet.lines.find((line) => line.expenseId === expense.id);
    expect(transport).toBeTruthy();
    expect(Number(transport?.amount)).toBeCloseTo(7400, 2);
    expect(Number(transport?.taxAmount)).toBe(0);
    expect(Number(transport?.amountUsd)).toBeCloseTo(740, 2);
    expect(sheet.lines.some((line) => Number(line.amount) === 8880)).toBe(false);

    const cashAccount = await prisma.cashBankAccount.findUniqueOrThrow({
      where: { id: cashId },
      select: { glAccountId: true, currency: true },
    });
    expect(cashAccount.currency).toBe('MAD');
    const ledger = await getGeneralLedger({ companyId: ctx.morocco.id, accountId: cashAccount.glAccountId });
    expect(ledger.viewCurrency).toBe('MAD');
    expect(ledger.account.currency).toBe('MAD');
    expect(ledger.rows.some((row) => Number(row.credit) === 7400 && row.sourceId === expense.id)).toBe(true);
    expect(ledger.rows.some((row) => Number(row.credit) === 8880)).toBe(false);
    // Cash book closing must equal Cash in Hand GL closing in MAD.
    expect(Number(book.closingBalance)).toBeCloseTo(Number(ledger.closingBalance), 2);
  });
});

describe('observed FX 9.6000 MAD per USD', () => {
  it('stores MAD 7,400, rate 9.6, USD 770.83 and never overwrites the original', async () => {
    const expense = await createExpense(
      {
        companyId: ctx.morocco.id,
        expenseDate: utcDate('2026-07-28'),
        expenseCategoryId: transportId,
        shipmentId,
        currency: 'MAD',
        amount: '7400',
        rateToUsd: '9.6',
        rateLocalPerUsd: '9.6',
        cashBankAccountId: cashId,
        paymentMethod: 'CASH',
        kind: 'SHIPMENT',
        description: 'Video evidence FX 9.6',
      },
      ctx.admin.id,
    );

    expect(Number(expense.amount)).toBe(7400);
    expect(expense.currency).toBe('MAD');
    expect(Number(expense.rateToUsd)).toBe(9.6);
    expect(Number(expense.amountUsd)).toBeCloseTo(770.8333, 4);
    expect(formatMoney(expense.amountUsd, 'USD')).toBe('USD 770.83');
    expect(Number(expense.amountLocal)).toBe(7400);
    expect(Number(expense.taxAmount)).toBe(0);

    await postExpense({ id: expense.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const book = await getCashBook({ companyId: ctx.morocco.id, cashBankAccountId: cashId });
    const row = book.rows.find((line) => line.sourceId === expense.id);
    expect(Number(row?.moneyOut)).toBeCloseTo(7400, 2);

    const sheet = await getShipmentCostSheet(ctx.morocco.id, shipmentId);
    const line = sheet.lines.find((item) => item.expenseId === expense.id);
    expect(Number(line?.amount)).toBe(7400);
    expect(Number(line?.rateToUsd)).toBe(9.6);
    expect(Number(line?.amountUsd)).toBeCloseTo(770.8333, 4);
    expect(Number(sheet.costPerMtUsd)).toBeCloseTo(Number(sheet.costPerKgUsd) * 1000, 4);
    expect(Number(sheet.costPerMtLocal)).toBeCloseTo(Number(sheet.costPerKgLocal) * 1000, 4);
  });
});

describe('silent 20% TVA already posted as 8,880', () => {
  it('restates the original cash and VAT lines to 7,400 without reversing landed cost', async () => {
    const expense = await createExpense(
      {
        companyId: ctx.morocco.id,
        expenseDate: utcDate('2026-08-03'),
        expenseCategoryId: transportId,
        shipmentId,
        currency: 'MAD',
        amount: '7400',
        rateToUsd: '9.6',
        rateLocalPerUsd: '9.6',
        cashBankAccountId: cashId,
        paymentMethod: 'CASH',
        kind: 'SHIPMENT',
        description: 'Historical silent TVA',
      },
      ctx.admin.id,
    );

    await prisma.expense.update({
      where: { id: expense.id },
      data: {
        taxCodeId: standardPurchaseTaxId,
        taxRatePct: 20,
        taxAmount: 1480,
        taxAmountUsd: convertToUsd('1480', '9.6', 'MAD'),
      },
    });

    await postExpense({ id: expense.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const bookBefore = await getCashBook({ companyId: ctx.morocco.id, cashBankAccountId: cashId });
    expect(Number(bookBefore.rows.find((row) => row.sourceId === expense.id)?.moneyOut)).toBeCloseTo(8880, 2);

    const vatBefore = await glUsd(ACCOUNT_KEYS.VAT_INPUT);
    const sheetBefore = await getShipmentCostSheet(ctx.morocco.id, shipmentId);
    const landedBefore = Number(sheetBefore.lines.find((line) => line.expenseId === expense.id)?.amountUsd);

    await stripUnselectedExpenseTax({
      id: expense.id,
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      reason: 'Tax was never selected on the voucher. Video evidence 7400 became 8880.',
    });

    const restated = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
      select: { amount: true, taxAmount: true, taxCodeId: true, amountUsd: true, currency: true },
    });
    expect(Number(restated.amount)).toBe(7400);
    expect(restated.currency).toBe('MAD');
    expect(Number(restated.taxAmount)).toBe(0);
    expect(restated.taxCodeId).toBeNull();
    expect(Number(restated.amountUsd)).toBeCloseTo(770.8333, 4);

    const bookAfter = await getCashBook({ companyId: ctx.morocco.id, cashBankAccountId: cashId });
    expect(Number(bookAfter.rows.find((row) => row.sourceId === expense.id)?.moneyOut)).toBeCloseTo(7400, 2);
    expect(bookAfter.rows.some((row) => Number(row.moneyOut) === 8880 && row.sourceId === expense.id)).toBe(false);

    const vatAfter = await glUsd(ACCOUNT_KEYS.VAT_INPUT);
    expect(vatAfter).toBeCloseTo(vatBefore - Number(convertToUsd('1480', '9.6', 'MAD')), 2);

    const cashAccount = await prisma.cashBankAccount.findUniqueOrThrow({
      where: { id: cashId },
      select: { glAccountId: true },
    });
    const ledger = await getGeneralLedger({
      companyId: ctx.morocco.id,
      accountId: cashAccount.glAccountId,
      currency: 'MAD',
    });
    expect(ledger.rows.some((row) => row.sourceId === expense.id && Number(row.credit) === 7400)).toBe(true);
    expect(ledger.rows.some((row) => row.sourceId === expense.id && Number(row.credit) === 8880)).toBe(false);

    const sheetAfter = await getShipmentCostSheet(ctx.morocco.id, shipmentId);
    const landedAfter = sheetAfter.lines.find((line) => line.expenseId === expense.id);
    expect(Number(landedAfter?.amount)).toBe(7400);
    expect(Number(landedAfter?.amountUsd)).toBeCloseTo(landedBefore, 4);
    expect(sheetAfter.lines.filter((line) => line.expenseId === expense.id)).toHaveLength(1);

    const journals = await prisma.journalEntry.count({
      where: { sourceType: 'EXPENSE', sourceId: expense.id, isReversal: false, status: 'POSTED' },
    });
    expect(journals).toBe(1);
  });
});

describe('tax only when named', () => {
  it('adds 20% TVA when the user selects the standard code, and keeps 7,400 as the original', async () => {
    const bankBefore = await cashMovement(bankId);

    const expense = await createExpense(
      {
        companyId: ctx.morocco.id,
        expenseDate: utcDate('2026-07-29'),
        expenseCategoryId: transportId,
        shipmentId,
        currency: 'MAD',
        amount: '7400',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        cashBankAccountId: bankId,
        paymentMethod: 'BANK_TRANSFER',
        kind: 'SHIPMENT',
        taxCodeId: standardPurchaseTaxId,
        description: 'Transport with explicit TVA',
      },
      ctx.admin.id,
    );

    expect(Number(expense.amount)).toBe(7400);
    expect(Number(expense.taxAmount)).toBeCloseTo(1480, 2);

    await postExpense({ id: expense.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const bankAfter = await cashMovement(bankId);
    expect(bankBefore - bankAfter).toBeCloseTo(8880, 2);

    const vat = await glUsd(ACCOUNT_KEYS.VAT_INPUT);
    expect(vat).toBeCloseTo(148, 2);

    const sheet = await getShipmentCostSheet(ctx.morocco.id, shipmentId);
    const line = sheet.lines.find((row) => row.expenseId === expense.id);
    expect(Number(line?.amount)).toBeCloseTo(7400, 2);
    expect(Number(line?.taxAmount)).toBeCloseTo(1480, 2);
    expect(Number(line?.amountUsd)).toBeCloseTo(740, 2);
  });
});

describe('unpaid expense', () => {
  it('raises shipment cost and payable without touching cash or bank', async () => {
    const cashBefore = await cashMovement(cashId);
    const bankBefore = await cashMovement(bankId);
    const payableBefore = await glUsd(ACCOUNT_KEYS.ACCOUNTS_PAYABLE);

    const expense = await createExpense(
      {
        companyId: ctx.morocco.id,
        expenseDate: utcDate('2026-07-30'),
        expenseCategoryId: (
          await prisma.expenseCategory.findFirstOrThrow({
            where: { companyId: ctx.morocco.id, code: 'BROKER' },
          })
        ).id,
        shipmentId,
        currency: 'USD',
        amount: '1000',
        rateToUsd: '1',
        rateLocalPerUsd: '10',
        kind: 'SHIPMENT',
        description: 'Unpaid agent commission',
      },
      ctx.admin.id,
    );

    expect(Number(expense.taxAmount)).toBe(0);
    await postExpense({ id: expense.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    expect(await cashMovement(cashId)).toBeCloseTo(cashBefore, 2);
    expect(await cashMovement(bankId)).toBeCloseTo(bankBefore, 2);

    const payable = await glUsd(ACCOUNT_KEYS.ACCOUNTS_PAYABLE);
    expect(payable - payableBefore).toBeCloseTo(-1000, 2);

    const sheet = await getShipmentCostSheet(ctx.morocco.id, shipmentId);
    expect(sheet.lines.some((line) => line.expenseId === expense.id && Number(line.amountUsd) === 1000)).toBe(true);
    expect(sheet.lines.find((line) => line.expenseId === expense.id)?.paid).toBe(false);
  });
});

describe('USD + MAD shipment cost', () => {
  it('keeps purchase USD and local MAD expenses separate and convertible at MAD per 1 USD', async () => {
    const sheet = await getShipmentCostSheet(ctx.morocco.id, shipmentId);
    expect(sheet.localCurrency).toBe('MAD');
    expect(Number(sheet.rateLocalPerUsd)).toBe(10);
    expect(Number(sheet.goodsUsd)).toBeCloseTo(100_000, 2);
    expect(Number(sheet.goodsLocal)).toBeCloseTo(1_000_000, 2);

    const madExpenses = sheet.lines.filter((line) => line.currency === 'MAD');
    expect(
      madExpenses.every((line) =>
        toMoney(line.amountUsd).equals(toMoney(dec(line.amount).dividedBy(line.rateToUsd))),
      ),
    ).toBe(true);
    expect(Number(sheet.totalShipmentCostUsd)).toBeCloseTo(
      Number(sheet.goodsUsd.plus(sheet.expenseUsd)),
      2,
    );
    expect(Number(sheet.totalShipmentCostLocal)).toBeCloseTo(
      Number(sheet.goodsLocal.plus(sheet.expenseLocal)),
      2,
    );
  });
});

describe('cash to bank', () => {
  it('moves MAD 50,000 from cash to bank with no P&L and no amount distortion', async () => {
    const cashBefore = await cashMovement(cashId);
    const bankBefore = await cashMovement(bankId);

    await postCashBankTransfer({
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      transferDate: utcDate('2026-07-31'),
      fromAccountId: cashId,
      toAccountId: bankId,
      amount: '50000',
      description: 'Cash to bank test',
    });

    expect(await cashMovement(cashId)).toBeCloseTo(cashBefore - 50_000, 2);
    expect(await cashMovement(bankId)).toBeCloseTo(bankBefore + 50_000, 2);

    const cashBook = await getCashBook({ companyId: ctx.morocco.id, cashBankAccountId: cashId });
    expect(cashBook.rows.some((row) => Number(row.moneyOut) === 50_000)).toBe(true);
    const bankBook = await getCashBook({ companyId: ctx.morocco.id, cashBankAccountId: bankId });
    expect(bankBook.rows.some((row) => Number(row.moneyIn) === 50_000)).toBe(true);
  });
});

describe('edit and reverse', () => {
  it('does not duplicate the journal when a draft is edited then posted', async () => {
    const expense = await createExpense(
      {
        companyId: ctx.morocco.id,
        expenseDate: utcDate('2026-08-01'),
        expenseCategoryId: transportId,
        shipmentId,
        currency: 'MAD',
        amount: '1000',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        cashBankAccountId: cashId,
        paymentMethod: 'CASH',
        kind: 'SHIPMENT',
        description: 'Draft then edit',
      },
      ctx.admin.id,
    );

    await updateExpense(
      expense.id,
      {
        companyId: ctx.morocco.id,
        expenseDate: utcDate('2026-08-01'),
        expenseCategoryId: transportId,
        shipmentId,
        currency: 'MAD',
        amount: '1100',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        cashBankAccountId: cashId,
        paymentMethod: 'CASH',
        kind: 'SHIPMENT',
        description: 'Draft then edit',
      },
      ctx.admin.id,
    );

    await postExpense({ id: expense.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const posted = await prisma.journalEntry.count({
      where: { sourceType: 'EXPENSE', sourceId: expense.id, status: 'POSTED', isReversal: false },
    });
    expect(posted).toBe(1);

    const book = await getCashBook({ companyId: ctx.morocco.id, cashBankAccountId: cashId });
    expect(book.rows.some((row) => Number(row.moneyOut) === 1100)).toBe(true);
  });

  it('reverses only when asked, and the trial balance still balances', async () => {
    const expense = await createExpense(
      {
        companyId: ctx.morocco.id,
        expenseDate: utcDate('2026-08-02'),
        expenseCategoryId: transportId,
        shipmentId,
        currency: 'MAD',
        amount: '200',
        rateToUsd: '10',
        rateLocalPerUsd: '10',
        cashBankAccountId: cashId,
        paymentMethod: 'CASH',
        kind: 'SHIPMENT',
        description: 'Reverse me',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const before = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id }, select: { status: true } });
    expect(before.status).toBe('POSTED');

    await reverseExpense({
      id: expense.id,
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      reason: 'Entered in error during integrity test',
    });

    const after = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id }, select: { status: true } });
    expect(after.status).toBe('REVERSED');

    const tb = await getTrialBalanceReport({ companyId: ctx.morocco.id });
    expect(tb.isBalanced).toBe(true);
  });
});
