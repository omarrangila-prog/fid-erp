import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { reconcile } from '@/lib/services/reconciliation';
import { dec } from '@/lib/money';

/**
 * The client's own costing, against the client's own numbers.
 *
 *   Container 1  Item A  20,040 KG  USD 82,324.32
 *   Container 2  Item B  21,000 KG  USD 83,958.00
 *   Common local expenses  MAD 473,941.22, at 9.60 to the dollar
 *
 * The purchase cost stays with the container that incurred it — no averaging.
 * The local charges belong to the job as a whole and are split equally between
 * the two lines, MAD 236,970.61 each, because clearing and moving a container
 * costs the same whether it is the heavier one or the lighter one.
 *
 * The figures below are the ones the client works out in their spreadsheet.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let shipmentId: string;
let contractId: string;
let containerA: string;

const RATE = '9.60';
const EXPENSES_MAD = '473941.22';

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });

  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: RATE, effectiveDate: utcDate('2026-01-01') },
  });

  // A second coffee, so the job carries two different items.
  const itemB = await prisma.coffeeItem.create({
    data: {
      companyId,
      itemCode: 'ITM-COST-B',
      itemName: 'Uganda Robusta Screen 15',
      coffeeType: 'ROBUSTA',
      originCountry: 'Uganda',
      defaultUnit: 'KG',
      bagWeightKg: '60',
    },
  });

  // 20,040 KG at 4.108 → 82,324.32; 21,000 KG at 3.998 → 83,958.00
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
  expect(batches).toHaveLength(2);
  shipmentId = batches[0].shipmentId;
  contractId = contract.id;
  containerA = (await prisma.container.findFirstOrThrow({ where: { companyId, containerNumber: 'CONT-A' } })).id;


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

  // The common local charges, booked against the job as a whole.
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
      amount: EXPENSES_MAD,
      rateToUsd: RATE,
      rateLocalPerUsd: RATE,
      paymentMethod: 'BANK_TRANSFER',
      cashBankAccountId: cash.id,
      kind: 'SHIPMENT',
      capitaliseToLandedCost: true,
      description: 'Clearing, transport, port charges and documentation',
    },
    ctx.admin.id,
  );
  await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });
}, 300_000);

/** One line's figures, straight from the shared costing service. */
async function lines() {
  const sheet = await getShipmentCostSheet(companyId, shipmentId);
  const batches = await prisma.batch.findMany({
    where: { purchaseContractId: contractId },
    orderBy: { batchNumber: 'asc' },
    select: {
      id: true,
      containerId: true,
      orderedQuantityKg: true,
      purchaseCostUsd: true,
      capitalisedCostUsd: true,
      landedUnitCostUsd: true,
    },
  });
  return { sheet, batches };
}

