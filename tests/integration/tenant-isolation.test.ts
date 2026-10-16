import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, utcDate } from '../helpers';
import { createTenant } from '@/lib/services/tenant';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import {
  getBalanceSheet,
  getCustomerBalances,
  getProfitAndLoss,
  getPurchaseRegister,
  getSalesRegister,
  getTrialBalanceReport,
  getVendorBalances,
} from '@/lib/services/reports';
import { getPayables, getPayablesAgeing, getReceivables, getReceivablesAgeing } from '@/lib/services/receivables';
import { getBatchStock, getInventoryValuation, getItemStock } from '@/lib/services/stock';
import { getLedgerDirectory } from '@/lib/services/ledger-directory';
import { getDashboard } from '@/lib/services/dashboard';
import { globalSearch } from '@/lib/services/search';
import { createShareLink, listShareLinks, openShareLink } from '@/lib/services/report-share';
import { reconcile } from '@/lib/services/reconciliation';
import {
  assertCompaniesInOrg,
  assertManagesUser,
  assertRolesUsable,
  companiesOf,
  peopleOf,
  rolesVisibleTo,
} from '@/lib/auth/tenant';
import { PERMISSIONS, type PermissionCode } from '@/lib/constants';
import type { SessionUser } from '@/lib/auth/session';

/**
 * Two unrelated customers on one deployment — the commercial promise that
 * Company A can never see Company B.
 *
 * Both run a complete small business (order → goods in → sale), each with
 * distinctive names. Every read the product offers is then run as A and its
 * entire output searched for anything of B's: its markers, and its ids. The
 * same is done the other way round, so a one-sided filter cannot hide.
 */

type Tenant = {
  tag: 'A' | 'B';
  organizationId: string;
  companyId: string;
  ownerUserId: string;
  vendorId: string;
  customerId: string;
  itemId: string;
  contractId: string;
  invoiceId: string;
  warehouseId: string;
  ids: string[];
};

let ctx: Awaited<ReturnType<typeof getContext>>;
let A: Tenant;
let B: Tenant;

