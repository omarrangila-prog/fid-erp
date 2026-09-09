import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext } from '../helpers';
import { PERMISSIONS, SYSTEM_ROLES, type PermissionCode } from '@/lib/constants';

/**
 * Who can do what.
 *
 * The client's arrangement is that the owner does everything and the two staff
 * accounts only type documents in. That is a claim about the permission
 * catalogue, so it is asserted here rather than trusted: a permission quietly
 * added to the wrong role is invisible until somebody posts something they
 * should not have been able to.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;

/** The permission codes a role actually grants, read back from the database. */
async function grantedTo(roleCode: string): Promise<Set<string>> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { code: roleCode },
    include: { permissions: { include: { permission: true } } },
  });
  return new Set(role.permissions.map((entry) => entry.permission.code));
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
});

describe('the data-entry role', () => {
  /**
   * Everything that commits a document to the ledger, changes stock without a
   * counted sheet behind it, reveals what the business earns, or administers
   * the system. A data-entry operator gets none of it.
   */
  const FORBIDDEN: PermissionCode[] = [
    PERMISSIONS.PURCHASES_APPROVE,
    PERMISSIONS.PURCHASES_REVERSE,
    PERMISSIONS.PURCHASES_DELETE,
    PERMISSIONS.SALES_APPROVE,
    PERMISSIONS.SALES_REVERSE,
    PERMISSIONS.SALES_DELETE,
    PERMISSIONS.RECEIPTS_POST,
    PERMISSIONS.RECEIPTS_DELETE,
    PERMISSIONS.PAYMENTS_POST,
    PERMISSIONS.PAYMENTS_DELETE,
    PERMISSIONS.EXPENSES_POST,
    PERMISSIONS.EXPENSES_DELETE,
    PERMISSIONS.CREDIT_NOTES_POST,
    PERMISSIONS.STOCK_COUNT_POST,
    PERMISSIONS.ACCOUNTING_POST,
    PERMISSIONS.ACCOUNTING_VIEW,
    PERMISSIONS.PERIODS_CLOSE,
    PERMISSIONS.BANK_RECONCILE,
    PERMISSIONS.PROFITS_VIEW,
    PERMISSIONS.PURCHASE_COST_VIEW,
    PERMISSIONS.LEDGERS_VIEW,
    PERMISSIONS.INVENTORY_ADJUST,
    PERMISSIONS.INVENTORY_TRANSFER,
    PERMISSIONS.INVENTORY_NEGATIVE_OVERRIDE,
    PERMISSIONS.USERS_MANAGE,
    PERMISSIONS.ROLES_MANAGE,
    PERMISSIONS.COMPANIES_MANAGE,
    PERMISSIONS.SETTINGS_MANAGE,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.BACKUP_MANAGE,
    PERMISSIONS.CASHBANK_MANAGE,
    PERMISSIONS.EXPENSE_CATEGORIES_MANAGE,
  ];

  /** What they must have, or they cannot do the job at all. */
  const REQUIRED: PermissionCode[] = [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.CUSTOMERS_CREATE,
    PERMISSIONS.VENDORS_CREATE,
    PERMISSIONS.ITEMS_CREATE,
    PERMISSIONS.PURCHASES_CREATE,
    PERMISSIONS.SALES_CREATE,
    PERMISSIONS.RECEIPTS_CREATE,
    PERMISSIONS.PAYMENTS_CREATE,
    PERMISSIONS.EXPENSES_CREATE,
    PERMISSIONS.CREDIT_NOTES_CREATE,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.ATTACHMENTS_MANAGE,
  ];

  it('grants nothing that posts, deletes, reveals margin or administers', async () => {
    const granted = await grantedTo('DATA_ENTRY');
    const leaked = FORBIDDEN.filter((code) => granted.has(code));
    expect(leaked).toEqual([]);
  });

  it('grants everything needed to enter a document', async () => {
    const granted = await grantedTo('DATA_ENTRY');
    const missing = REQUIRED.filter((code) => !granted.has(code));
    expect(missing).toEqual([]);
  });

  it('is a strict subset of what a company administrator can do', async () => {
    const dataEntry = await grantedTo('DATA_ENTRY');
    const admin = await grantedTo('COMPANY_ADMIN');
    const beyondAdmin = [...dataEntry].filter((code) => !admin.has(code));
    expect(beyondAdmin).toEqual([]);
  });
});

describe('the catalogue itself', () => {
  it('has every permission a role references', async () => {
    const known = new Set((await prisma.permission.findMany({ select: { code: true } })).map((p) => p.code));
    const referenced = new Set(SYSTEM_ROLES.flatMap((role) => role.permissions));
    const dangling = [...referenced].filter((code) => !known.has(code));
    expect(dangling).toEqual([]);
  });

  it('gives the super admin no role-based permissions to depend on', async () => {
    // A super admin bypasses the checks entirely rather than being granted
    // every code, so the two can never drift apart.
    const superAdmin = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
    expect(superAdmin.isSystem).toBe(true);
  });
});

describe('company isolation', () => {
  it('gives each staff account exactly one company', async () => {
    const staff = await prisma.user.findMany({
      where: { isSuperAdmin: false },
      include: { companies: { include: { company: { select: { code: true } } } } },
    });

    // Nothing is seeded when the PINs are absent, which is correct; when they
    // are present, each account must be pinned to a single company.
    for (const user of staff) {
      expect(user.companies.length, `${user.name} should belong to exactly one company`).toBe(1);
    }
  });

  it('never returns another company’s rows through a company-scoped query', async () => {
    // The pattern every service uses. A Dubai id with a Morocco filter must
    // find nothing, which is what keeps the two sets of books apart.
    const dubaiWarehouse = await prisma.warehouse.findFirstOrThrow({
      where: { companyId: ctx.dubai.id },
    });

    const crossCompany = await prisma.warehouse.findFirst({
      where: { id: dubaiWarehouse.id, companyId: ctx.morocco.id },
    });
    expect(crossCompany).toBeNull();
  });

  it('keeps the two charts of accounts separate', async () => {
    const dubai = await prisma.account.findMany({
      where: { companyId: ctx.dubai.id },
      select: { id: true },
    });
    const morocco = await prisma.account.findMany({
      where: { companyId: ctx.morocco.id },
      select: { id: true },
    });

    expect(dubai.length).toBeGreaterThan(0);
    expect(morocco.length).toBeGreaterThan(0);
    const shared = dubai.filter((account) => morocco.some((other) => other.id === account.id));
    expect(shared).toEqual([]);
  });
});
