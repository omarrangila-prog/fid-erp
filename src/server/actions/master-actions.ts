'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma, transaction } from '@/lib/db';
import { requirePermission, assertPermission, requireAnyPermission } from '@/lib/auth/guards';
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';
import {
  createCashBankAccount,
  createLedgerAccount,
  updateLedgerAccount,
  deactivateLedgerAccount,
  reactivateLedgerAccount,
  postAccountOpeningBalance,
} from '@/lib/services/chart-of-accounts';
import { quickCreateExpenseCategory } from '@/lib/services/expense-category';
import { quickCreateAgent } from '@/lib/services/agent';
import { dec } from '@/lib/money';
import { ledgerAccountSchema, ledgerAccountUpdateSchema, ledgerOpeningSchema } from '@/lib/validation/finance';
import {
  formDataToObject,
  fieldErrors,
  requiredText,
  currencyCode,
  optionalText,
} from '@/lib/validation/common';
import {
  customerSchema,
  vendorSchema,
  coffeeItemSchema,
  warehouseSchema,
  agentSchema,
  shippingLineSchema,
  portSchema,
  expenseCategorySchema,
  cashBankAccountSchema,
} from '@/lib/validation/masters';
import { fail, run, type ActionResult } from '@/server/actions/action-utils';
import { resolveMasterCode } from '@/lib/services/master-code';

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

/** Prefixes that read like the record they belong to. */
const CODE_PREFIX: Record<string, string> = {
  customer: 'CUS',
  vendor: 'SUP',
  coffeeItem: 'ITM',
  warehouse: 'WH',
  agent: 'AGT',
  shippingLine: 'SL',
  expenseCategory: 'EXP',
  port: 'PRT',
};

async function nextMasterCode<S extends z.ZodTypeAny>(
  delegate: string,
  config: MasterConfig<S>,
  companyId: string,
): Promise<string> {
  const model = prisma[delegate as 'customer'] as unknown as {
    count: (args: unknown) => Promise<number>;
    findFirst: (args: unknown) => Promise<{ id: string } | null>;
  };

  const used = await model.count({ where: { companyId } });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const code = `${CODE_PREFIX[delegate] ?? 'REC'}-${String(used + 1 + attempt).padStart(4, '0')}`;
    const clash = await model.findFirst({ where: { companyId, [config.uniqueField]: code }, select: { id: true } });
    if (!clash) return code;
  }
  // Two hundred consecutive collisions is not a naming problem any more.
  return `${CODE_PREFIX[delegate] ?? 'REC'}-${Date.now().toString(36).toUpperCase()}`;
}

