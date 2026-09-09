'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma, transaction } from '@/lib/db';
import { requirePermission, assertPermission } from '@/lib/auth/guards';
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';
import { createCashBankAccount } from '@/lib/services/chart-of-accounts';
import { formDataToObject, fieldErrors } from '@/lib/validation/common';
import {
  customerSchema,
  vendorSchema,
  coffeeItemSchema,
  warehouseSchema,
  agentSchema,
  shippingLineSchema,
  expenseCategorySchema,
  cashBankAccountSchema,
} from '@/lib/validation/masters';
import { fail, type ActionResult } from '@/server/actions/action-utils';

/**
 * Master data actions.
 *
 * Every one of these follows the same shape: assert the permission, validate
 * with Zod, scope to the caller's active company, check uniqueness within that
 * company, write, audit, revalidate. The company id is always taken from the
 * session and never from the form, so a crafted request cannot write into the
 * other company's books.
 */

export type MasterFormState =
  | { ok: true; id: string; message: string }
  | { ok: false; error: string; errors?: Record<string, string> }
  | null;

type MasterConfig<S extends z.ZodTypeAny> = {
  schema: S;
  viewPermission: PermissionCode;
  createPermission: PermissionCode;
  editPermission: PermissionCode;
  label: string;
  /** Field that must be unique within the company. */
  uniqueField: string;
  path: string;
};

function invalid(error: unknown): MasterFormState {
  if (error instanceof z.ZodError) {
    return { ok: false, error: 'Please correct the highlighted fields.', errors: fieldErrors(error) };
  }
  const response = fail(error);
  return { ok: false, error: response.ok ? 'The action could not be completed.' : response.error };
}

