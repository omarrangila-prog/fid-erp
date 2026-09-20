import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createExpense, postExpense } from '@/lib/services/expense';
import { allocateOverheads, withdrawOverheadAllocation, getAllocatableOverheads } from '@/lib/services/overhead-allocation';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { getProfitAndLoss, getTrialBalanceReport, getBalanceSheet } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';
import { dec } from '@/lib/money';

/**
 * Overheads belong to the company, and stay there.
 *
 * The client's requirements are explicit: the optional allocation is a
 * management view. It must never move the general expense off the company
 * profit and loss, never touch the ledger, and never leave the statutory
 * statements different from what they were a moment before.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;

const FROM = utcDate('2026-04-01');
const TO = utcDate('2026-04-30');

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  // Two shipments of different sizes, so a weight basis has something to bite on.
  const contract = await createPurchaseContract(
    {
      companyId,
      vendorId: masters.vendor.id,
      contractDate: utcDate('2026-03-01'),
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '10',
      freightAmount: '0',
      contractReference: 'ICUL/FID/OVERHEAD',
      containers: 2,
      lines: [
        { itemId: masters.item.id, quantity: '30000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'OH-1' },
        { itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60', containerNumber: 'OH-2' },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });

  // Office rent: a company cost with no shipment.
  const category = await prisma.expenseCategory.findFirstOrThrow({
    where: { companyId, status: 'ACTIVE', kind: 'GENERAL' },
    orderBy: { code: 'asc' },
  });
  const cash = await getCashAccount(companyId, 'MAD');
  const rent = await createExpense(
    {
      companyId,
      expenseDate: utcDate('2026-04-10'),
      expenseCategoryId: category.id,
      currency: 'MAD',
      amount: '10000',
      rateToUsd: '10',
      rateLocalPerUsd: '10',
      paymentMethod: 'CASH',
      cashBankAccountId: cash.id,
      kind: 'GENERAL',
      description: 'Office rent for April',
    },
    ctx.admin.id,
  );
  await postExpense({ id: rent.id, companyId, userId: ctx.admin.id });
}, 300_000);

describe('the optional management allocation', () => {
  it('shares the period overheads across shipments by weight', async () => {
    const before = await getAllocatableOverheads({ companyId, from: FROM, to: TO });
    expect(Number(before.totalUsd)).toBe(1000);

    const shipments = await getShipmentProfitability({ companyId });
    expect(shipments).toHaveLength(2);

    const allocation = await allocateOverheads({
      companyId,
      userId: ctx.admin.id,
      from: FROM,
      to: TO,
      basis: 'QUANTITY',
      shipments: shipments.map((s) => ({ shipmentId: s.shipmentId })),
      notes: 'April overheads',
    });

    // 30,000 and 10,000 KG: three quarters and one quarter of USD 1,000.
    const byShipment = new Map(allocation.lines.map((l) => [l.shipmentId, dec(l.amountUsd)]));
    const big = shipments.find((s) => Number(s.receivedQuantityKg) === 30000 || Number(s.purchaseQuantityKg) === 30000)!;
    const small = shipments.find((s) => s.shipmentId !== big.shipmentId)!;
    expect(Number(byShipment.get(big.shipmentId))).toBeCloseTo(750, 2);
    expect(Number(byShipment.get(small.shipmentId))).toBeCloseTo(250, 2);
    expect(Number(byShipment.get(big.shipmentId)) + Number(byShipment.get(small.shipmentId))).toBeCloseTo(1000, 2);
  }, 300_000);

  it('leaves the ledger, the company P&L, the trial balance and the balance sheet exactly as they were', async () => {
    // Everything measured before a second allocation, then after it.
    const snapshot = async () => ({
      journalLines: await prisma.journalLine.count({ where: { journalEntry: { companyId } } }),
      pnl: (await getProfitAndLoss({ companyId, from: FROM, to: TO })).totals.netProfitUsd.toString(),
      opex: (await getProfitAndLoss({ companyId, from: FROM, to: TO })).totals.operatingExpensesUsd.toString(),
      tb: (await getTrialBalanceReport({ companyId })).totals.debitUsd.toString(),
      bs: (await getBalanceSheet({ companyId, asOf: TO })).differenceUsd.toString(),
    });

    const before = await snapshot();
    const shipments = await getShipmentProfitability({ companyId });
    await allocateOverheads({
      companyId,
      userId: ctx.admin.id,
      from: FROM,
      to: TO,
      basis: 'EQUAL',
      shipments: shipments.map((s) => ({ shipmentId: s.shipmentId })),
    });
    const after = await snapshot();

    expect(after).toEqual(before);
    expect(Number(before.opex)).toBe(1000);

    // And the books still reconcile.
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);

  it('shows the share on shipment profitability, clearly apart from the accounting result', async () => {
    const shipments = await getShipmentProfitability({ companyId, from: FROM, to: TO });
    // The second allocation was equal, so both carry half.
    for (const shipment of shipments) {
      expect(Number(shipment.allocatedOverheadUsd)).toBeCloseTo(500, 2);
      expect(Number(shipment.profitAfterOverheadUsd)).toBeCloseTo(Number(shipment.netProfitUsd) - 500, 2);
    }
  }, 300_000);

  it('supersedes the earlier view of the same period rather than double counting', async () => {
    const active = await prisma.overheadAllocation.findMany({ where: { companyId, status: 'ACTIVE' } });
    expect(active).toHaveLength(1);
    const withdrawn = await prisma.overheadAllocation.count({ where: { companyId, status: 'WITHDRAWN' } });
    expect(withdrawn).toBe(1);
  }, 300_000);

  it('leaves the expense posted when the allocation is withdrawn', async () => {
    const active = await prisma.overheadAllocation.findFirstOrThrow({ where: { companyId, status: 'ACTIVE' } });
    await withdrawOverheadAllocation({ companyId, id: active.id, userId: ctx.admin.id });

    const expense = await prisma.expense.findFirstOrThrow({ where: { companyId, kind: 'GENERAL' } });
    expect(expense.status).toBe('POSTED');
    expect(expense.overheadAllocationId).toBeNull();
    expect(Number(expense.amountUsd)).toBe(1000);

    // Still on the company profit and loss, and the shipment share is gone.
    const pnl = await getProfitAndLoss({ companyId, from: FROM, to: TO });
    expect(Number(pnl.totals.operatingExpensesUsd)).toBe(1000);
    const shipments = await getShipmentProfitability({ companyId, from: FROM, to: TO });
    for (const shipment of shipments) expect(Number(shipment.allocatedOverheadUsd)).toBe(0);
  }, 300_000);
});