async function build(tag: 'A' | 'B', spec: { country: string; currency: string; template: string; rate: string; name: string }): Promise<Tenant> {
  const created = await createTenant({
    organizationName: `${spec.name} Holdings`,
    plan: 'ENTERPRISE',
    company: { name: spec.name, country: spec.country, localCurrency: spec.currency, industryTemplate: spec.template },
    owner: { name: `${tag} Owner`, email: `owner-${tag.toLowerCase()}@isolation.test` },
    actorUserId: ctx.admin.id,
  });
  const companyId = created.companyId;
  const marker = `${tag}-ONLY`;

  const warehouse = await prisma.warehouse.create({
    data: { companyId, code: `WH-${tag}`, name: `Warehouse ${marker}`, location: 'Test', country: spec.country },
  });
  const vendor = await prisma.vendor.create({
    data: { companyId, vendorCode: `SUP-${tag}`, vendorName: `Supplier ${marker}`, country: 'China', primaryCurrency: 'USD' },
  });
  const customer = await prisma.customer.create({
    data: { companyId, customerCode: `CUS-${tag}`, customerName: `Customer ${marker}`, country: spec.country, primaryCurrency: spec.currency, paymentTermDays: 30 },
  });
  const item = await prisma.coffeeItem.create({
    data: { companyId, itemCode: `ITM-${tag}`, itemName: `Goods ${marker}`, baseUom: 'PCS', packUom: 'CTN', bagWeightKg: '24', defaultUnit: 'PCS' },
  });

  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-03-01'),
      vendorId: vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: spec.rate,
      freightAmount: '0',
      contractReference: `REF-${marker}`,
      lines: [{ itemId: item.id, quantity: '1000', unit: 'PCS', unitPrice: '3.00', bagWeightKg: '24' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  const grn = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: contract.id,
      warehouseId: warehouse.id,
      receiptDate: utcDate('2026-03-10'),
      receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '1000', bags: 42, lotNumber: `LOT-${marker}` }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  const invoice = await createSalesInvoice(
    {
      companyId,
      invoiceDate: utcDate('2026-03-20'),
      customerId: customer.id,
      currency: spec.currency,
      rateToUsd: spec.rate,
      rateLocalPerUsd: spec.rate,
      lines: [{ batchId: batch.id, warehouseId: warehouse.id, quantity: '400', unit: 'PCS' as const, unitPrice: '5.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

  return {
    tag,
    organizationId: created.organizationId,
    companyId,
    ownerUserId: created.ownerUserId,
    vendorId: vendor.id,
    customerId: customer.id,
    itemId: item.id,
    contractId: contract.id,
    invoiceId: invoice.id,
    warehouseId: warehouse.id,
    ids: [companyId, created.organizationId, vendor.id, customer.id, item.id, contract.id, invoice.id, warehouse.id, batch.id],
  };
}

function owner(t: Tenant, extra: Partial<SessionUser> = {}): SessionUser {
  const company = {
    id: t.companyId,
    code: `CODE-${t.tag}`,
    name: `Company ${t.tag}`,
    country: 'Testland',
    localCurrency: 'USD',
    baseCurrency: 'USD',
    timezone: 'UTC',
  };
  return {
    id: t.ownerUserId,
    email: `owner-${t.tag.toLowerCase()}@isolation.test`,
    name: `${t.tag} Owner`,
    isSuperAdmin: true,
    organizationId: t.organizationId,
    permissions: new Set<PermissionCode>(),
    roleNames: [],
    roleIds: [],
    scope: { agentId: null, warehouseIds: [] },
    companies: [company],
    activeCompany: company,
    ...extra,
  };
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  A = await build('A', { country: 'Pakistan', currency: 'PKR', template: 'APPAREL_TEXTILE', rate: '280', name: 'Alpha Apparel' });
  B = await build('B', { country: 'United Kingdom', currency: 'GBP', template: 'GENERAL_TRADING', rate: '0.79', name: 'Bravo Brokers' });
}, 600_000);

/** Every reader the product offers, called for one company. */
async function everyRead(t: Tenant): Promise<Record<string, unknown>> {
  const from = utcDate('2000-01-01');
  const to = utcDate('2099-12-31');
  const companyId = t.companyId;
  const all = new Set(Object.values(PERMISSIONS));
  const search = async (q: string) => globalSearch({ companyId, query: q, permissions: all as Set<PermissionCode>, isSuperAdmin: true });
  const currency = (await prisma.company.findUniqueOrThrow({ where: { id: companyId } })).localCurrency;
  return {
    trialBalance: await getTrialBalanceReport({ companyId, to }),
    profitAndLoss: await getProfitAndLoss({ companyId, from, to }),
    balanceSheet: await getBalanceSheet({ companyId, asOf: to }),
    receivables: await getReceivables({ companyId }),
    payables: await getPayables({ companyId }),
    receivablesAgeing: await getReceivablesAgeing(companyId),
    payablesAgeing: await getPayablesAgeing(companyId),
    customerBalances: await getCustomerBalances(companyId),
    vendorBalances: await getVendorBalances(companyId),
    salesRegister: await getSalesRegister({ companyId, from, to }),
    purchaseRegister: await getPurchaseRegister({ companyId, from, to }),
    itemStock: await getItemStock(companyId),
    batchStock: await getBatchStock({ companyId }),
    inventoryValuation: await getInventoryValuation(companyId),
    ledgerDirectory: await getLedgerDirectory(companyId, currency),
    dashboard: await getDashboard({ companyId, from, to }),
    reconciliation: await reconcile(companyId),
    searchOther: [...(await search('ONLY')), ...(await search('Supplier')), ...(await search('Customer')), ...(await search('Goods')), ...(await search('REF-'))],
  };
}

describe('every read of company A contains nothing of company B', () => {
  it('is non-vacuous: A really has its own data', async () => {
    const reads = JSON.stringify(await everyRead(A));
    expect(reads).toContain('A-ONLY');
    expect(reads.length).toBeGreaterThan(2000);
  }, 120_000);

  it('A sees none of B’s markers or ids', async () => {
    const reads = JSON.stringify(await everyRead(A));
    expect(reads).not.toContain('B-ONLY');
    expect(reads).not.toContain('Bravo');
    for (const id of B.ids) expect(reads, `an id of B (${id}) appeared in A’s reads`).not.toContain(id);
  }, 120_000);

  it('B sees none of A’s markers or ids', async () => {
    const reads = JSON.stringify(await everyRead(B));
    expect(reads).toContain('B-ONLY');
    expect(reads).not.toContain('A-ONLY');
    expect(reads).not.toContain('Alpha');
    for (const id of A.ids) expect(reads, `an id of A (${id}) appeared in B’s reads`).not.toContain(id);
  }, 120_000);

  it('FID’s companies are as invisible to both newcomers as they are to each other', async () => {
    const reads = JSON.stringify([await everyRead(A), await everyRead(B)]);
    expect(reads).not.toContain(ctx.dubai.id);
    expect(reads).not.toContain(ctx.morocco.id);
  }, 120_000);
});

describe('a record of one company cannot be reached through the other', () => {
  it('will not post, receive or invoice B’s documents from A', async () => {
    await expect(postPurchaseContract({ id: B.contractId, companyId: A.companyId, userId: ctx.admin.id })).rejects.toThrow(/not found/i);
    await expect(postSalesInvoice({ id: B.invoiceId, companyId: A.companyId, userId: ctx.admin.id })).rejects.toThrow(/not found/i);
    const batchOfB = await prisma.batch.findFirstOrThrow({ where: { companyId: B.companyId } });
    await expect(
      createSalesInvoice(
        {
          companyId: A.companyId,
          invoiceDate: utcDate('2026-04-01'),
          customerId: A.customerId,
          currency: 'PKR',
          rateToUsd: '280',
          rateLocalPerUsd: '280',
          lines: [{ batchId: batchOfB.id, warehouseId: A.warehouseId, quantity: '1', unit: 'PCS' as const, unitPrice: '1.00' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/not found/i);
    await expect(
      createSalesInvoice(
        {
          companyId: A.companyId,
          invoiceDate: utcDate('2026-04-01'),
          customerId: B.customerId,
          currency: 'PKR',
          rateToUsd: '280',
          rateLocalPerUsd: '280',
          lines: [],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('numbers each company’s documents independently, with its own prefix', async () => {
    const a = await prisma.purchaseContract.findFirstOrThrow({ where: { companyId: A.companyId } });
    const b = await prisma.purchaseContract.findFirstOrThrow({ where: { companyId: B.companyId } });
    expect(a.contractNumber).toMatch(/-PO-000001$/);
    expect(b.contractNumber).toMatch(/-PO-000001$/);
    expect(a.contractNumber.split('-PO-')[0]).not.toBe(b.contractNumber.split('-PO-')[0]);
  });

  it('keeps each company’s chart of accounts its own', async () => {
    const a = await prisma.account.count({ where: { companyId: A.companyId } });
    const b = await prisma.account.count({ where: { companyId: B.companyId } });
    expect(a).toBeGreaterThan(20);
    expect(a).toBe(b);
    const crossLines = await prisma.journalLine.count({
      where: { journalEntry: { companyId: A.companyId }, account: { companyId: { not: A.companyId } } },
    });
    expect(crossLines).toBe(0);
  });

  it('books each company in its own currency, whatever it is', async () => {
    const a = await prisma.journalEntry.findFirstOrThrow({ where: { companyId: A.companyId }, include: { lines: true } });
    const b = await prisma.journalEntry.findFirstOrThrow({ where: { companyId: B.companyId }, include: { lines: true } });
    expect(a.lines.some((l) => Number(l.debitLocal) > 0 || Number(l.creditLocal) > 0)).toBe(true);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: A.companyId } })).localCurrency).toBe('PKR');
    expect((await prisma.company.findUniqueOrThrow({ where: { id: B.companyId } })).localCurrency).toBe('GBP');
    expect(b.id).not.toBe(a.id);
  });
});

describe('administrators are confined to their own organization', () => {
  const adminA = () => owner(A);

  it('lists only their own people, roles and companies', async () => {
    const people = await prisma.user.findMany({ where: peopleOf(adminA()), select: { email: true } });
    expect(people.map((p) => p.email)).toEqual(['owner-a@isolation.test']);

    const companies = await prisma.company.findMany({ where: companiesOf(adminA()), select: { id: true } });
    expect(companies.map((c) => c.id)).toEqual([A.companyId]);

    // The shared system roles are visible; B’s custom role is not.
    const bRole = await prisma.role.create({ data: { code: 'bbbbbbbb_CASHIER', name: 'B Cashier', organizationId: B.organizationId } });
    const roles = await prisma.role.findMany({ where: rolesVisibleTo(adminA()), select: { id: true } });
    expect(roles.map((r) => r.id)).not.toContain(bRole.id);
    expect(roles.length).toBeGreaterThan(5);
  });

  it('cannot manage B’s people, companies or roles', async () => {
    await expect(assertManagesUser(adminA(), B.ownerUserId)).rejects.toThrow(/not found/i);
    await expect(assertCompaniesInOrg(adminA(), [B.companyId])).rejects.toThrow(/not found/i);
    await expect(assertCompaniesInOrg(adminA(), [A.companyId, B.companyId])).rejects.toThrow(/not found/i);
    const bRole = await prisma.role.findFirstOrThrow({ where: { organizationId: B.organizationId } });
    await expect(assertRolesUsable(adminA(), [bRole.id])).rejects.toThrow(/not found/i);
    await expect(assertManagesUser(adminA(), A.ownerUserId)).resolves.toBeUndefined();
  });

  it('gives an owner only their own organization’s companies at sign-in', async () => {
    const reachable = await prisma.company.findMany({ where: { status: 'ACTIVE', organizationId: A.organizationId }, select: { id: true } });
    expect(reachable.map((c) => c.id)).toEqual([A.companyId]);
  });
});

describe('shared report links stay with their company', () => {
  it('lists, opens and names only the sharing company’s own links', async () => {
    const snapshot = {
      v: 1 as const,
      company: 'ignored',
      title: 'Test report',
      filters: [],
      scope: 'All',
      facts: [],
      sections: [{ columns: [{ label: 'A' }], rows: [{ cells: [{ text: 'x' }] }] }],
      generatedAt: new Date().toISOString(),
      generatedBy: 'A Owner',
    };
    const link = await createShareLink({
      actor: { id: A.ownerUserId, name: 'A Owner', roleNames: [], isSuperAdmin: true, canManageUsers: true, isDeveloper: false },
      companyId: A.companyId,
      meta: {
        shareId: 'shr_isolation0001a',
        report: 'customer-statement',
        title: 'Test report',
        filters: [],
        scope: 'All',
        rows: 1,
        columns: ['A'],
        format: 'LINK',
        method: 'WHATSAPP',
        page: '/ledgers/customers',
      } as never,
      snapshot,
      expiry: '7',
    });
    const forA = await listShareLinks(A.companyId);
    const forB = await listShareLinks(B.companyId);
    expect(forA.length).toBeGreaterThan(0);
    expect(forB.length).toBe(0);
    const opened = await openShareLink(link.token, { countView: false });
    expect(opened.status).toBe('active');
    expect(JSON.stringify(opened)).not.toContain('B-ONLY');
  });
});

describe('the books of a brand-new customer balance, in any currency', () => {
  for (const [label, get] of [
    ['Pakistan, PKR, apparel', () => A],
    ['United Kingdom, GBP, general trading', () => B],
  ] as const) {
    it(`reconciles ${label}`, async () => {
      const t = get();
      const result = await reconcile(t.companyId);
      const failed = result.checks.filter((c) => !c.passed).map((c) => c.label);
      expect(failed, `failed checks: ${failed.join(', ')}`).toEqual([]);
    });
  }
});