async function saveMaster<S extends z.ZodTypeAny>(
  config: MasterConfig<S>,
  delegate: 'customer' | 'vendor' | 'coffeeItem' | 'warehouse' | 'agent' | 'shippingLine' | 'expenseCategory',
  id: string | null,
  formData: FormData,
): Promise<MasterFormState> {
  try {
    const user = await requirePermission(config.viewPermission);
    assertPermission(user, id ? config.editPermission : config.createPermission);
    const companyId = user.activeCompany.id;

    const data = config.schema.parse(formDataToObject(formData)) as Record<string, unknown>;
    const uniqueValue = data[config.uniqueField] as string;

    // Prisma's delegates are structurally identical for these operations, but
    // TypeScript cannot prove it across a union, so this is narrowed once here.
    const model = prisma[delegate] as unknown as {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
      findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
      create: (args: unknown) => Promise<{ id: string }>;
      update: (args: unknown) => Promise<{ id: string }>;
    };

    const duplicate = await model.findFirst({
      where: { companyId, [config.uniqueField]: uniqueValue, ...(id ? { NOT: { id } } : {}) },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictError(`${config.label} code "${uniqueValue}" is already in use.`);
    }

    const before = id ? await model.findUnique({ where: { id } }) : null;
    if (id && (!before || before.companyId !== companyId)) throw new NotFoundError(config.label);

    const saved = id
      ? await model.update({ where: { id }, data })
      : await model.create({ data: { ...data, companyId } });

    await transaction((tx) =>
      writeAudit(tx, {
        companyId,
        userId: user.id,
        action: id ? `${config.label.toUpperCase().replace(/ /g, '_')}_UPDATED` : `${config.label.toUpperCase().replace(/ /g, '_')}_CREATED`,
        entityType: config.label.replace(/ /g, ''),
        entityId: saved.id,
        before: before ?? undefined,
        after: data,
      }),
    );

    revalidatePath(config.path);
    revalidatePath(`${config.path}/${saved.id}`);

    return { ok: true, id: saved.id, message: `${config.label} saved.` };
  } catch (error) {
    return invalid(error);
  }
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const CUSTOMER: MasterConfig<typeof customerSchema> = {
  schema: customerSchema,
  viewPermission: PERMISSIONS.CUSTOMERS_VIEW,
  createPermission: PERMISSIONS.CUSTOMERS_CREATE,
  editPermission: PERMISSIONS.CUSTOMERS_EDIT,
  label: 'Customer',
  uniqueField: 'customerCode',
  path: '/customers',
};

export async function saveCustomerAction(id: string | null, _prev: MasterFormState, formData: FormData) {
  return saveMaster(CUSTOMER, 'customer', id, formData);
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

const VENDOR: MasterConfig<typeof vendorSchema> = {
  schema: vendorSchema,
  viewPermission: PERMISSIONS.VENDORS_VIEW,
  createPermission: PERMISSIONS.VENDORS_CREATE,
  editPermission: PERMISSIONS.VENDORS_EDIT,
  label: 'Supplier',
  uniqueField: 'vendorCode',
  path: '/vendors',
};

export async function saveVendorAction(id: string | null, _prev: MasterFormState, formData: FormData) {
  return saveMaster(VENDOR, 'vendor', id, formData);
}

// ---------------------------------------------------------------------------
// Coffee items
// ---------------------------------------------------------------------------

const ITEM: MasterConfig<typeof coffeeItemSchema> = {
  schema: coffeeItemSchema,
  viewPermission: PERMISSIONS.ITEMS_VIEW,
  createPermission: PERMISSIONS.ITEMS_CREATE,
  editPermission: PERMISSIONS.ITEMS_EDIT,
  label: 'Coffee item',
  uniqueField: 'itemCode',
  path: '/items',
};

export async function saveCoffeeItemAction(id: string | null, _prev: MasterFormState, formData: FormData) {
  return saveMaster(ITEM, 'coffeeItem', id, formData);
}

// ---------------------------------------------------------------------------
// Warehouses, agents, shipping lines, expense categories
// ---------------------------------------------------------------------------

const WAREHOUSE: MasterConfig<typeof warehouseSchema> = {
  schema: warehouseSchema,
  viewPermission: PERMISSIONS.WAREHOUSES_VIEW,
  createPermission: PERMISSIONS.WAREHOUSES_MANAGE,
  editPermission: PERMISSIONS.WAREHOUSES_MANAGE,
  label: 'Warehouse',
  uniqueField: 'code',
  path: '/warehouses',
};

export async function saveWarehouseAction(id: string | null, _prev: MasterFormState, formData: FormData) {
  return saveMaster(WAREHOUSE, 'warehouse', id, formData);
}

const AGENT: MasterConfig<typeof agentSchema> = {
  schema: agentSchema,
  viewPermission: PERMISSIONS.AGENTS_VIEW,
  createPermission: PERMISSIONS.AGENTS_MANAGE,
  editPermission: PERMISSIONS.AGENTS_MANAGE,
  label: 'Agent',
  uniqueField: 'agentCode',
  path: '/agents',
};

export async function saveAgentAction(id: string | null, _prev: MasterFormState, formData: FormData) {
  return saveMaster(AGENT, 'agent', id, formData);
}

const SHIPPING_LINE: MasterConfig<typeof shippingLineSchema> = {
  schema: shippingLineSchema,
  viewPermission: PERMISSIONS.SHIPPING_LINES_VIEW,
  createPermission: PERMISSIONS.SHIPPING_LINES_MANAGE,
  editPermission: PERMISSIONS.SHIPPING_LINES_MANAGE,
  label: 'Shipping line',
  uniqueField: 'code',
  path: '/shipping-lines',
};

export async function saveShippingLineAction(id: string | null, _prev: MasterFormState, formData: FormData) {
  return saveMaster(SHIPPING_LINE, 'shippingLine', id, formData);
}

const EXPENSE_CATEGORY: MasterConfig<typeof expenseCategorySchema> = {
  schema: expenseCategorySchema,
  viewPermission: PERMISSIONS.EXPENSE_CATEGORIES_VIEW,
  createPermission: PERMISSIONS.EXPENSE_CATEGORIES_MANAGE,
  editPermission: PERMISSIONS.EXPENSE_CATEGORIES_MANAGE,
  label: 'Expense category',
  uniqueField: 'code',
  path: '/expense-categories',
};

export async function saveExpenseCategoryAction(id: string | null, _prev: MasterFormState, formData: FormData) {
  return saveMaster(EXPENSE_CATEGORY, 'expenseCategory', id, formData);
}

// ---------------------------------------------------------------------------
// Cash and bank accounts — these also create a backing GL account
// ---------------------------------------------------------------------------

export async function saveCashBankAccountAction(
  id: string | null,
  _prev: MasterFormState,
  formData: FormData,
): Promise<MasterFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.CASHBANK_MANAGE);
    const companyId = user.activeCompany.id;
    const data = cashBankAccountSchema.parse(formDataToObject(formData));

    if (id) {
      const existing = await prisma.cashBankAccount.findFirst({ where: { id, companyId } });
      if (!existing) throw new NotFoundError('Cash/bank account');

      // Currency and opening balance are frozen once the account has postings,
      // because changing either would silently restate history.
      const hasPostings = await prisma.journalLine.count({ where: { cashBankAccountId: id } });
      const updated = await prisma.cashBankAccount.update({
        where: { id },
        data: {
          name: data.name,
          accountType: data.accountType,
          bankName: data.bankName,
          accountNumber: data.accountNumber,
          ...(hasPostings === 0
            ? { currency: data.currency, openingBalance: data.openingBalance }
            : {}),
        },
      });

      await transaction((tx) =>
        writeAudit(tx, {
          companyId,
          userId: user.id,
          action: 'CASH_BANK_ACCOUNT_UPDATED',
          entityType: 'CashBankAccount',
          entityId: id,
          before: existing,
          after: data,
        }),
      );

      revalidatePath('/finance/cash-bank');
      return { ok: true, id: updated.id, message: 'Account saved.' };
    }

    const created = await createCashBankAccount({ companyId, ...data }, user.id);
    await transaction((tx) =>
      writeAudit(tx, {
        companyId,
        userId: user.id,
        action: 'CASH_BANK_ACCOUNT_CREATED',
        entityType: 'CashBankAccount',
        entityId: created.id,
        after: data,
      }),
    );

    revalidatePath('/finance/cash-bank');
    return { ok: true, id: created.id, message: 'Account created.' };
  } catch (error) {
    return invalid(error);
  }
}

