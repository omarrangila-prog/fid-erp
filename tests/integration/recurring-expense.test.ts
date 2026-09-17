import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, utcDate } from '../helpers';
import { createExpense } from '@/lib/services/expense';
import {
  advance,
  createRecurringFromExpense,
  listDueRecurring,
  generateFromRecurring,
} from '@/lib/services/recurring-expense';
import { reconcile } from '@/lib/services/reconciliation';

/**
 * The monthly rent, made once and then produced on its date.
 *
 * What matters: the draft is dated the due date, not the day somebody
 * pressed the button; it is a draft and nothing more; and the schedule moves
 * on by a whole calendar step, so the 31st of January becomes the end of
 * February rather than the 3rd of March.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let vendorId: string;
let sourceId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  const vendor = await prisma.vendor.create({
    data: { companyId: ctx.morocco.id, vendorCode: 'SUP-RENT', vendorName: 'Immobilière Anfa', primaryCurrency: 'MAD' },
  });
  vendorId = vendor.id;
  const category = await prisma.expenseCategory.findFirstOrThrow({
    where: { companyId: ctx.morocco.id, kind: 'GENERAL' },
  });
  const source = await createExpense(
    {
      companyId: ctx.morocco.id,
      expenseDate: utcDate('2026-01-31'),
      expenseCategoryId: category.id,
      vendorId,
      currency: 'MAD',
      amount: '12000',
      rateToUsd: '9.85',
      rateLocalPerUsd: '9.85',
      paymentMethod: 'BANK_TRANSFER',
      capitaliseToLandedCost: false,
      kind: 'GENERAL',
      description: 'Office rent',
    },
    ctx.admin.id,
  );
  sourceId = source.id;
}, 120_000);

describe('advancing a schedule', () => {
  it('moves in whole calendar steps', () => {
    expect(advance(utcDate('2026-01-31'), 'MONTHLY').toISOString().slice(0, 10)).toBe('2026-03-03');
    expect(advance(utcDate('2026-01-15'), 'MONTHLY').toISOString().slice(0, 10)).toBe('2026-02-15');
    expect(advance(utcDate('2026-01-15'), 'WEEKLY').toISOString().slice(0, 10)).toBe('2026-01-22');
    expect(advance(utcDate('2026-01-15'), 'QUARTERLY').toISOString().slice(0, 10)).toBe('2026-04-15');
    expect(advance(utcDate('2026-01-15'), 'YEARLY').toISOString().slice(0, 10)).toBe('2027-01-15');
  });
});

describe('a recurring expense', () => {
  it('produces a draft dated the due date and moves on', async () => {
    const template = await createRecurringFromExpense({
      companyId: ctx.morocco.id,
      expenseId: sourceId,
      name: 'Office rent',
      frequency: 'MONTHLY',
      nextDate: utcDate('2026-02-15'),
      userId: ctx.admin.id,
    });

    // Not due yet on the 14th; due on the 15th.
    expect(await listDueRecurring(ctx.morocco.id, utcDate('2026-02-14'))).toHaveLength(0);
    expect(await listDueRecurring(ctx.morocco.id, utcDate('2026-02-15'))).toHaveLength(1);

    const draft = await generateFromRecurring({ id: template.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
    expect(draft.status).toBe('DRAFT');
    expect(draft.expenseDate.toISOString().slice(0, 10)).toBe('2026-02-15');
    expect(draft.amount.toString()).toBe('12000');
    expect(draft.vendorId).toBe(vendorId);
    expect(draft.reference).toBe('Office rent');

    const after = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.nextDate.toISOString().slice(0, 10)).toBe('2026-03-15');
    expect(after.lastCreatedId).toBe(draft.id);

    // A draft touches nothing in the ledger.
    const health = await reconcile(ctx.morocco.id);
    expect(health.healthy).toBe(true);
    const journals = await prisma.journalEntry.count({ where: { sourceType: 'EXPENSE', sourceId: draft.id } });
    expect(journals).toBe(0);
  }, 120_000);

  it('stops itself after the end date', async () => {
    const template = await createRecurringFromExpense({
      companyId: ctx.morocco.id,
      expenseId: sourceId,
      name: 'Short lease',
      frequency: 'MONTHLY',
      nextDate: utcDate('2026-06-01'),
      endDate: utcDate('2026-06-30'),
      userId: ctx.admin.id,
    });
    await generateFromRecurring({ id: template.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
    const after = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.status).toBe('INACTIVE');
    expect(await listDueRecurring(ctx.morocco.id, utcDate('2026-12-01'))).not.toContainEqual(
      expect.objectContaining({ id: template.id }),
    );
  }, 120_000);

  it('refuses an end date before the first due date', async () => {
    await expect(
      createRecurringFromExpense({
        companyId: ctx.morocco.id,
        expenseId: sourceId,
        name: 'Backwards',
        frequency: 'MONTHLY',
        nextDate: utcDate('2026-06-01'),
        endDate: utcDate('2026-05-01'),
        userId: ctx.admin.id,
      }),
    ).rejects.toThrow(/end date/i);
  });
});