describe('the common local charges are split between the lines, not the kilograms', () => {
  it('gives each container half, and the two halves are the whole', async () => {
    const { batches } = await lines();

    // MAD 473,941.22 at 9.60 is USD 49,368.877.
    const expectedTotalUsd = dec(EXPENSES_MAD).dividedBy(RATE);
    const allocated = batches.map((b) => dec(b.capitalisedCostUsd));

    for (const share of allocated) {
      expect(Number(share)).toBeCloseTo(Number(expectedTotalUsd) / 2, 1);
    }

    // Nothing invented and nothing lost: the halves add back to the whole.
    const total = allocated.reduce((t, a) => t.plus(a), dec(0));
    expect(Number(total)).toBeCloseTo(Number(expectedTotalUsd), 1);
  }, 240_000);

  it('is not the quantity split, which would have been 48.8% and 51.2%', async () => {
    const { batches } = await lines();
    const [a, b] = batches.map((x) => Number(dec(x.capitalisedCostUsd)));
    // Equal shares, not 20,040 : 21,000.
    expect(a).toBeCloseTo(b, 1);
  }, 180_000);

  it('leaves each container carrying its own purchase cost, unaveraged', async () => {
    const { batches } = await lines();
    const purchases = batches.map((b) => Number(dec(b.purchaseCostUsd)));
    expect(purchases[0]).toBeCloseTo(82_324.32, 2);
    expect(purchases[1]).toBeCloseTo(83_958.0, 2);
  }, 180_000);

  it('reaches the landed cost per kilo the client works out by hand', async () => {
    const { batches } = await lines();
    const shareMad = dec(EXPENSES_MAD).dividedBy(2); // 236,970.61
    const shareUsd = shareMad.dividedBy(RATE);

    // Item 1: 82,324.32 + 24,684.44 over 20,040 KG
    const landed1Usd = dec('82324.32').plus(shareUsd);
    expect(Number(dec(batches[0].landedUnitCostUsd))).toBeCloseTo(
      Number(landed1Usd.dividedBy(20_040)),
      3,
    );
    expect(Number(landed1Usd.dividedBy(20_040).times(RATE))).toBeCloseTo(51.2617, 3);

    // Item 2: 83,958.00 + 24,684.44 over 21,000 KG
    const landed2Usd = dec('83958.00').plus(shareUsd);
    expect(Number(dec(batches[1].landedUnitCostUsd))).toBeCloseTo(
      Number(landed2Usd.dividedBy(21_000)),
      3,
    );
    expect(Number(landed2Usd.dividedBy(21_000).times(RATE))).toBeCloseTo(49.6651, 3);
  }, 240_000);

  it('gives the two lines different costs per kilo, because they are different', async () => {
    const { batches } = await lines();
    const perKg = batches.map((b) => Number(dec(b.landedUnitCostUsd)));
    expect(perKg[0]).not.toBeCloseTo(perKg[1], 3);
    // The lighter, dearer container ends up carrying more per kilo.
    expect(perKg[0]).toBeGreaterThan(perKg[1]);
  }, 180_000);

  it('books the expense once across the job, never once per line', async () => {
    const { sheet } = await lines();
    // MAD 473,941.22 once, not twice.
    expect(Number(sheet.expenseLocal)).toBeCloseTo(473_941.22, 0);
    expect(Number(sheet.expenseUsd)).toBeCloseTo(49_368.88, 0);
  }, 180_000);

  it('adds up to the order total the client expects', async () => {
    // Each shipment carries one container now, so the order's total is the
    // shipments' cost sheets added together — and nothing is counted twice.
    const shipments = await prisma.shipment.findMany({ where: { purchaseContractId: contractId }, select: { id: true } });
    const sheets = await Promise.all(shipments.map((s) => getShipmentCostSheet(companyId, s.id)));
    const goods = sheets.reduce((t, sheet) => t.plus(sheet.goodsUsd), dec(0));
    const kg = sheets.reduce((t, sheet) => t.plus(sheet.orderedKg), dec(0));
    const landed = sheets.reduce((t, sheet) => t.plus(sheet.totalShipmentCostUsd), dec(0));
    expect(Number(goods)).toBeCloseTo(166_282.32, 1);
    expect(Number(kg)).toBeCloseTo(41_040, 0);
    expect(Number(landed)).toBeCloseTo(166_282.32 + 49_368.88, 0);
  }, 180_000);

  it('leaves the books reconciling', async () => {
    const health = await reconcile(companyId);
    expect(health.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);
});

describe('a cost booked against one container only', () => {
  it('stays on that container', async () => {
    const before = await prisma.batch.findMany({
      where: { purchaseContractId: contractId },
      orderBy: { batchNumber: 'asc' },
      select: { id: true, containerId: true, capitalisedCostUsd: true },
    });

    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, kind: 'SHIPMENT', status: 'ACTIVE' },
    });
    const cash = await getCashAccount(companyId, 'MAD');
    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-03-10'),
        expenseCategoryId: category.id,
        shipmentId,
        containerId: containerA,
        currency: 'MAD',
        amount: '9600',
        rateToUsd: RATE,
        rateLocalPerUsd: RATE,
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: cash.id,
        kind: 'SHIPMENT',
        capitaliseToLandedCost: true,
        description: 'Repacking, container one only',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    const after = await prisma.batch.findMany({
      where: { purchaseContractId: contractId },
      orderBy: { batchNumber: 'asc' },
      select: { id: true, containerId: true, capitalisedCostUsd: true },
    });

    const movedA = dec(after[0].capitalisedCostUsd).minus(dec(before[0].capitalisedCostUsd));
    const movedB = dec(after[1].capitalisedCostUsd).minus(dec(before[1].capitalisedCostUsd));

    // MAD 9,600 at 9.60 is USD 1,000, all of it on container one.
    expect(Number(movedA)).toBeCloseTo(1000, 1);
    expect(Number(movedB)).toBeCloseTo(0, 2);
  }, 300_000);
});
