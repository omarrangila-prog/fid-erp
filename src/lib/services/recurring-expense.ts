import { prisma, transaction } from '@/lib/db';
import type { RecurringFrequency } from '@prisma/client';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { expenseSchema } from '@/lib/validation/finance';
import { createExpenseIn } from '@/lib/services/expense';
import { writeAudit } from '@/lib/services/audit';

/**
 * Expenses that come round on a rhythm.
 *
 * The template holds the voucher; the schedule holds the date. When the date
 * arrives the template produces a draft — dated the due date, not today — and
 * moves itself on to the next one. Somebody still reads the draft and posts
 * it, so a rent that went up in March is caught in March rather than posted
 * wrong until somebody notices the bank balance.
 */

/** The next occurrence after `from`, in whole calendar steps. */
export function advance(from: Date, frequency: RecurringFrequency): Date {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  switch (frequency) {
    case 'WEEKLY':
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case 'MONTHLY':
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
    case 'QUARTERLY':
      next.setUTCMonth(next.getUTCMonth() + 3);
      break;
    case 'YEARLY':
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      break;
  }
  return next;
}

/**
 * Turn an existing expense into a template.
 *
 * The voucher on file is the pattern: same category, same party, same
 * account, same amount. Its date is not copied — the schedule decides that.
 */
export async function createRecurringFromExpense(params: {
  companyId: string;
  expenseId: string;
  name: string;
  frequency: RecurringFrequency;
  nextDate: Date;
  endDate?: Date | null;
  userId: string;
}) {
  const expense = await prisma.expense.findFirst({
    where: { id: params.expenseId, companyId: params.companyId },
  });
  if (!expense) throw new NotFoundError('Expense');
  if (params.endDate && params.endDate < params.nextDate) {
    throw new BusinessRuleError('The end date cannot be before the first due date.');
  }

  const template = {
    expenseCategoryId: expense.expenseCategoryId,
    shipmentId: expense.shipmentId ?? '',
    purchaseContractId: expense.purchaseContractId ?? '',
    containerId: expense.containerId ?? '',
    batchId: expense.batchId ?? '',
    vendorId: expense.vendorId ?? '',
    agentId: expense.agentId ?? '',
    payableToAgentId: expense.payableToAgentId ?? '',
    currency: expense.currency,
    amount: expense.amount.toString(),
    rateToUsd: expense.rateToUsd.toString(),
    rateLocalPerUsd: expense.rateLocalPerUsd.toString(),
    paymentMethod: expense.paymentMethod,
    cashBankAccountId: expense.cashBankAccountId ?? '',
    capitaliseToLandedCost: expense.capitaliseToLandedCost,
    kind: expense.kind,
    taxCodeId: expense.taxCodeId ?? '',
    reference: '',
    description: expense.description ?? '',
  };

  return transaction(async (tx) => {
    const created = await tx.recurringExpense.create({
      data: {
        companyId: params.companyId,
        name: params.name,
        frequency: params.frequency,
        nextDate: params.nextDate,
        endDate: params.endDate ?? null,
        template,
        createdById: params.userId,
      },
    });
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'RECURRING_EXPENSE_CREATED',
      entityType: 'RecurringExpense',
      entityId: created.id,
      after: { name: params.name, frequency: params.frequency, from: expense.expenseNumber },
    });
    return created;
  });
}

/** Templates whose next date has arrived. */
export async function listDueRecurring(companyId: string, asOf: Date) {
  return prisma.recurringExpense.findMany({
    where: {
      companyId,
      status: 'ACTIVE',
      nextDate: { lte: asOf },
      OR: [{ endDate: null }, { endDate: { gte: asOf } }],
    },
    orderBy: { nextDate: 'asc' },
  });
}

export async function listRecurring(companyId: string) {
  return prisma.recurringExpense.findMany({
    where: { companyId },
    orderBy: [{ status: 'asc' }, { nextDate: 'asc' }],
  });
}

/**
 * Make the draft that is due and move the schedule on.
 *
 * Dated the due date, so a template that fell due while nobody was looking
 * still lands in the right month. Always a draft: the person who posts it is
 * the person who checked it.
 */
export async function generateFromRecurring(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM recurring_expenses
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId} AND "status" = 'ACTIVE'
      FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('Recurring expense');

    const template = await tx.recurringExpense.findUniqueOrThrow({ where: { id: params.id } });
    if (template.endDate && template.nextDate > template.endDate) {
      throw new BusinessRuleError(`${template.name} has reached its end date.`);
    }

    // The saved body goes through the same validation as a typed voucher.
    const input = expenseSchema.parse({
      ...(template.template as Record<string, unknown>),
      expenseDate: template.nextDate.toISOString().slice(0, 10),
    });

    const expense = await createExpenseIn(
      tx,
      { ...input, companyId: params.companyId, reference: template.name },
      params.userId,
    );

    const nextDate = advance(template.nextDate, template.frequency);
    const finished = template.endDate ? nextDate > template.endDate : false;

    await tx.recurringExpense.update({
      where: { id: template.id },
      data: {
        nextDate,
        lastCreatedId: expense.id,
        ...(finished ? { status: 'INACTIVE' } : {}),
      },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'RECURRING_EXPENSE_GENERATED',
      entityType: 'RecurringExpense',
      entityId: template.id,
      after: { expenseNumber: expense.expenseNumber, nextDate: nextDate.toISOString().slice(0, 10) },
    });

    return expense;
  });
}

export async function setRecurringStatus(params: {
  id: string;
  companyId: string;
  status: 'ACTIVE' | 'INACTIVE';
  userId: string;
}) {
  return transaction(async (tx) => {
    const existing = await tx.recurringExpense.findFirst({ where: { id: params.id, companyId: params.companyId } });
    if (!existing) throw new NotFoundError('Recurring expense');
    const updated = await tx.recurringExpense.update({ where: { id: params.id }, data: { status: params.status } });
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: params.status === 'ACTIVE' ? 'RECURRING_EXPENSE_RESUMED' : 'RECURRING_EXPENSE_PAUSED',
      entityType: 'RecurringExpense',
      entityId: params.id,
      before: { status: existing.status },
      after: { status: params.status },
    });
    return updated;
  });
}
