import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getBatchCostings, getShipmentCostSheet } from '@/lib/services/landed-cost';
import { dec } from '@/lib/money';

/**
 * One costing, read the same way everywhere.
 *
 * Every screen that shows coffee also wants to show what it cost. Each one
 * working that out for itself is how a shipment page, an item page and a
 * report come to disagree about the same container — so there is one
 * calculation and the screens read it. These tests hold the shared answer to
 * the client's own figures and check it agrees with the shipment cost sheet.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let shipmentId: string;
let contractId: string;

const RATE = '9.60';

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });

  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: RATE, effectiveDate: utcDate('2026-01-01') },
  });

  const itemB = await prisma.coffeeItem.create({
    data: {
      companyId,
      itemCode: 'ITM-VIS-B',
      itemName: 'Uganda Robusta Screen 15',
      coffeeType: 'ROBUSTA',
      originCountry: 'Uganda',
      defaultUnit: 'KG',
      bagWeightKg: '60',
    },
  });

  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-02-02'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: RATE,
      freightAmount: '0',
      lines: [
        { itemId: masters.item.id, quantity: '20040', unit: 'KG', unitPrice: '4.108', bagWeightKg: '60', containerNumber: 'CONT-A', lotNumber: 'LOT-A' },
        { itemId: itemB.id, quantity: '21000', unit: 'KG', unitPrice: '3.998', bagWeightKg: '60', containerNumber: 'CONT-B', lotNumber: 'LOT-B' },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });

  const batches = await prisma.batch.findMany({
    where: { purchaseContractId: contract.id },
    orderBy: { batchNumber: 'asc' },
  });
  shipmentId = batches[0].shipmentId;
  contractId = contract.id;


  const grn = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: contract.id,
      warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-03-01'),
      receivedById: ctx.admin.id,
      // The lots were named on the contract; receiving under the same names
      // keeps one batch per line rather than splitting each in two.
      lines: batches.map((b) => ({ batchId: b.id, quantityKg: b.orderedQuantityKg.toString() })),
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  const category = await prisma.expenseCategory.findFirstOrThrow({
    where: { companyId, kind: 'SHIPMENT', status: 'ACTIVE' },
  });
  const cash = await getCashAccount(companyId, 'MAD');
  const expense = await createExpense(
    {
      companyId,
      expenseDate: utcDate('2026-03-05'),
      expenseCategoryId: category.id,
      shipmentId,
      currency: 'MAD',
      amount: '473941.22',
      rateToUsd: RATE,
      rateLocalPerUsd: RATE,
      paymentMethod: 'BANK_TRANSFER',
      cashBankAccountId: cash.id,
      kind: 'SHIPMENT',
      capitaliseToLandedCost: true,
      description: 'Clearing, transport and port charges',
    },
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
}, 300_000);

describe('the shared costing every screen reads', () => {
  it('answers for each container separately, with its own reference and container number', async () => {
    const rows = await getBatchCostings({ companyId, purchaseContractId: contractId });
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(row.reference).toBeTruthy();
      expect(row.containerNumber).toMatch(/^CONT-/);
      expect(row.warehouseName).toBeTruthy();
      expect(row.jobNumber).toBeTruthy();
      expect(row.localCurrency).toBe('MAD');
    }
  }, 240_000);

  it('gives the landed cost per kilo the client works out, in both currencies', async () => {
    const rows = await getBatchCostings({ companyId, purchaseContractId: contractId });

    expect(Number(rows[0].purchaseUsd)).toBeCloseTo(82_324.32, 2);
    expect(Number(rows[1].purchaseUsd)).toBeCloseTo(83_958.0, 2);

    // Half of MAD 473,941.22 each.
    expect(Number(rows[0].allocatedExpenseLocal)).toBeCloseTo(236_970.61, 0);
    expect(Number(rows[1].allocatedExpenseLocal)).toBeCloseTo(236_970.61, 0);

    expect(Number(rows[0].landedPerKgLocal)).toBeCloseTo(51.2617, 2);
    expect(Number(rows[1].landedPerKgLocal)).toBeCloseTo(49.6651, 2);
  }, 240_000);

  it('values stock at the cost of the batch it is, never a company average', async () => {
    const rows = await getBatchCostings({ companyId, purchaseContractId: contractId });
    for (const row of rows) {
      expect(Number(row.stockValueUsd)).toBeCloseTo(
        Number(dec(row.availableKg).times(dec(row.landedPerKgUsd))),
        1,
      );
    }
    // Different coffees, different costs — so different values per kilo.
    expect(Number(rows[0].landedPerKgUsd)).not.toBeCloseTo(Number(rows[1].landedPerKgUsd), 3);
  }, 180_000);

  it('adds back to what the cost sheets of the order say, taken together', async () => {
    const rows = await getBatchCostings({ companyId, purchaseContractId: contractId });

    // One order, one cost sheet per shipment on it: the order's figures are
    // the sheets added up, and the shared read model has to agree.
    const shipments = await prisma.shipment.findMany({ where: { purchaseContractId: contractId }, select: { id: true } });
    const sheets = await Promise.all(shipments.map((s) => getShipmentCostSheet(companyId, s.id)));
    const sheetLanded = sheets.reduce((t, sheet) => t.plus(sheet.totalShipmentCostUsd), dec(0));

    const landed = rows.reduce((t, r) => t.plus(dec(r.landedUsd)), dec(0));
    expect(Number(landed)).toBeCloseTo(Number(sheetLanded), 0);
  }, 240_000);

  it('can be asked for one item, or one batch, and answers the same', async () => {
    const all = await getBatchCostings({ companyId, purchaseContractId: contractId });
    const one = await getBatchCostings({ companyId, batchIds: [all[0].batchId] });
    expect(one).toHaveLength(1);
    expect(one[0].landedPerKgLocal.toString()).toBe(all[0].landedPerKgLocal.toString());

    const byItem = await getBatchCostings({ companyId, itemId: all[1].itemId });
    expect(byItem.map((r) => r.batchId)).toContain(all[1].batchId);
  }, 240_000);
});
