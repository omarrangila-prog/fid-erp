import type { Tx } from '@/lib/db';
import { transaction } from '@/lib/db';
import { BusinessRuleError, ConflictError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';
import type { ExpenseKind } from '@prisma/client';

/**
 * A code derived from the name, so "Warehouse rent" becomes WAREHOUSE_RENT
 * rather than EXP-0042. Falls back to a numbered EXP- code when that slug is
 * already taken.
 */
export function expenseCategoryCodeFromName(name: string): string {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 24);
  return slug || 'CAT';
}

async function nextCategoryCode(tx: Tx, companyId: string, name: string): Promise<string> {
  const preferred = expenseCategoryCodeFromName(name);
  const clash = await tx.expenseCategory.findFirst({
    where: { companyId, code: preferred },
    select: { id: true },
  });
  if (!clash) return preferred;

  const used = await tx.expenseCategory.count({ where: { companyId } });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const code = `EXP-${String(used + 1 + attempt).padStart(4, '0')}`;
    const taken = await tx.expenseCategory.findFirst({
      where: { companyId, code },
      select: { id: true },
    });
    if (!taken) return code;
  }
  return `EXP-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Creates a category from the expense form: a name, an optional note, and the
 * shipment/general type already chosen on that form. The code is issued here so
 * nobody has to invent one mid-voucher.
 */
export async function quickCreateExpenseCategory(params: {
  companyId: string;
  userId: string;
  name: string;
  description?: string | null;
  kind: ExpenseKind;
}) {
  const name = params.name.trim();
  if (!name) throw new BusinessRuleError('Enter the category name.');

  const description = params.description?.trim() || null;
  const kind = params.kind;
  const capitaliseByDefault = kind === 'SHIPMENT';

  return transaction(async (tx) => {
    const duplicate = await tx.expenseCategory.findFirst({
      where: { companyId: params.companyId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (duplicate) {
      throw new ConflictError(`${duplicate.name} is already a category. Choose it from the list.`);
    }

    const code = await nextCategoryCode(tx, params.companyId, name);
    const created = await tx.expenseCategory.create({
      data: {
        companyId: params.companyId,
        code,
        name,
        description,
        kind,
        capitaliseByDefault,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        name: true,
        code: true,
        kind: true,
        capitaliseByDefault: true,
      },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'EXPENSE_CATEGORY_CREATED',
      entityType: 'ExpenseCategory',
      entityId: created.id,
      after: { code: created.code, name: created.name, kind: created.kind },
    });

    return created;
  });
}
