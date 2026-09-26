import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { editApprovedPurchase, type EditApprovedOrderInput } from '@/lib/services/purchase-edit';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createPayment, postPayment } from '@/lib/services/payment';
import { getPayables } from '@/lib/services/receivables';
import { getBatchStock } from '@/lib/services/stock';
import { reconcile } from '@/lib/services/reconciliation';
import { dec } from '@/lib/money';

/**
 * "Purchase order — every field editable."
 *
 * An approved order could be corrected only by deleting it and entering it
 * again, which is refused as soon as any coffee has been received. So a wrong
 * price on an order already half sold could not be put right at all. These
 * tests correct approved orders in every way the client might, and check that
 * the supplier's balance, the stock value, cost of sales and the books all
 * follow — and that the books still reconcile afterwards.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '10', effectiveDate: utcDate('2026-01-01') },
  });
}, 300_000);

/** An approved order of two 10,000 KG containers at USD 4.00. */
async function approvedOrder(reference: string, price = '4.00') {
  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-05-01'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '10',
      freightAmount: '0',
      contractReference: reference,
      lines: [
        { itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: price, bagWeightKg: '60', lotNumber: `${reference}-A`, containerNumber: `${reference.replace(/\W/g, '')}A` },
        { itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: price, bagWeightKg: '60', lotNumber: `${reference}-B`, containerNumber: `${reference.replace(/\W/g, '')}B` },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  return prisma.purchaseContract.findUniqueOrThrow({
    where: { id: contract.id },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
}

type Order = Awaited<ReturnType<typeof approvedOrder>>;

/** The order exactly as the edit form would send it back, with changes applied. */
function asForm(order: Order, change: Partial<EditApprovedOrderInput> = {}, lines?: EditApprovedOrderInput['lines']): EditApprovedOrderInput {
  return {
    companyId,
    contractId: order.id,
    userId: ctx.admin.id,
    contractReference: order.contractReference,
    contractDate: order.contractDate,
    vendorId: order.vendorId,
    currency: order.currency,
    rateToUsd: order.rateToUsd.toString(),
    rateLocalPerUsd: order.rateLocalPerUsd.toString(),
    freightAmount: order.freightAmount.toString(),
    otherCharges: order.otherCharges.toString(),
    containers: order.containers,
    notes: order.notes,
    lines:
      lines ??
      order.lines.map((l) => ({
        id: l.id,
        itemId: l.itemId,
        lotNumber: l.lotNumber,
        batchNumber: l.batchNumber,
        containerNumber: l.containerNumber,
        quantity: l.quantity.toString(),
        unit: l.unit as 'KG',
        unitPrice: l.unitPrice.toString(),
        bags: l.bags,
        bagWeightKg: l.bagWeightKg.toString(),
      })),
    ...change,
  };
}

async function receive(order: Order, lineIndex: number) {
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractLineId: order.lines[lineIndex].id } });
  const grn = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: order.id,
      warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-05-20'),
      receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: batch.orderedQuantityKg.toString() }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });
  return batch.id;
}