async function saveMaster<S extends z.ZodTypeAny>(
  config: MasterConfig<S>,
  delegate: 'customer' | 'vendor' | 'coffeeItem' | 'warehouse' | 'agent' | 'shippingLine' | 'expenseCategory' | 'port',
  id: string | null,
  formData: FormData,
): Promise<MasterFormState> {
  try {
    const user = await requirePermission(config.viewPermission);
    assertPermission(user, id ? config.editPermission : config.createPermission);
    const companyId = user.activeCompany.id;

    const data = config.schema.parse(formDataToObject(formData)) as Record<string, unknown>;

    // Prisma's delegates are structurally identical for these operations, but
    // TypeScript cannot prove it across a union, so this is narrowed once here.
    const model = prisma[delegate] as unknown as {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
      findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
      create: (args: unknown) => Promise<{ id: string }>;
      update: (args: unknown) => Promise<{ id: string }>;
    };

    const before = id ? await model.findUnique({ where: { id } }) : null;
    if (id && (!before || before.companyId !== companyId)) throw new NotFoundError(config.label);

    /*
     * The code is issued here when the user has not given one — on create.
     * Edit forms often omit the code field. Treating that as a blank code
     * used to mint CUS-0002 on top of CUS-0001, which either collided or
     * silently renamed a live customer.
     */
    const resolved = resolveMasterCode({
      submitted: data[config.uniqueField],
      existing: before?.[config.uniqueField],
      isCreate: !id,
    });
    data[config.uniqueField] =
      'generate' in resolved ? await nextMasterCode(delegate, config, companyId) : resolved.code;

    const uniqueValue = data[config.uniqueField] as string;

    const duplicate = await model.findFirst({
      where: { companyId, [config.uniqueField]: uniqueValue, ...(id ? { NOT: { id } } : {}) },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictError(`${config.label} code "${uniqueValue}" is already in use.`);
    }

    // Agent names are what people pick on a receipt. Two people called the
    // same thing on the list is how the wrong clearing ledger gets posted.
    if (delegate === 'agent') {
      const agentName = String(data.agentName ?? '').trim();
      if (agentName) {
        const nameClash = await model.findFirst({
          where: {
            companyId,
            agentName: { equals: agentName, mode: 'insensitive' },
            ...(id ? { NOT: { id } } : {}),
          },
          select: { id: true },
        });
        if (nameClash) {
          throw new ConflictError(`An agent named "${agentName}" already exists.`);
        }
      }
    }

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
    if (delegate === 'customer') {
      revalidatePath('/sales');
      revalidatePath('/sales/new');
      revalidatePath('/ledgers/customers');
    }
    if (delegate === 'vendor') {
      revalidatePath('/purchases');
      revalidatePath('/purchases/new');
      revalidatePath('/ledgers/vendors');
    }
    if (delegate === 'agent') {
      revalidatePath('/finance/receipts/new');
      revalidatePath('/finance/expenses/new');
    }
    if (delegate === 'expenseCategory') {
      revalidatePath('/finance/expenses/new');
    }

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

/**
 * Create a customer without leaving the invoice.
 *
 * A new customer walks in and buys something; making the user abandon a
 * half-filled invoice, go to the customer master, come back and start again is
 * the friction the client asked to be rid of. This takes only what an invoice
 * actually needs — a name and a currency — and issues the code itself, because
 * inventing a unique code is not a decision anybody wants to make mid-sale.
 */
export async function quickCreateCustomerAction(
  payload: string,
): Promise<ActionResult<{ id: string; name: string; currency: string; paymentTermDays: number }>> {
  return run(async () => {
    const user = await requirePermission(PERMISSIONS.CUSTOMERS_CREATE);
    const companyId = user.activeCompany.id;

    const input = z
      .object({
        customerName: requiredText('Customer name'),
        primaryCurrency: currencyCode,
        country: optionalText(100),
        phone: optionalText(40),
        paymentTermDays: z.coerce.number().int().min(0).max(365).default(0),
      })
      .parse(JSON.parse(payload) as unknown);

    const existing = await prisma.customer.findFirst({
      where: { companyId, customerName: { equals: input.customerName, mode: 'insensitive' } },
      select: { id: true, customerName: true },
    });
    if (existing) {
      throw new ConflictError(`${existing.customerName} is already on the customer list.`);
    }

    // A code of the system's own, in the same shape as the rest.
    const count = await prisma.customer.count({ where: { companyId } });
    let customerCode = `CUS-${String(count + 1).padStart(4, '0')}`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const clash = await prisma.customer.findFirst({
        where: { companyId, customerCode },
        select: { id: true },
      });
      if (!clash) break;
      customerCode = `CUS-${String(count + 2 + attempt).padStart(4, '0')}`;
    }

    const customer = await prisma.customer.create({
      data: {
        companyId,
        customerCode,
        customerName: input.customerName,
        primaryCurrency: input.primaryCurrency.toUpperCase(),
        country: input.country ?? null,
        phone: input.phone ?? null,
        paymentTermDays: input.paymentTermDays,
      },
      select: { id: true, customerName: true, primaryCurrency: true, paymentTermDays: true },
    });

    await transaction((tx) =>
      writeAudit(tx, {
        companyId,
        userId: user.id,
        action: 'CUSTOMER_CREATED',
        entityType: 'Customer',
        entityId: customer.id,
        after: {
          customerCode,
          customerName: customer.customerName,
          primaryCurrency: customer.primaryCurrency,
        },
      }),
    );

    revalidatePath('/customers');
    revalidatePath('/sales');
    revalidatePath('/sales/new');
    revalidatePath('/ledgers/customers');

    return {
      id: customer.id,
      name: customer.customerName,
      currency: customer.primaryCurrency,
      paymentTermDays: customer.paymentTermDays,
    };
  });
}

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

/** Hide an item from new orders without deleting the history that already used it. */
export async function deactivateCoffeeItemAction(id: string): Promise<MasterFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ITEMS_DELETE);
    const companyId = user.activeCompany.id;
    const item = await prisma.coffeeItem.findFirst({ where: { id, companyId } });
    if (!item) throw new NotFoundError('Coffee item');

    await prisma.coffeeItem.update({ where: { id }, data: { status: 'INACTIVE' } });
    await transaction((tx) =>
      writeAudit(tx, {
        companyId,
        userId: user.id,
        action: 'COFFEE_ITEM_DEACTIVATED',
        entityType: 'CoffeeItem',
        entityId: id,
        before: { status: item.status },
        after: { status: 'INACTIVE' },
      }),
    );
    revalidatePath('/items');
    revalidatePath(`/items/${id}`);
    return { ok: true, id, message: `${item.itemName} is now inactive.` };
  } catch (error) {
    return invalid(error);
  }
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

