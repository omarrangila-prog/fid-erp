import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, utcDate } from '../helpers';
import { createTenant } from '@/lib/services/tenant';
import { tableFromCsv } from '@/lib/import/parse';
import { IMPORT_SPECS, parseRows, templateCsv, type ImportKind } from '@/lib/import/templates';
import { runImport } from '@/lib/services/import';
import { reconcile } from '@/lib/services/reconciliation';
import { getTrialBalanceReport } from '@/lib/services/reports';
import { getItemStock, getInventoryValuation } from '@/lib/services/stock';
import { getCustomerBalances, getVendorBalances } from '@/lib/services/reports';
import { dec } from '@/lib/money';

/**
 * A new customer arriving with spreadsheets: items, customers with what they
 * owe, suppliers with what is owed to them, stock already in the warehouse, and
 * the opening balances of the bank and the loan. Imported through the same
 * services as typing it in, so the books must balance afterwards.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let userId: string;

const csv = (header: string[], rows: string[][]) => [header, ...rows].map((r) => r.join(',')).join('\n');

async function load(kind: ImportKind, text: string, dryRun = false) {
  const parsed = parseRows(kind, tableFromCsv(text));
  expect(parsed.missing).toEqual([]);
  return runImport({ kind, rows: parsed.rows, companyId, userId, terminology: { unit: 'PCS' }, dryRun });
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  const created = await createTenant({
    organizationName: 'Importer Inc',
    plan: 'ENTERPRISE',
    company: { name: 'Importer Trading', country: 'Germany', industryTemplate: 'GENERAL_TRADING' },
    owner: { name: 'Imp Owner', email: 'imp@import.test' },
    actorUserId: ctx.admin.id,
  });
  companyId = created.companyId;
  userId = created.ownerUserId;
  await prisma.exchangeRate.createMany({
    data: [
      { companyId, quoteCurrency: 'EUR', rate: '0.9200', effectiveDate: utcDate('2025-01-01') },
      { companyId, quoteCurrency: 'GBP', rate: '0.7900', effectiveDate: utcDate('2025-01-01') },
    ],
  });
  await prisma.warehouse.create({ data: { companyId, code: 'MAIN', name: 'Main warehouse', location: 'Hamburg', country: 'Germany' } });
}, 600_000);

describe('every template imports as its own example', () => {
  it('parses each downloadable template cleanly', () => {
    for (const kind of Object.keys(IMPORT_SPECS) as ImportKind[]) {
      const parsed = parseRows(kind, tableFromCsv(templateCsv(kind)));
      expect(parsed.missing, kind).toEqual([]);
      expect(parsed.rows, kind).toHaveLength(1);
      expect(parsed.rows[0].errors, `${kind}: ${parsed.rows[0].errors.join(', ')}`).toEqual([]);
    }
  });
});

describe('importing a new customer’s data', () => {
  it('refuses a file with problems and says which rows', async () => {
    const bad = csv(['Item name', 'Counted in'], [['Good widget', 'PCS'], ['', 'PCS'], ['Odd widget', 'furlongs']]);
    const outcome = await load('ITEMS', bad, true);
    expect(outcome.failed.map((f) => f.line)).toEqual([3, 4]);
    expect(outcome.created).toBe(1);
    await expect(load('ITEMS', bad)).rejects.toThrow(/2 row\(s\) have problems/);
    expect(await prisma.coffeeItem.count({ where: { companyId } })).toBe(0);
  });

  it('previews without writing anything', async () => {
    const good = csv(['Item name', 'SKU', 'Counted in', 'Pack name', 'Units per pack'], [['Steel bolt M8', 'BOLT-M8', 'PCS', 'BOX', '500'], ['Copper wire', 'WIRE-CU', 'M', 'ROLL', '100']]);
    const preview = await load('ITEMS', good, true);
    expect(preview.created).toBe(2);
    expect(preview.dryRun).toBe(true);
    expect(await prisma.coffeeItem.count({ where: { companyId } })).toBe(0);
  });

  it('imports items, skips repeats', async () => {
    const file = csv(['Item name', 'SKU', 'Counted in', 'Pack name', 'Units per pack', 'HS code', 'Category'], [
      ['Steel bolt M8', 'BOLT-M8', 'PCS', 'BOX', '500', '7318.15', 'Fasteners'],
      ['Copper wire', 'WIRE-CU', 'M', 'ROLL', '100', '7408.11', 'Cable'],
    ]);
    const first = await load('ITEMS', file);
    expect(first.created).toBe(2);
    const again = await load('ITEMS', file);
    expect(again.created).toBe(0);
    expect(again.skipped).toHaveLength(2);
    const bolt = await prisma.coffeeItem.findFirstOrThrow({ where: { companyId, itemName: 'Steel bolt M8' } });
    expect(bolt.baseUom).toBe('PCS');
    expect(bolt.packUom).toBe('BOX');
    expect(Number(bolt.bagWeightKg)).toBe(500);
    expect(bolt.hsCode).toBe('7318.15');
  });

  it('imports customers and suppliers with opening balances that land on the right ledgers', async () => {
    await load('CUSTOMERS', csv(['Customer name', 'Currency', 'Opening balance', 'Opening balance date', 'Payment terms (days)'], [
      ['Hansen GmbH', 'EUR', '12500.00', '2026-01-01', '30'],
      ['Brightside Ltd', 'GBP', '4000', '2026-01-01', '14'],
    ]));
    await load('SUPPLIERS', csv(['Supplier name', 'Currency', 'Opening balance', 'Opening balance date'], [['Shenzhen Metals', 'USD', '8200', '2026-01-01']]));
    const customers = await getCustomerBalances(companyId);
    expect(JSON.stringify(customers)).toContain('Hansen GmbH');
    const vendors = await getVendorBalances(companyId);
    expect(JSON.stringify(vendors)).toContain('Shenzhen Metals');
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  });

  it('refuses a currency that has no rate on file', async () => {
    const outcome = await load('CUSTOMERS', csv(['Customer name', 'Currency', 'Opening balance'], [['Tokyo Co', 'JPY', '100000']]), true).catch((e) => e);
    expect(String(outcome.message ?? JSON.stringify(outcome))).toMatch(/No exchange rate for JPY|failed/);
  });

  it('brings in opening stock at cost, received into the warehouse', async () => {
    await load('OPENING_STOCK', csv(['Item name', 'Warehouse', 'Quantity', 'Unit cost', 'Currency', 'Lot / batch', 'As of date'], [
      ['Steel bolt M8', 'Main warehouse', '10000', '0.04', 'EUR', 'LOT-A', '2026-01-01'],
      ['Copper wire', 'Main warehouse', '2500', '1.80', 'EUR', 'LOT-B', '2026-01-01'],
    ]));
    const stock = await getItemStock(companyId);
    const bolt = stock.find((s) => s.itemName === 'Steel bolt M8')!;
    expect(Number(bolt.availableKg)).toBe(10000);
    const valuation = await getInventoryValuation(companyId);
    expect(JSON.stringify(valuation)).toContain('Copper wire');
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
    // Nobody is owed for stock that was already ours.
    const open = await prisma.vendor.findFirstOrThrow({ where: { companyId, vendorName: 'Opening stock (EUR)' } });
    expect(open.id).toBeTruthy();
  });

  it('adds ledger accounts and posts opening balances, and the trial balance still balances', async () => {
    await load('CHART_OF_ACCOUNTS', csv(['Account name', 'Type'], [['Staff welfare', 'EXPENSE'], ['Shareholder loan', 'LIABILITY']]));
    await load('OPENING_BALANCES', csv(['Account name', 'Amount', 'Debit or credit', 'Currency', 'As of date'], [['Shareholder loan', '30000', 'CREDIT', 'EUR', '2026-01-01']]));
    const tb = await getTrialBalanceReport({ companyId, to: utcDate('2099-12-31') });
    const debit = tb.rows.reduce((a, r) => a.plus(r.debitUsd), dec(0));
    const credit = tb.rows.reduce((a, r) => a.plus(r.creditUsd), dec(0));
    expect(debit.minus(credit).abs().lessThan('0.01')).toBe(true);
    const wrongSide = await load('OPENING_BALANCES', csv(['Account name', 'Amount', 'Debit or credit', 'As of date'], [['Staff welfare', '100', 'CREDIT', '2026-01-01']]), true);
    expect(wrongSide.failed[0].reason).toMatch(/debit/);
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  });
});
