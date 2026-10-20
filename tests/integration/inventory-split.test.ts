import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { postJournalEntry } from '@/lib/services/accounting';
import { computeInventorySplit, restateInventorySplit } from '@/lib/services/inventory-split';
import { transaction } from '@/lib/db';
import { ACCOUNT_KEYS } from '@/lib/constants';

/**
 * The ledger's line between stock and cost of sales is kept where the costing
 * puts it: drift is restated, a second run is a no-op, and a difference in the
 * total (not a split) is never "fixed" by moving it between the two.
 */
let companyId: string;
let userId: string;

beforeAll(async () => {
  await resetDatabase();
  const ctx = await getContext();
  companyId = ctx.morocco.id;
  userId = ctx.admin.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '9.90', effectiveDate: utcDate('2026-01-01') } });
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-06-01'), vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '9.90', freightAmount: '0',
      contractReference: 'ICUL/FID/SPLIT/001',
      lines: [0, 1].map((i) => ({ itemId: masters.item.id, quantity: '12500', unit: 'KG' as const, unitPrice: '4.00', bagWeightKg: '60', lotNumber: `SP-L${i}`, batchNumber: `SP-B${i}`, containerNumber: `SPBOX0${i}` })),
    },
    userId,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId });
  const batches = await prisma.batch.findMany({ where: { purchaseContractId: contract.id }, orderBy: { batchNumber: 'asc' } });
  await receiveEverything({ companyId, purchaseContractId: contract.id, warehouseId: masters.warehouses[0].id, userId, receiptDate: utcDate('2026-07-01') });
  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-07-15'), customerId: masters.customer.id, currency: 'MAD', rateToUsd: '9.90', rateLocalPerUsd: '9.90',
      lines: [{ batchId: batches[0].id, warehouseId: masters.warehouses[0].id, quantity: '7500', unit: 'KG' as const, unitPrice: '45' }],
    },
    userId,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId });
  // A shipment cost after part of the shipment sold: the case that drifts.
  const category = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, kind: 'SHIPMENT', capitaliseByDefault: true } });
  const cash = await getCashAccount(companyId, 'MAD');
  const late = await createExpense(
    {
      companyId, expenseDate: utcDate('2026-08-01'), expenseCategoryId: category.id, shipmentId: batches[0].shipmentId,
      currency: 'MAD', amount: '30000', rateToUsd: '10.30', rateLocalPerUsd: '10.30', kind: 'SHIPMENT',
      capitaliseToLandedCost: true, allocationMethod: 'PER_CONTAINER', paymentMethod: 'BANK_TRANSFER', cashBankAccountId: cash.id, description: 'Late customs',
    } as never,
    userId,
  );
  await postExpense({ id: late.id, companyId, userId });
}, 300_000);

const manual = (lines: Array<{ key: string; direction: 'DEBIT' | 'CREDIT'; amount: string }>) =>
  transaction((tx) =>
    postJournalEntry(tx, {
      companyId, entryDate: utcDate('2026-08-02'), description: 'Test entry', sourceType: 'MANUAL', sourceId: `test-${Math.random()}`, createdById: userId,
      localCurrency: 'MAD', rateLocalPerUsd: 1,
      lines: lines.map((l) => ({ accountKey: l.key, direction: l.direction, currency: 'MAD', amount: l.amount, rateToUsd: '9.90', description: 'test', localOnly: true }) as never),
    }),
  );

describe('stock / cost-of-sales restatement', () => {
  it('restates whatever the postings left, to the dirham, and changes no total', async () => {
    const before = await computeInventorySplit(companyId);
    expect(before.totalGap.abs().lessThan('0.05')).toBe(true);
    const result = await restateInventorySplit({ companyId, userId, trigger: 'a test' });
    const after = await computeInventorySplit(companyId);
    expect(after.difference.abs().lessThan('0.01')).toBe(true);
    expect(after.glInventory.plus(after.glCogs).toFixed(2)).toBe(before.glInventory.plus(before.glCogs).toFixed(2));
    if (result.posted) {
      const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: result.entryId }, include: { lines: true } });
      // Dirhams only: no dollar moves.
      expect(entry.lines.every((l) => Number(l.debitUsd) === 0 && Number(l.creditUsd) === 0)).toBe(true);
      expect(await prisma.auditLog.count({ where: { companyId, action: 'INVENTORY_SPLIT_RESTATED' } })).toBe(1);
    }
  }, 300_000);

  it('corrects drift tagged to its shipment, and a second run does nothing', async () => {
    // Drift: MAD 1,234.56 too much in cost of sales, stock short by the same.
    await manual([
      { key: ACCOUNT_KEYS.COST_OF_GOODS_SOLD, direction: 'DEBIT', amount: '1234.56' },
      { key: ACCOUNT_KEYS.INVENTORY, direction: 'CREDIT', amount: '1234.56' },
    ]);
    expect((await computeInventorySplit(companyId)).difference.toFixed(2)).toBe('1234.56');
    const first = await restateInventorySplit({ companyId, userId, trigger: 'a test' });
    expect(first.posted).toBe(true);
    expect((await computeInventorySplit(companyId)).difference.abs().lessThan('0.01')).toBe(true);
    const second = await restateInventorySplit({ companyId, userId, trigger: 'a test' });
    expect(second).toMatchObject({ posted: false, reason: 'in step' });
  }, 300_000);

  it('refuses a difference in the total: that is not a split', async () => {
    await manual([
      { key: ACCOUNT_KEYS.INVENTORY, direction: 'DEBIT', amount: '500' },
      { key: ACCOUNT_KEYS.FX_GAIN_LOSS, direction: 'CREDIT', amount: '500' },
    ]);
    const result = await restateInventorySplit({ companyId, userId, trigger: 'a test' });
    expect(result.posted).toBe(false);
    expect(result.posted ? '' : result.reason).toMatch(/differ on the total/);
  }, 300_000);
});
