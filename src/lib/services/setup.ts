import { prisma } from '@/lib/db';
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';

/**
 * Setup progress.
 *
 * A brand-new company has nothing in it, and a screen full of zeroes tells a
 * user nothing about what to do next. This service answers one question — what
 * is already in place and what still needs doing — so the dashboard can show a
 * short, ordered list of next steps instead of empty charts.
 *
 * Every step carries the permission needed to complete it; a sales user is not
 * shown "add a supplier" as an outstanding task they cannot action.
 */

export type SetupStepId =
  | 'warehouses'
  | 'cash-accounts'
  | 'items'
  | 'vendors'
  | 'customers'
  | 'purchase'
  | 'receipt-of-goods'
  | 'sale'
  | 'money-in';

export type SetupStep = {
  id: SetupStepId;
  phase: 'setup' | 'trading';
  title: string;
  description: string;
  href: string;
  actionLabel: string;
  /** Needed to carry the step out. */
  permission: PermissionCode;
  done: boolean;
  count: number;
};

export type SetupStatus = {
  steps: SetupStep[];
  /** Steps completed / total, over the whole list. */
  completed: number;
  total: number;
  /** True when the company has never posted a purchase, sale or receipt. */
  isNewCompany: boolean;
  /** True when every step is done — the checklist can be put away. */
  isComplete: boolean;
};

/** Drops the permission code so the step can be handed to a client component. */
export function toChecklistStep(step: SetupStep): Omit<SetupStep, 'permission'> {
  const { id, phase, title, description, href, actionLabel, done, count } = step;
  return { id, phase, title, description, href, actionLabel, done, count };
}

export async function getSetupStatus(companyId: string): Promise<SetupStatus> {
  const where = { companyId, status: 'ACTIVE' as const };

  const [warehouses, cashAccounts, items, vendors, customers, purchases, goodsReceipts, sales, receipts] =
    await Promise.all([
      prisma.warehouse.count({ where }),
      prisma.cashBankAccount.count({ where }),
      prisma.coffeeItem.count({ where }),
      prisma.vendor.count({ where }),
      prisma.customer.count({ where }),
      prisma.purchaseContract.count({ where: { companyId } }),
      prisma.goodsReceipt.count({ where: { companyId } }),
      prisma.salesInvoice.count({ where: { companyId } }),
      prisma.receipt.count({ where: { companyId } }),
    ]);

  const steps: SetupStep[] = [
    {
      id: 'warehouses',
      phase: 'setup',
      title: 'Check your warehouses',
      description: 'Stock is counted per warehouse, so every receipt and transfer needs one.',
      href: '/warehouses',
      actionLabel: 'Open warehouses',
      permission: PERMISSIONS.WAREHOUSES_VIEW,
      done: warehouses > 0,
      count: warehouses,
    },
    {
      id: 'cash-accounts',
      phase: 'setup',
      title: 'Check your cash and bank accounts',
      description: 'One account per currency. Opening balances can be entered here.',
      href: '/finance/cash-bank',
      actionLabel: 'Open cash & bank',
      permission: PERMISSIONS.CASHBANK_VIEW,
      done: cashAccounts > 0,
      count: cashAccounts,
    },
    {
      id: 'items',
      phase: 'setup',
      title: 'Add the coffee you trade',
      description: 'Origin, grade, screen size, process and bag weight — entered once, used everywhere.',
      href: '/items',
      actionLabel: 'Add coffee',
      permission: PERMISSIONS.ITEMS_CREATE,
      done: items > 0,
      count: items,
    },
    {
      id: 'vendors',
      phase: 'setup',
      title: 'Add your suppliers',
      description: 'The exporters and estates you buy from.',
      href: '/vendors',
      actionLabel: 'Add supplier',
      permission: PERMISSIONS.VENDORS_CREATE,
      done: vendors > 0,
      count: vendors,
    },
    {
      id: 'customers',
      phase: 'setup',
      title: 'Add your customers',
      description: 'Credit limit and payment terms drive the ageing and overdue alerts.',
      href: '/customers',
      actionLabel: 'Add customer',
      permission: PERMISSIONS.CUSTOMERS_CREATE,
      done: customers > 0,
      count: customers,
    },
    {
      id: 'purchase',
      phase: 'trading',
      title: 'Record your first purchase contract',
      description: 'What you agreed to buy. It does not add stock — it books the payable and the coffee in transit.',
      href: '/purchases/new',
      actionLabel: 'New purchase',
      permission: PERMISSIONS.PURCHASES_CREATE,
      done: purchases > 0,
      count: purchases,
    },
    {
      id: 'receipt-of-goods',
      phase: 'trading',
      title: 'Receive the coffee into a warehouse',
      description: 'This is the step that increases stock. Partial receipts are fine.',
      href: '/purchases',
      actionLabel: 'Open purchases',
      permission: PERMISSIONS.INVENTORY_VIEW,
      done: goodsReceipts > 0,
      count: goodsReceipts,
    },
    {
      id: 'sale',
      phase: 'trading',
      title: 'Raise your first sales invoice',
      description: 'Stock leaves the warehouse, the customer is invoiced and the profit is worked out.',
      href: '/sales/new',
      actionLabel: 'New sale',
      permission: PERMISSIONS.SALES_CREATE,
      done: sales > 0,
      count: sales,
    },
    {
      id: 'money-in',
      phase: 'trading',
      title: 'Record money received',
      description: 'Cash, bank transfer or cheque — allocated against the invoices it settles.',
      href: '/finance/receipts/new',
      actionLabel: 'New receipt',
      permission: PERMISSIONS.RECEIPTS_CREATE,
      done: receipts > 0,
      count: receipts,
    },
  ];

  const completed = steps.filter((step) => step.done).length;

  return {
    steps,
    completed,
    total: steps.length,
    isNewCompany: purchases === 0 && sales === 0 && receipts === 0,
    isComplete: completed === steps.length,
  };
}
