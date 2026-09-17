import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, utcDate } from '../helpers';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getPayables } from '@/lib/services/receivables';
import { expenseSchema } from '@/lib/validation/finance';

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

  it('will not be recorded at all when nobody is named as owed', async () => {
    await expect(createExpense(bill(), ctx.admin.id)).rejects.toThrow(/owed to a supplier/i);
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

  it('still refuses the old payload that named nobody', async () => {
    const parsed = expenseSchema.parse(formPayload({ vendorId: '' }));
    await expect(
      createExpense(
        { ...parsed, companyId: ctx.morocco.id, expenseDate: parsed.expenseDate },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/owed to a supplier/i);
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
