import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, utcDate } from '../helpers';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getPayables } from '@/lib/services/receivables';
import { expenseSchema } from '@/lib/validation/finance';
import { createPayment, postPayment } from '@/lib/services/payment';
import { reconcile } from '@/lib/services/reconciliation';
import { getCashAccount } from '../helpers';
import { dec } from '@/lib/money';

/**
 * A cost incurred but not yet paid.
 *
 * This is the ordinary supplier bill: the service is rendered, the invoice
 * arrives, the money leaves later. It has to reach the ledger as a payable
 * owed to a named party, because a payable owed to nobody cannot be aged,
 * cannot appear on a supplier statement and cannot be settled by a payment.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let vendorId: string;
let categoryId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  const vendor = await prisma.vendor.create({
    data: {
      companyId: ctx.morocco.id,
      vendorCode: 'SUP-BILL',
      vendorName: 'Office Landlord SARL',
      country: 'Morocco',
      primaryCurrency: 'MAD',
    },
  });
  vendorId = vendor.id;
  const category = await prisma.expenseCategory.findFirstOrThrow({
    where: { companyId: ctx.morocco.id, kind: 'GENERAL' },
  });
  categoryId = category.id;
}, 120_000);

const bill = (over: Record<string, unknown> = {}) => ({
  companyId: ctx.morocco.id,
  expenseDate: utcDate('2026-03-01'),
  expenseCategoryId: categoryId,
  currency: 'MAD',
  amount: '4000',
  rateToUsd: '9.85',
  rateLocalPerUsd: '9.85',
  paymentMethod: 'BANK_TRANSFER' as const,
  capitaliseToLandedCost: false,
  kind: 'GENERAL' as const,
  description: 'March office rent',
  ...over,
});

describe('an unpaid general expense', () => {
  it('posts as a payable owed to the supplier', async () => {
    const draft = await createExpense(bill({ vendorId }), ctx.admin.id);
    const posted = await postExpense({ id: draft.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
    expect(posted.status).toBe('POSTED');

    const payables = await getPayables({ companyId: ctx.morocco.id });
    const row = payables.find((r) => r.contractNumber === posted.expenseNumber);
    expect(row, 'the bill should be listed under payables').toBeTruthy();
    expect(row?.kind).toBe('EXPENSE');
    expect(row?.vendorId).toBe(vendorId);
  }, 120_000);

  it('books to Accrued Expenses when nobody is named, and is paid later from cash', async () => {
    // Nobody named: the charge is known before anyone decided whose bill it is.
    const draft = await createExpense(bill({ amount: '2500', description: 'Port handling, invoice to follow' }), ctx.admin.id);
    const posted = await postExpense({ id: draft.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
    expect(posted.status).toBe('POSTED');

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'EXPENSE', sourceId: posted.id, status: 'POSTED' },
      include: { lines: { include: { account: { select: { systemKey: true } } } } },
    });
    const credit = entry.lines.find((l) => dec(l.credit).greaterThan(0));
    expect(credit?.account.systemKey).toBe('ACCRUED_EXPENSES');
    expect(credit?.vendorId).toBeNull();

    // Not on any supplier's account, so not in supplier payables.
    const payables = await getPayables({ companyId: ctx.morocco.id });
    expect(payables.some((r) => r.contractNumber === posted.expenseNumber)).toBe(false);

    // Paid later from cash, naming no supplier. Accrued Expenses is cleared.
    const cash = await getCashAccount(ctx.morocco.id, 'MAD');
    const payment = await createPayment(
      {
        companyId: ctx.morocco.id,
        paymentDate: utcDate('2026-03-10'),
        vendorId: null,
        currency: 'MAD',
        amount: '2500',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'CASH',
        cashBankAccountId: cash.id,
        allocations: [{ expenseId: posted.id, amount: '2500' }],
      },
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const accrued = await prisma.$queryRaw<Array<{ bal: string }>>`
      SELECT COALESCE(SUM(jl."credit" - jl."debit"), 0)::text AS bal
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      JOIN accounts a ON a."id" = jl."accountId"
      WHERE je."companyId" = ${ctx.morocco.id} AND je."status" = 'POSTED' AND a."systemKey" = 'ACCRUED_EXPENSES'`;
    expect(dec(accrued[0]?.bal ?? 0).toFixed(2)).toBe('0.00');

    const health = await reconcile(ctx.morocco.id);
    expect(health.healthy, health.checks.filter((c) => !c.passed).map((c) => c.label).join('; ')).toBe(true);
  }, 180_000);

  it('will not let a payment to nobody settle a bill that is on a supplier account', async () => {
    const owed = await createExpense(bill({ vendorId, amount: '700' }), ctx.admin.id);
    await postExpense({ id: owed.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
    const cash = await getCashAccount(ctx.morocco.id, 'MAD');
    await expect(
      createPayment(
        {
          companyId: ctx.morocco.id,
          paymentDate: utcDate('2026-03-11'),
          vendorId: null,
          currency: 'MAD',
          amount: '700',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
          paymentMethod: 'CASH',
          cashBankAccountId: cash.id,
          allocations: [{ expenseId: owed.id, amount: '700' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/name that supplier/i);
  }, 120_000);
});

describe('the expense form as the user fills it in', () => {
  /** Exactly the object the form builds for an unpaid general cost. */
  const formPayload = (over: Record<string, unknown> = {}) => ({
    expenseDate: '2026-03-05',
    expenseCategoryId: categoryId,
    shipmentId: '',
    purchaseContractId: '',
    containerId: '',
    batchId: '',
    vendorId,
    agentId: '',
    payableToAgentId: '',
    currency: 'MAD',
    amount: '1200',
    rateToUsd: '9.85',
    rateLocalPerUsd: '9.85',
    paymentMethod: 'BANK_TRANSFER',
    cashBankAccountId: '',
    capitaliseToLandedCost: false,
    kind: 'GENERAL',
    taxCodeId: '',
    reference: '',
    description: 'Courier account, March',
    ...over,
  });

  it('records the bill against the supplier and posts it', async () => {
    const parsed = expenseSchema.parse(formPayload());
    expect(parsed.vendorId).toBe(vendorId);
    expect(parsed.cashBankAccountId).toBeNull();

    const draft = await createExpense(
      { ...parsed, companyId: ctx.morocco.id, expenseDate: parsed.expenseDate },
      ctx.admin.id,
    );
    const posted = await postExpense({ id: draft.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
    expect(posted.status).toBe('POSTED');

    const payables = await getPayables({ companyId: ctx.morocco.id });
    expect(payables.some((r) => r.contractNumber === posted.expenseNumber)).toBe(true);
  }, 120_000);

  it('accepts the payload that names nobody, as the simplified form sends it', async () => {
    const parsed = expenseSchema.parse(formPayload({ vendorId: '' }));
    const draft = await createExpense(
      { ...parsed, companyId: ctx.morocco.id, expenseDate: parsed.expenseDate },
      ctx.admin.id,
    );
    const posted = await postExpense({ id: draft.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
    expect(posted.status).toBe('POSTED');
    expect(posted.vendorId).toBeNull();
  }, 120_000);
});

describe('the account a category posts to', () => {
  it('debits the account the category names, not the catch-all', async () => {
    const account = await prisma.account.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, type: 'EXPENSE', systemKey: null },
      select: { id: true, code: true, name: true },
    });

    const category = await prisma.expenseCategory.create({
      data: {
        companyId: ctx.morocco.id,
        code: 'TEST-TELECOM',
        name: 'Telephone and internet',
        kind: 'GENERAL',
        capitaliseByDefault: false,
        glAccountId: account.id,
      },
    });

    const draft = await createExpense(
      bill({ vendorId, expenseCategoryId: category.id, amount: '900', description: 'March line rental' }),
      ctx.admin.id,
    );
    const posted = await postExpense({ id: draft.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, sourceType: 'EXPENSE', sourceId: posted.id, status: 'POSTED' },
      include: { lines: { select: { accountId: true, debit: true, credit: true } } },
    });

    const debit = entry.lines.find((l) => l.debit.greaterThan(0));
    expect(debit?.accountId, `expected the cost in ${account.code} ${account.name}`).toBe(account.id);
  }, 120_000);
});