async function sell(batchId: string, kg: string) {
  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-06-01'), customerId: masters.customer.id, currency: 'MAD',
      rateToUsd: '10', rateLocalPerUsd: '10',
      lines: [{ batchId, warehouseId: masters.warehouses[0].id, quantity: kg, unit: 'KG' as const, unitPrice: '60.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
  return invoice.id;
}

async function accountUsd(systemKey: string) {
  const [row] = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return Number(row.bal);
}

/**
 * What the supplier is owed for this order, read both ways: the payables list
 * the screens show, and the supplier's own lines in Accounts Payable. The two
 * must agree, or the supplier ledger says one thing and the statement another.
 */
async function owedTo(vendorId: string, contractId: string) {
  const rows = await getPayables({ companyId, vendorId });
  const listed = Number(
    rows.filter((r) => r.kind === 'CONTRACT' && r.contractId === contractId).reduce((t, r) => t.plus(r.outstandingAmountUsd), dec(0)),
  );
  const [ledger] = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."creditUsd" - jl."debitUsd"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = 'ACCOUNTS_PAYABLE'
      AND jl."vendorId" = ${vendorId} AND jl."purchaseContractId" = ${contractId}`;
  const paid = await prisma.paymentAllocation.aggregate({
    where: { purchaseContractId: contractId, payment: { status: 'POSTED', vendorId } },
    _sum: { amountUsd: true },
  });
  expect(Number(ledger.bal) - Number(paid._sum.amountUsd ?? 0)).toBeCloseTo(listed, 2);
  return listed;
}

async function expectBooksWhole() {
  const result = await reconcile(companyId);
  expect(result.checks.filter((c) => !c.passed)).toEqual([]);
}

describe('fields that do not touch the books', () => {
  it('saves the reference, ports and memo without a single new journal entry', async () => {
    const order = await approvedOrder('ICUL/EDIT/1');
    const entriesBefore = await prisma.journalEntry.count({ where: { companyId } });

    await editApprovedPurchase(
      asForm(order, { contractReference: 'ICUL/EDIT/1-R', portOfLoading: 'Mombasa', destination: 'Casablanca', notes: 'Corrected memo' }),
    );

    const after = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.contractReference).toBe('ICUL/EDIT/1-R');
    expect(after.portOfLoading).toBe('Mombasa');
    expect(after.notes).toBe('Corrected memo');
    expect(await prisma.journalEntry.count({ where: { companyId } })).toBe(entriesBefore);
    // The shipments carry the order's route.
    const shipments = await prisma.shipment.findMany({ where: { purchaseContractId: order.id }, select: { portOfLoading: true } });
    expect(shipments.every((s) => s.portOfLoading === 'Mombasa')).toBe(true);
    await expectBooksWhole();
  }, 300_000);
});

describe('a wrong price on an order already received and partly sold', () => {
  let order: Order;
  let batchA: string;
  let invoiceId: string;

  beforeAll(async () => {
    order = await approvedOrder('ICUL/EDIT/2');
    batchA = await receive(order, 0);
    invoiceId = await sell(batchA, '4000');
  }, 300_000);

  it('corrects the price although coffee has been received and sold', async () => {
    const lines = asForm(order).lines.map((l) => ({ ...l, unitPrice: '4.50' }));
    const result = await editApprovedPurchase(asForm(order, {}, lines));
    expect(result.changes.join(' ')).toMatch(/total/);

    const contract = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(contract.totalValue)).toBeCloseTo(90_000, 2);
  }, 300_000);

  it('owes the supplier the corrected amount', async () => {
    expect(await owedTo(masters.vendor.id, order.id)).toBeCloseTo(90_000, 2);
  }, 300_000);

  it('values every batch at the corrected price', async () => {
    const batches = await prisma.batch.findMany({ where: { purchaseContractId: order.id }, orderBy: { batchNumber: 'asc' } });
    for (const b of batches) {
      expect(Number(b.purchaseCostUsd)).toBeCloseTo(45_000, 2);
      expect(Number(b.landedUnitCostUsd)).toBeCloseTo(4.5, 6);
    }
  }, 300_000);

  it('charges the coffee already sold at the corrected cost, on the invoice too', async () => {
    const line = await prisma.salesInvoiceLine.findFirstOrThrow({ where: { salesInvoiceId: invoiceId } });
    expect(Number(line.costTotalUsd)).toBeCloseTo(18_000, 2);
    const invoice = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(Number(invoice.costOfGoodsUsd)).toBeCloseTo(18_000, 2);
  }, 300_000);

  it('values what is left on the shelf and at sea at the corrected cost', async () => {
    const stock = await getBatchStock({ companyId, purchaseContractId: order.id });
    const shelf = stock.reduce((t, r) => t.plus(dec(r.stockValueUsd)), dec(0));
    // 6,000 KG left of the received container, at 4.50.
    expect(Number(shelf)).toBeCloseTo(27_000, 2);
  }, 300_000);

  it('corrected a second time, moves only the second difference', async () => {
    const fresh = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: order.id }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
    const lines = asForm(fresh).lines.map((l) => ({ ...l, unitPrice: '4.25' }));
    await editApprovedPurchase(asForm(fresh, {}, lines));

    const line = await prisma.salesInvoiceLine.findFirstOrThrow({ where: { salesInvoiceId: invoiceId } });
    expect(Number(line.costTotalUsd)).toBeCloseTo(17_000, 2);
    expect(await owedTo(masters.vendor.id, order.id)).toBeCloseTo(85_000, 2);
  }, 300_000);

  it('leaves the books reconciling', async () => {
    await expectBooksWhole();
  }, 300_000);
});

describe('what a received container keeps', () => {
  it('refuses a new quantity on a container already received, and says why', async () => {
    const order = await approvedOrder('ICUL/EDIT/3');
    await receive(order, 0);
    const lines = asForm(order).lines.map((l, i) => (i === 0 ? { ...l, quantity: '9000' } : l));
    await expect(editApprovedPurchase(asForm(order, {}, lines))).rejects.toThrow(/already been received.*kilograms/);
  }, 300_000);

  it('changes the quantity on a container still at sea, and the payable follows', async () => {
    const order = await approvedOrder('ICUL/EDIT/4');
    await receive(order, 0);
    const lines = asForm(order).lines.map((l, i) => (i === 1 ? { ...l, quantity: '12000' } : l));
    await editApprovedPurchase(asForm(order, {}, lines));

    const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractLineId: order.lines[1].id } });
    expect(Number(batch.orderedQuantityKg)).toBeCloseTo(12_000, 3);
    expect(Number(batch.purchaseCostUsd)).toBeCloseTo(48_000, 2);
    expect(await owedTo(masters.vendor.id, order.id)).toBeCloseTo(88_000, 2);
    await expectBooksWhole();
  }, 300_000);
});

describe('the supplier', () => {
  it('moves an unpaid order to another supplier, balance and all', async () => {
    const other = await prisma.vendor.create({
      data: { companyId, vendorCode: `SUP-OTHER-${Date.now()}`, vendorName: 'Another Exporter', country: 'Uganda', primaryCurrency: 'USD', paymentTermDays: 0 },
    });
    const order = await approvedOrder('ICUL/EDIT/5');
    await editApprovedPurchase(asForm(order, { vendorId: other.id }));

    expect(await owedTo(other.id, order.id)).toBeCloseTo(80_000, 2);
    expect(await owedTo(masters.vendor.id, order.id)).toBeCloseTo(0, 2);
    const shipments = await prisma.shipment.findMany({ where: { purchaseContractId: order.id }, select: { vendorId: true } });
    expect(shipments.every((s) => s.vendorId === other.id)).toBe(true);
    await expectBooksWhole();
  }, 300_000);

  it('refuses to move an order the first supplier has already been paid for', async () => {
    const other = await prisma.vendor.create({
      data: { companyId, vendorCode: `SUP-PAID-${Date.now()}`, vendorName: 'Third Exporter', country: 'Uganda', primaryCurrency: 'USD', paymentTermDays: 0 },
    });
    const order = await approvedOrder('ICUL/EDIT/6');
    const bank =
      (await prisma.cashBankAccount.findFirst({ where: { companyId, currency: 'USD', accountType: 'BANK' } })) ??
      (await getCashAccount(companyId, 'USD'));
    const payment = await createPayment(
      {
        companyId, paymentDate: utcDate('2026-05-10'), vendorId: masters.vendor.id, currency: 'USD', amount: '1000',
        rateToUsd: '1', rateLocalPerUsd: '10', paymentMethod: 'BANK_TRANSFER', cashBankAccountId: bank.id,
        allocations: [{ purchaseContractId: order.id, amount: '1000' }],
      } as never,
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });

    await expect(editApprovedPurchase(asForm(order, { vendorId: other.id }))).rejects.toThrow(/already been paid/);
    // And the price cannot drop below what has been paid.
    const lines = asForm(order).lines.map((l) => ({ ...l, unitPrice: '0.01' }));
    await expect(editApprovedPurchase(asForm(order, {}, lines))).rejects.toThrow(/already been paid/);
  }, 300_000);
});

describe('the date', () => {
  it('re-dates the order and its posting', async () => {
    const order = await approvedOrder('ICUL/EDIT/7');
    await editApprovedPurchase(asForm(order, { contractDate: utcDate('2026-04-15') }));
    const live = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId, sourceType: 'PURCHASE_CONTRACT', sourceId: order.id, isReversal: false, reversedBy: { is: null } },
    });
    expect(live.entryDate.toISOString().slice(0, 10)).toBe('2026-04-15');
    await expectBooksWhole();
  }, 300_000);
});

describe('containers', () => {
  it('adds a container and takes an untouched one off', async () => {
    const order = await approvedOrder('ICUL/EDIT/8');
    const form = asForm(order);
    const lines = [
      form.lines[0],
      { itemId: masters.item.id, quantity: '5000', unit: 'KG' as const, unitPrice: '4.00', bagWeightKg: '60', lotNumber: 'ICUL/EDIT/8-C', containerNumber: 'ICULEDIT8C' },
    ];
    await editApprovedPurchase(asForm(order, { containers: 2 }, lines));

    const after = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true } });
    expect(after.lines).toHaveLength(2);
    expect(Number(after.totalValue)).toBeCloseTo(60_000, 2);
    expect(await prisma.batch.count({ where: { purchaseContractLineId: order.lines[1].id } })).toBe(0);
    expect(await owedTo(masters.vendor.id, order.id)).toBeCloseTo(60_000, 2);
    await expectBooksWhole();
  }, 300_000);

  it('will not take off a container that has been received', async () => {
    const order = await approvedOrder('ICUL/EDIT/9');
    await receive(order, 1);
    const lines = [asForm(order).lines[0]];
    await expect(editApprovedPurchase(asForm(order, {}, lines))).rejects.toThrow(/cannot be taken off the order/);
  }, 300_000);
});
