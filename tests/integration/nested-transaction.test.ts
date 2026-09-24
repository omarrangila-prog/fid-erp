import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { transaction } from '@/lib/db';
import { onceForKey } from '@/lib/services/idempotency';
import { createExpense } from '@/lib/services/expense';

/**
 * A service that calls another service, both of which open a transaction.
 *
 * Behind a connection pooler each instance holds one connection, so a second
 * transaction opened while the first is still running asks the pool for a
 * connection its own caller is holding. It waits, and is then told it could
 * not start — which is what every attempt to save a cost did on the client's
 * deployment, not under load but every single time.
 *
 * The inner call now joins the transaction already open. These tests hold
 * that shut.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.6', effectiveDate: utcDate('2026-01-01') },
  });
}, 300_000);

describe('one transaction inside another', () => {
  it('joins the one already open rather than asking for a second', async () => {
    const seen: unknown[] = [];
    await transaction(async (outer) => {
      seen.push(outer);
      await transaction(async (inner) => {
        seen.push(inner);
      });
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  }, 300_000);

  it('rolls the whole thing back when the inner work fails', async () => {
    const before = await prisma.expenseCategory.count({ where: { companyId } });

    await expect(
      transaction(async () => {
        await transaction(async (tx) => {
          await tx.expenseCategory.create({
            data: { companyId, code: `NP-${Date.now()}`, name: `Nested probe ${Date.now()}`, kind: 'GENERAL' },
          });
        });
        throw new Error('the outer work failed after the inner had written');
      }),
    ).rejects.toThrow(/outer work failed/);

    expect(await prisma.expenseCategory.count({ where: { companyId } })).toBe(before);
  }, 300_000);

  it('saves a cost through the idempotency key, which is the path that deadlocked', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId },
      select: { id: true },
    });
    const cash = await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId, currency: 'MAD' },
      select: { id: true },
    });

    const key = `probe-${Date.now()}`;
    const once = await onceForKey(
      { companyId, userId: ctx.admin.id, scope: 'EXPENSE', key },
      () =>
        createExpense(
          {
            companyId,
            expenseDate: utcDate('2026-09-20'),
            expenseCategoryId: category.id,
            currency: 'MAD',
            amount: '250',
            rateToUsd: '9.6',
            rateLocalPerUsd: '9.6',
            paymentMethod: 'CASH',
            cashBankAccountId: cash.id,
            description: 'Saved through the key, in one transaction',
          } as never,
          ctx.admin.id,
        ),
    );

    expect(once.replayed).toBe(false);
    expect(once.id).toBeTruthy();

    // And the key does its job: the same submission returns the same cost.
    const again = await onceForKey(
      { companyId, userId: ctx.admin.id, scope: 'EXPENSE', key },
      () => {
        throw new Error('the second submission must not create anything');
      },
    );
    expect(again.replayed).toBe(true);
    expect(again.id).toBe(once.id);

    expect(await prisma.expense.count({ where: { companyId, description: { contains: 'in one transaction' } } })).toBe(1);
  }, 300_000);
});