/**
 * Create an agent without leaving the receipt.
 *
 * Collection has to name who is holding the money. Sending the user to the
 * master list, inventing a code, then coming back to start the voucher again
 * is the friction this removes. The name is enough; the code is issued here.
 */
export async function quickCreateAgentAction(
  payload: string,
): Promise<ActionResult<{ id: string; agentName: string; agentCode: string; phone: string | null }>> {
  return run(async () => {
    const user = await requireAnyPermission([
      PERMISSIONS.RECEIPTS_CREATE,
      PERMISSIONS.EXPENSES_CREATE,
      PERMISSIONS.AGENTS_MANAGE,
    ]);

    const input = z
      .object({
        agentName: requiredText('Agent name'),
        phone: optionalText(40),
        notes: optionalText(1000),
      })
      .parse(JSON.parse(payload) as unknown);

    const created = await quickCreateAgent({
      companyId: user.activeCompany.id,
      userId: user.id,
      agentName: input.agentName,
      phone: input.phone,
      notes: input.notes,
    });

    revalidatePath('/agents');
    revalidatePath('/finance/receipts/new');
    revalidatePath('/finance/expenses/new');
    revalidatePath('/ledgers/agents');

    return created;
  });
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

const PORT: MasterConfig<typeof portSchema> = {
  schema: portSchema,
  viewPermission: PERMISSIONS.PORTS_VIEW,
  createPermission: PERMISSIONS.PORTS_MANAGE,
  editPermission: PERMISSIONS.PORTS_MANAGE,
  label: 'Port',
  uniqueField: 'code',
  path: '/ports',
};

export async function savePortAction(id: string | null, _prev: MasterFormState, formData: FormData) {
  return saveMaster(PORT, 'port', id, formData);
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

/**
 * Create a category without leaving the expense voucher.
 *
 * New kinds of cost show up after the company is already trading. Sending the
 * user to the master list, inventing a code, then coming back to start the
 * voucher again is the friction this removes. The type (shipment or general)
 * is taken from the form they are already filling in.
 */
export async function quickCreateExpenseCategoryAction(
  payload: string,
): Promise<ActionResult<{ id: string; name: string; code: string; kind: 'SHIPMENT' | 'GENERAL'; capitaliseByDefault: boolean }>> {
  return run(async () => {
    const user = await requireAnyPermission([
      PERMISSIONS.EXPENSES_CREATE,
      PERMISSIONS.EXPENSE_CATEGORIES_MANAGE,
    ]);

    const input = z
      .object({
        name: requiredText('Category name'),
        description: optionalText(400),
        kind: z.enum(['SHIPMENT', 'GENERAL']),
      })
      .parse(JSON.parse(payload) as unknown);

    const created = await quickCreateExpenseCategory({
      companyId: user.activeCompany.id,
      userId: user.id,
      name: input.name,
      description: input.description,
      kind: input.kind,
    });

    revalidatePath('/expense-categories');
    revalidatePath('/finance/expenses/new');

    return created;
  });
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
          status: data.status,
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
      revalidatePath(`/finance/cash-bank/${id}`);
      return { ok: true, id: updated.id, message: 'Account saved.' };
    }

    let code = data.code;
    if (!code) {
      const used = await prisma.cashBankAccount.count({ where: { companyId } });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const candidate = `CBA-${String(used + 1 + attempt).padStart(4, '0')}`;
        const clash = await prisma.cashBankAccount.findFirst({
          where: { companyId, code: candidate },
          select: { id: true },
        });
        if (!clash) {
          code = candidate;
          break;
        }
      }
      code ??= `CBA-${Date.now().toString(36).toUpperCase()}`;
    }

    const created = await createCashBankAccount(
      {
        companyId,
        code,
        name: data.name,
        accountType: data.accountType,
        currency: data.currency,
        openingBalance: data.openingBalance,
        bankName: data.bankName,
        accountNumber: data.accountNumber,
      },
      user.id,
    );
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

export async function saveLedgerAccountAction(
  id: string | null,
  _prev: MasterFormState,
  formData: FormData,
): Promise<MasterFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const companyId = user.activeCompany.id;
    const raw = formDataToObject(formData);

    if (id) {
      const data = ledgerAccountUpdateSchema.parse(raw);
      const updated = await updateLedgerAccount({
        id,
        companyId,
        code: data.code ?? undefined,
        name: data.name,
        reportGroup: data.reportGroup,
      });

      await transaction((tx) =>
        writeAudit(tx, {
          companyId,
          userId: user.id,
          action: 'LEDGER_ACCOUNT_UPDATED',
          entityType: 'Account',
          entityId: updated.id,
          after: data,
        }),
      );

      revalidatePath('/accounting/chart');
      revalidatePath('/reports/general-ledger');
      return { ok: true, id: updated.id, message: 'Account updated.' };
    }

    const data = ledgerAccountSchema.parse(raw);
    const created = await createLedgerAccount({
      companyId,
      code: data.code,
      name: data.name,
      type: data.type,
      reportGroup: data.reportGroup,
    });

    if (data.openingAmount && !dec(data.openingAmount).isZero()) {
      await postAccountOpeningBalance({
        accountId: created.id,
        companyId,
        userId: user.id,
        amount: data.openingAmount,
        asOf: data.openingDate ?? new Date(),
        currency: user.activeCompany.localCurrency,
      });
    }

    await transaction((tx) =>
      writeAudit(tx, {
        companyId,
        userId: user.id,
        action: 'LEDGER_ACCOUNT_CREATED',
        entityType: 'Account',
        entityId: created.id,
        after: data,
      }),
    );

    revalidatePath('/accounting/chart');
    revalidatePath('/reports/general-ledger');
    return { ok: true, id: created.id, message: 'Account added to the chart.' };
  } catch (error) {
    return invalid(error);
  }
}

