import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../helpers';
import { buildDemoTenant, type DemoResult } from '@/lib/demo/build';
import { reconcile } from '@/lib/services/reconciliation';
import { getItemStock, getInventoryValuation } from '@/lib/services/stock';
import { getProfitAndLoss } from '@/lib/services/reports';
import { getReceivables } from '@/lib/services/receivables';
import { DEMO_PRESETS } from '@/lib/demo/presets';

/**
 * The demonstration customer must be a real, balanced set of books — four
 * businesses in four currencies from one engine — and entirely fictional.
 */
let demo: DemoResult;

beforeAll(async () => {
  await resetDatabase();
  demo = await buildDemoTenant({ ownerEmail: 'demo@demo.test', ownerPassword: 'Demo-Passw0rd-2026' });
}, 900_000);

describe('the demo customer', () => {
  it('has four companies in four books currencies', async () => {
    const companies = await prisma.company.findMany({ where: { organizationId: demo.organizationId }, orderBy: { code: 'asc' } });
    expect(companies.map((c) => c.localCurrency).sort()).toEqual(['AED', 'GBP', 'MAD', 'PKR']);
    expect(companies).toHaveLength(4);
  });

  for (const spec of DEMO_PRESETS) {
    describe(spec.label, () => {
      it('reconciles completely', async () => {
        const co = demo.companies.find((c) => c.key === spec.key)!;
        const result = await reconcile(co.id);
        expect(result.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
      });

      it('shows the whole cycle: stock, receivables, profit', async () => {
        const co = demo.companies.find((c) => c.key === spec.key)!;
        const stock = await getItemStock(co.id);
        expect(stock.length).toBeGreaterThan(0);
        expect((await getInventoryValuation(co.id)).length).toBeGreaterThan(0);
        expect((await getReceivables({ companyId: co.id })).length).toBeGreaterThan(0);
        const pnl = await getProfitAndLoss({ companyId: co.id, from: new Date('2000-01-01'), to: new Date('2099-12-31') });
        expect(Number(pnl.totals.netProfitUsd)).not.toBe(0);
        const invoices = await prisma.salesInvoice.count({ where: { companyId: co.id, status: 'POSTED' } });
        expect(invoices).toBeGreaterThanOrEqual(2);
        const unpaid = await prisma.salesInvoice.count({ where: { companyId: co.id, status: 'POSTED', allocations: { none: {} } } });
        expect(unpaid).toBeGreaterThanOrEqual(1);
      });
    });
  }

  it('contains nothing real: every party, address and number is marked as an example', async () => {
    const text = JSON.stringify([
      await prisma.customer.findMany({ where: { company: { organizationId: demo.organizationId } }, select: { email: true } }),
      await prisma.vendor.findMany({ where: { company: { organizationId: demo.organizationId } }, select: { email: true } }),
    ]);
    const emails = text.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(8);
    expect(emails.every((e) => e.endsWith('.example'))).toBe(true);
    // And none of FID’s.
    expect(JSON.stringify(DEMO_PRESETS)).not.toMatch(/FID|IPSEN|ICUL|Radouan|Ridwan|Attijari/i);
  });

  it('keeps the demo apart from any other customer', async () => {
    const fid = await prisma.company.findMany({ where: { code: { in: ['FID-DXB', 'FID-MA'] } }, select: { organizationId: true } });
    expect(fid.every((c) => c.organizationId !== demo.organizationId)).toBe(true);
  });
});
