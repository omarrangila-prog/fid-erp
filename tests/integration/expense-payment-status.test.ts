import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createPayment, postPayment } from '@/lib/services/payment';
import { getExpenseSettlements } from '@/lib/services/expense-settlement';
import { getOrderCostSheets } from '@/lib/services/order-cost';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { reconcile } from '@/lib/services/reconciliation';
import { getCashBankBalance } from '@/lib/services/accounting';
import { transaction } from '@/lib/db';

/**
 * Paid, partly paid, unpaid — one answer on every screen.
 *
 * The client asked to see paid and unpaid costs clearly, and two screens
 * called a bill "paid" as soon as any payment touched it. And the rule the
 * brief states in so many words: a cost booked unpaid and paid later is in
 * the shipment's cost once. MAD 10,000 stays MAD 10,000; it never becomes
 * MAD 20,000 because it was paid.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let shipmentId: string;
let contractId: string;
let categoryId: string;
let cashId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '10', effectiveDate: utcDate('2026-01-01') } });

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-06-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '10', freightAmount: '0', contractReference: 'ICUL/PAY/1',
      lines: [{ itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'LOT-PAY-1' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  contractId = contract.id;
  shipmentId = (await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } })).shipmentId;
  categoryId = (await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', status: 'ACTIVE' } })).id;
  cashId = (await getCashAccount(companyId, 'MAD')).id;
}, 300_000);

async function cost(amount: string, paidNow: boolean, memo: string) {
  const expense = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-06-10'), expenseCategoryId: categoryId, shipmentId,
      currency: 'MAD', amount, rateToUsd: '10', rateLocalPerUsd: '10', kind: 'SHIPMENT',
      capitaliseToLandedCost: true, paymentMethod: 'BANK_TRANSFER', description: memo,
      ...(paidNow ? { cashBankAccountId: cashId } : {}),
    } as never,
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
  return expense.id;
}

async function pay(expenseId: string, amount: string) {
  const payment = await createPayment(
    {
      companyId, paymentDate: utcDate('2026-06-20'), vendorId: null, currency: 'MAD', amount,
      rateToUsd: '10', rateLocalPerUsd: '10', paymentMethod: 'BANK_TRANSFER', cashBankAccountId: cashId,
      allocations: [{ expenseId, amount }],
    } as never,
    ctx.admin.id,
  );
  await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });
}

async function statusOf(expenseId: string) {
  const expense = await prisma.expense.findUniqueOrThrow({
    where: { id: expenseId },
    include: { cashBankAccount: { select: { name: true } }, vendor: { select: { country: true } } },
  });
  return (await getExpenseSettlements(companyId, [expense])).get(expenseId)!;
}

const shipmentCostUsd = async () => {
  const sheet = (await getOrderCostSheets(companyId)).find((s) => s.contractId === contractId)!;
  return Number(sheet.landedUsd);
};

describe('the MAD 10,000 bill, from unpaid to paid', () => {
  let billId: string;

  it('is in the shipment cost the day it is booked unpaid, and cash has not moved', async () => {
    const cashBefore = Number(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)));
    billId = await cost('10000', false, 'Clearing, not yet paid');

    expect((await statusOf(billId)).status).toBe('UNPAID');
    expect(await shipmentCostUsd()).toBeCloseTo(40_000 + 1_000, 2);
    expect(Number(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)))).toBeCloseTo(cashBefore, 2);
  }, 300_000);

  it('reads Partially paid when some of it is paid — not Paid', async () => {
    await pay(billId, '4000');
    const s = await statusOf(billId);
    expect(s.status).toBe('PARTIAL');
    expect(Number(s.paid)).toBeCloseTo(4_000, 2);
    expect(Number(s.outstanding)).toBeCloseTo(6_000, 2);

    // Both costing screens say the same.
    const order = (await getOrderCostSheets(companyId)).find((x) => x.contractId === contractId)!;
    expect(order.expenses.find((e) => e.expenseId === billId)!.payment).toBe('PARTIAL');
    const sheet = await getShipmentCostSheet(companyId, shipmentId);
    expect(sheet.lines.find((l) => l.expenseId === billId)!.payment).toBe('PARTIAL');
  }, 300_000);

  it('reads Paid when the rest is paid, and the shipment cost is still 10,000, not 20,000', async () => {
    const cashBefore = Number(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)));
    await pay(billId, '6000');
    expect((await statusOf(billId)).status).toBe('PAID');
    expect(await shipmentCostUsd()).toBeCloseTo(41_000, 2);
    expect(Number(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)))).toBeCloseTo(cashBefore - 6_000, 2);
  }, 300_000);
});

describe('paid on the spot', () => {
  it('is Paid, from the account named, and in the cost once', async () => {
    const before = await shipmentCostUsd();
    const id = await cost('2000', true, 'Port charges, paid at the port');
    const s = await statusOf(id);
    expect(s.status).toBe('PAID');
    expect(s.paidFrom).toBeTruthy();
    expect(await shipmentCostUsd()).toBeCloseTo(before + 200, 2);
  }, 300_000);
});

describe('totals across the list', () => {
  it('total = paid + still to pay, exactly, in the company currency', async () => {
    const expenses = await prisma.expense.findMany({
      where: { companyId, status: 'POSTED' },
      include: { cashBankAccount: { select: { name: true } }, vendor: { select: { country: true } } },
    });
    const all = [...(await getExpenseSettlements(companyId, expenses)).values()];
    const gross = all.reduce((t, s) => t + Number(s.grossLocal), 0);
    const paid = all.reduce((t, s) => t + Number(s.paidLocal), 0);
    const owed = all.reduce((t, s) => t + Number(s.outstandingLocal), 0);
    expect(gross).toBeCloseTo(paid + owed, 2);
    expect(gross).toBeCloseTo(12_000, 2);
    expect(owed).toBeCloseTo(0, 2);
  }, 300_000);

  it('leaves the books whole', async () => {
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
  }, 300_000);
});