export async function deactivateLedgerAccountAction(id: string): Promise<MasterFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const updated = await deactivateLedgerAccount({ id, companyId: user.activeCompany.id });
    await transaction((tx) =>
      writeAudit(tx, {
        companyId: user.activeCompany.id,
        userId: user.id,
        action: 'LEDGER_ACCOUNT_DEACTIVATED',
        entityType: 'Account',
        entityId: updated.id,
        after: { status: 'INACTIVE' },
      }),
    );
    revalidatePath('/accounting/chart');
    revalidatePath('/accounting/journal/new');
    return { ok: true, id: updated.id, message: 'Account deactivated.' };
  } catch (error) {
    return invalid(error);
  }
}

export async function reactivateLedgerAccountAction(id: string): Promise<MasterFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const updated = await reactivateLedgerAccount({ id, companyId: user.activeCompany.id });
    await transaction((tx) =>
      writeAudit(tx, {
        companyId: user.activeCompany.id,
        userId: user.id,
        action: 'LEDGER_ACCOUNT_REACTIVATED',
        entityType: 'Account',
        entityId: updated.id,
        after: { status: 'ACTIVE' },
      }),
    );
    revalidatePath('/accounting/chart');
    return { ok: true, id: updated.id, message: 'Account reactivated.' };
  } catch (error) {
    return invalid(error);
  }
}

export async function postLedgerOpeningAction(
  id: string,
  _prev: MasterFormState,
  formData: FormData,
): Promise<MasterFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const data = ledgerOpeningSchema.parse(formDataToObject(formData));
    const result = await postAccountOpeningBalance({
      accountId: id,
      companyId: user.activeCompany.id,
      userId: user.id,
      amount: data.amount,
      asOf: data.asOf,
      currency: data.currency,
      rateToUsd: data.rateToUsd,
      rateLocalPerUsd: data.rateLocalPerUsd,
    });

    await transaction((tx) =>
      writeAudit(tx, {
        companyId: user.activeCompany.id,
        userId: user.id,
        action: 'LEDGER_OPENING_POSTED',
        entityType: 'Account',
        entityId: id,
        after: { amount: data.amount, currency: data.currency, kind: result.kind },
      }),
    );

    revalidatePath('/accounting/chart');
    revalidatePath('/reports/general-ledger');
    revalidatePath('/reports/trial-balance');
    revalidatePath('/finance/cash-bank');
    return { ok: true, id, message: 'Opening balance posted.' };
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
