import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, utcDate, getCashAccount } from '../helpers';
import { expenseCategoryCodeFromName, quickCreateExpenseCategory } from '@/lib/services/expense-category';
import { createExpense } from '@/lib/services/expense';

describe('expenseCategoryCodeFromName', () => {
  it('turns a name into a short uppercase code', () => {
    expect(expenseCategoryCodeFromName('Warehouse rent')).toBe('WAREHOUSE_RENT');
    expect(expenseCategoryCodeFromName('  duty & vat  ')).toBe('DUTY_VAT');
  });
});

describe('quickCreateExpenseCategory', () => {
  let ctx: Awaited<ReturnType<typeof getContext>>;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await getContext();
  });

  it('creates a shipment category that can be used on an expense immediately', async () => {
    const created = await quickCreateExpenseCategory({
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      // A name the standard chart does not already carry, so this stays a
      // test of quick-create rather than of the duplicate guard.
      name: 'Phytosanitary treatment',
      description: 'Treatment certificate at origin',
      kind: 'SHIPMENT',
    });

    expect(created.code).toBe('PHYTOSANITARY_TREATMENT');
    expect(created.kind).toBe('SHIPMENT');
    expect(created.capitaliseByDefault).toBe(true);

    const general = await quickCreateExpenseCategory({
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      name: 'Staff dinner',
      kind: 'GENERAL',
    });
    const cash = await getCashAccount(ctx.morocco.id, 'MAD');
    const expense = await createExpense(
      {
        companyId: ctx.morocco.id,
        expenseDate: utcDate('2026-03-01'),
        expenseCategoryId: general.id,
        currency: 'MAD',
        amount: '1500',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        cashBankAccountId: cash.id,
        kind: 'GENERAL',
      },
      ctx.admin.id,
    );
    expect(expense.expenseCategoryId).toBe(general.id);
  });

  it('creates a general category as a period cost', async () => {
    const created = await quickCreateExpenseCategory({
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      name: 'Office tea',
      kind: 'GENERAL',
    });
    expect(created.kind).toBe('GENERAL');
    expect(created.capitaliseByDefault).toBe(false);
  });

  it('refuses a name that is already a category', async () => {
    await expect(
      quickCreateExpenseCategory({
        companyId: ctx.morocco.id,
        userId: ctx.admin.id,
        name: 'Fumigation',
        kind: 'SHIPMENT',
      }),
    ).rejects.toThrow(/already a category/i);
  });

  it('issues a numbered code when the slug is already taken', async () => {
    const second = await quickCreateExpenseCategory({
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      name: 'Fumigation extra',
      kind: 'SHIPMENT',
    });
    // Different name, so the preferred slug is FUMIGATION_EXTRA, not a clash.
    expect(second.code).toBe('FUMIGATION_EXTRA');

    await prisma.expenseCategory.create({
      data: {
        companyId: ctx.dubai.id,
        code: 'RESERVED_SLUG',
        name: 'Reserved slug holder',
        kind: 'GENERAL',
        capitaliseByDefault: false,
      },
    });
    const numbered = await quickCreateExpenseCategory({
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      name: 'Reserved slug',
      kind: 'GENERAL',
    });
    expect(numbered.code).toMatch(/^EXP-/);
  });
});