// ---------------------------------------------------------------------------
// Status toggle, shared by every master
// ---------------------------------------------------------------------------

const STATUS_TARGETS = {
  customer: { permission: PERMISSIONS.CUSTOMERS_EDIT, path: '/customers', label: 'Customer' },
  vendor: { permission: PERMISSIONS.VENDORS_EDIT, path: '/vendors', label: 'Supplier' },
  coffeeItem: { permission: PERMISSIONS.ITEMS_EDIT, path: '/items', label: 'Coffee item' },
  warehouse: { permission: PERMISSIONS.WAREHOUSES_MANAGE, path: '/warehouses', label: 'Warehouse' },
  agent: { permission: PERMISSIONS.AGENTS_MANAGE, path: '/agents', label: 'Agent' },
  shippingLine: { permission: PERMISSIONS.SHIPPING_LINES_MANAGE, path: '/shipping-lines', label: 'Shipping line' },
  expenseCategory: {
    permission: PERMISSIONS.EXPENSE_CATEGORIES_MANAGE,
    path: '/expense-categories',
    label: 'Expense category',
  },
  cashBankAccount: { permission: PERMISSIONS.CASHBANK_MANAGE, path: '/finance/cash-bank', label: 'Account' },
} as const;

export async function toggleMasterStatusAction(
  target: keyof typeof STATUS_TARGETS,
  id: string,
  status: 'ACTIVE' | 'INACTIVE',
): Promise<ActionResult<undefined>> {
  try {
    const config = STATUS_TARGETS[target];
    const user = await requirePermission(config.permission);
    const companyId = user.activeCompany.id;

    const model = prisma[target] as unknown as {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
      update: (args: unknown) => Promise<unknown>;
    };

    const existing = await model.findFirst({ where: { id, companyId }, select: { id: true } });
    if (!existing) throw new NotFoundError(config.label);

    await model.update({ where: { id }, data: { status } });

    await transaction((tx) =>
      writeAudit(tx, {
        companyId,
        userId: user.id,
        action: status === 'ACTIVE' ? 'MASTER_REACTIVATED' : 'MASTER_DEACTIVATED',
        entityType: config.label.replace(/ /g, ''),
        entityId: id,
        after: { status },
      }),
    );

    revalidatePath(config.path);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}
