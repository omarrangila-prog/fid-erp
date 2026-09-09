import { describe, it, expect, beforeAll } from 'vitest';
import { prisma, transaction, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract, getReceiptStatus } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { changeShipmentStatus, changeDocumentStatus, getShipmentSettlement } from '@/lib/services/shipment';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createExpense, postExpense } from '@/lib/services/expense';
import {
  createStockTransfer,
  approveStockTransfer,
  dispatchStockTransfer,
  receiveStockTransfer,
} from '@/lib/services/stock-transfer';
import { getVendorBalance, getCustomerBalance, getTrialBalance } from '@/lib/services/accounting';
import { getShipmentProfitabilityById } from '@/lib/services/profitability';
import { getReceivables } from '@/lib/services/receivables';
import { getJobCostSummary } from '@/lib/services/landed-cost';
import { dec } from '@/lib/money';

/**
 * The full coffee trading chain, end to end against a real database:
 *
 *   purchase order → job → lots/batches/containers → goods receipt →
 *   warehouse stock → sale → receivable → warehouse transfer →
 *   landed cost → profitability
 *
 * The contract mirrors the specification's worked example: one purchase order
 * carrying three containers, each with its own lot and batch.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let warehouseA: { id: string; name: string };
let warehouseB: { id: string; name: string };
let contractId: string;
let shipmentId: string;
let batches: Array<{ id: string; batchNumber: string }> = [];

/** 3 containers x 19,200 KG (320 bags of 60 KG) at USD 4.50/KG. */
const CONTAINER_KG = '19200';
const BAGS_PER_CONTAINER = 320;
const PRICE_PER_KG = '4.50';
const FREIGHT = '5760';

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id, { currency: 'USD' });
  warehouseA = masters.warehouses[0];
  warehouseB = masters.warehouses[1];
});

describe('Flow 1 — purchase order creates the job, lots, containers and batches', () => {
  it('creates a draft that touches no ledger and no stock', async () => {
    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id,
        contractReference: 'FID-CTR-1001',
        supplierContractNo: 'SANTA-CLARA-2026-11',
        contractDate: utcDate('2026-01-15'),
        vendorId: masters.vendor.id,
        origin: 'Santos, Brazil',
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        freightAmount: FREIGHT,
        incoterm: 'CFR',
        portOfLoading: 'Santos',
        destination: 'Jebel Ali',
        paymentTermDays: 60,
        lines: [
          { itemId: masters.item.id, lotNumber: 'BR-001', batchNumber: 'B001', containerNumber: 'MSCU1000001', quantity: CONTAINER_KG, unit: 'KG', unitPrice: PRICE_PER_KG, bags: BAGS_PER_CONTAINER },
          { itemId: masters.item.id, lotNumber: 'BR-002', batchNumber: 'B002', containerNumber: 'MSCU1000002', quantity: CONTAINER_KG, unit: 'KG', unitPrice: PRICE_PER_KG, bags: BAGS_PER_CONTAINER },
          { itemId: masters.item.id, lotNumber: 'BR-003', batchNumber: 'B003', containerNumber: 'MSCU1000003', quantity: CONTAINER_KG, unit: 'KG', unitPrice: PRICE_PER_KG, bags: BAGS_PER_CONTAINER },
        ],
      },
      ctx.admin.id,
    );

    contractId = contract.id;

    expect(contract.status).toBe('DRAFT');
    // Company-prefixed numbering, as specified.
    expect(contract.contractNumber).toMatch(/^FID-DXB-PO-\d{6}$/);
    expect(dec(contract.subtotal).toString()).toBe('259200');
    expect(dec(contract.totalValue).toString()).toBe('264960');
    expect(contract.totalBags).toBe(960);
    expect(contract.containers).toBe(3);
    // 4.50 goods + 0.10 freight per KG.
    expect(dec(contract.lines[0].unitCostKg).toString()).toBe('4.6');

    const balance = await transaction((tx) => getVendorBalance(tx, ctx.dubai.id, masters.vendor.id));
    expect(balance.toString()).toBe('0');
    expect(await prisma.shipment.count({ where: { purchaseContractId: contract.id } })).toBe(0);
  });

  it('approving creates the supplier liability, the job and the traceability records', async () => {
    await postPurchaseContract({ id: contractId, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const contract = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contractId } });
    expect(contract.status).toBe('POSTED');

    // Supplier payable and supplier ledger.
    const payable = await transaction((tx) => getVendorBalance(tx, ctx.dubai.id, masters.vendor.id));
    expect(payable.toString()).toBe('264960');

    // One job for the contract, carrying all three containers.
    const shipments = await prisma.shipment.findMany({ where: { purchaseContractId: contractId } });
    expect(shipments).toHaveLength(1);
    shipmentId = shipments[0].id;
    expect(shipments[0].status).toBe('CONTRACT_CREATED');
    expect(shipments[0].jobNumber).toMatch(/^FID-DXB-JOB-\d{6}$/);
    expect(dec(shipments[0].quantityKg).toString()).toBe('57600');
    expect(shipments[0].bags).toBe(960);

    // Three lots, three containers, three batches — traceability intact.
    expect(await prisma.lot.count({ where: { purchaseContractId: contractId } })).toBe(3);
    expect(await prisma.container.count({ where: { shipmentId } })).toBe(3);

    batches = await prisma.batch.findMany({
      where: { purchaseContractId: contractId },
      orderBy: { batchNumber: 'asc' },
      select: { id: true, batchNumber: true },
    });
    expect(batches.map((b) => b.batchNumber)).toEqual(['B001', 'B002', 'B003']);
  });

  it('holds the coffee in transit, not in a warehouse', async () => {
    const batch = await prisma.batch.findFirstOrThrow({ where: { id: batches[0].id } });
    expect(dec(batch.orderedQuantityKg).toString()).toBe('19200');
    expect(dec(batch.receivedQuantityKg).toString()).toBe('0');
    expect(dec(batch.availableQuantityKg).toString()).toBe('0');
    expect(dec(batch.inTransitQuantityKg).toString()).toBe('19200');

    // No warehouse balance rows exist yet, and no stock movements.
    expect(await prisma.inventoryBalance.count({ where: { companyId: ctx.dubai.id } })).toBe(0);
    expect(await prisma.inventoryTransaction.count({ where: { companyId: ctx.dubai.id } })).toBe(0);

    // The value sits in Inventory in Transit, not in Inventory.
    const rows = await transaction((tx) => getTrialBalance(tx, ctx.dubai.id));
    const inTransit = rows.find((r) => r.code === '1250');
    const inventory = rows.find((r) => r.code === '1200');
    expect(dec(inTransit!.debitUsd).toString()).toBe('264960');
    expect(inventory).toBeUndefined();
  });

  it('refuses to approve the same contract twice', async () => {
    await expect(
      postPurchaseContract({ id: contractId, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ).rejects.toThrow(/already posted/i);
    expect(await prisma.shipment.count({ where: { purchaseContractId: contractId } })).toBe(1);
    expect(
      await prisma.journalEntry.count({ where: { sourceType: 'PURCHASE_CONTRACT', sourceId: contractId } }),
    ).toBe(1);
  });
});

describe('Flow 2 — goods receipt lands the coffee in a warehouse', () => {
  it('receives the first container into Warehouse A', async () => {
    const grn = await createGoodsReceipt(
      {
        companyId: ctx.dubai.id,
        purchaseContractId: contractId,
        warehouseId: warehouseA.id,
        receiptDate: utcDate('2026-02-20'),
        receivedById: ctx.admin.id,
        lines: [{ batchId: batches[0].id, quantityKg: CONTAINER_KG, bags: BAGS_PER_CONTAINER }],
      },
      ctx.admin.id,
    );

    expect(grn.grnNumber).toMatch(/^FID-DXB-GRN-\d{6}$/);
    await postGoodsReceipt({ id: grn.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batches[0].id } });
    expect(dec(batch.receivedQuantityKg).toString()).toBe('19200');
    expect(dec(batch.availableQuantityKg).toString()).toBe('19200');
    expect(dec(batch.inTransitQuantityKg).toString()).toBe('0');

    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId: batches[0].id, warehouseId: warehouseA.id } },
    });
    expect(dec(balance.onHandKg).toString()).toBe('19200');
    expect(balance.bags).toBe(320);
  });

  it('supports a partial receipt and tracks what is still outstanding', async () => {
    // Half of container 2 arrives first.
    const first = await createGoodsReceipt(
      {
        companyId: ctx.dubai.id,
        purchaseContractId: contractId,
        warehouseId: warehouseA.id,
        receiptDate: utcDate('2026-02-22'),
        receivedById: ctx.admin.id,
        lines: [{ batchId: batches[1].id, quantityKg: '9600', bags: 160 }],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: first.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const status = await transaction((tx) => getReceiptStatus(tx, contractId));
    const b002 = status.find((r) => r.batchNumber === 'B002')!;
    expect(b002.receivedKg.toString()).toBe('9600');
    expect(b002.outstandingKg.toString()).toBe('9600');

    // Then the rest.
    const second = await createGoodsReceipt(
      {
        companyId: ctx.dubai.id,
        purchaseContractId: contractId,
        warehouseId: warehouseA.id,
        receiptDate: utcDate('2026-02-25'),
        receivedById: ctx.admin.id,
        lines: [{ batchId: batches[1].id, quantityKg: '9600', bags: 160 }],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: second.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const after = await transaction((tx) => getReceiptStatus(tx, contractId));
    expect(after.find((r) => r.batchNumber === 'B002')!.outstandingKg.toString()).toBe('0');
  });

  it('refuses to receive more than was ordered', async () => {
    await expect(
      createGoodsReceipt(
        {
          companyId: ctx.dubai.id,
          purchaseContractId: contractId,
          warehouseId: warehouseA.id,
          receiptDate: utcDate('2026-02-26'),
          receivedById: ctx.admin.id,
          lines: [{ batchId: batches[1].id, quantityKg: '100' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/only 0.000 KG is still to be received/);
  });

  it('moves the value from Inventory in Transit into Inventory', async () => {
    const rows = await transaction((tx) => getTrialBalance(tx, ctx.dubai.id));
    const inTransit = rows.find((r) => r.code === '1250')!;
    const inventory = rows.find((r) => r.code === '1200')!;

    // Two containers received at a landed cost of 4.60 -> 38,400 x 4.60.
    expect(dec(inventory.debitUsd).minus(dec(inventory.creditUsd)).toString()).toBe('176640');
    expect(dec(inTransit.debitUsd).minus(dec(inTransit.creditUsd)).toString()).toBe('88320');
  });
});

describe('Flow 3 — loading follow-up and shipment status', () => {
  it('walks the job through the workflow and records every step', async () => {
    await changeShipmentStatus({
      shipmentId,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      toStatus: 'AWAITING_LOADING',
    });

    await changeShipmentStatus({
      shipmentId,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      toStatus: 'LOADED',
      loadingDate: utcDate('2026-01-20'),
      bookingNumber: 'MSCU-8842190',
      shippingLineId: masters.shippingLine.id,
      vesselName: 'MSC Aurora',
      voyageNumber: '004W',
      portOfLoading: 'Santos',
      portOfDischarge: 'Jebel Ali',
      etdDate: utcDate('2026-01-25'),
      etaDate: utcDate('2026-02-28'),
    });

    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    expect(shipment.status).toBe('LOADED');
    expect(shipment.vesselName).toBe('MSC Aurora');

    const history = await prisma.shipmentStatusHistory.findMany({
      where: { shipmentId },
      orderBy: { changedAt: 'asc' },
    });
    expect(history.map((h) => h.toStatus)).toEqual(['CONTRACT_CREATED', 'AWAITING_LOADING', 'LOADED']);
  });

  it('will not mark a shipment loaded without the booking data', async () => {
    const other = await createPurchaseContract(
      {
        companyId: ctx.dubai.id,
        contractReference: 'FID-CTR-1002',
        contractDate: utcDate('2026-01-18'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        freightAmount: '0',
        lines: [
          { itemId: masters.item.id, lotNumber: 'BR-004', batchNumber: 'B004', quantity: '9600', unit: 'KG', unitPrice: PRICE_PER_KG, bags: 160 },
        ],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: other.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    const otherShipment = await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: other.id } });

    await changeShipmentStatus({
      shipmentId: otherShipment.id,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      toStatus: 'AWAITING_LOADING',
    });

    await expect(
      changeShipmentStatus({
        shipmentId: otherShipment.id,
        companyId: ctx.dubai.id,
        userId: ctx.admin.id,
        toStatus: 'LOADED',
        loadingDate: utcDate('2026-01-25'),
      }),
    ).rejects.toThrow(/Booking Number, Shipping Line, Vessel Name/);
  });

  it('tracks document status separately from physical status', async () => {
    await changeDocumentStatus({
      shipmentId,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      toStatus: 'DRAFT_RECEIVED',
    });
    await changeDocumentStatus({
      shipmentId,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      toStatus: 'WITH_BANK',
    });

    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    expect(shipment.documentStatus).toBe('WITH_BANK');
    expect(shipment.status).toBe('LOADED');
  });
});

describe('Flow 4 — partial sales from a specific batch and warehouse', () => {
  let customerB: { id: string };

  it('sells 5,000 KG of batch B001 out of Warehouse A', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-03-01'),
        customerId: masters.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [
          { batchId: batches[0].id, warehouseId: warehouseA.id, quantity: '5000', unit: 'KG', unitPrice: '6.00' },
        ],
      },
      ctx.admin.id,
    );

    expect(invoice.invoiceNumber).toMatch(/^FID-DXB-SI-\d{6}$/);

    // A draft reserves rather than consumes.
    const reserved = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId: batches[0].id, warehouseId: warehouseA.id } },
    });
    expect(dec(reserved.reservedKg).toString()).toBe('5000');
    expect(dec(reserved.availableKg).toString()).toBe('14200');

    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId: batches[0].id, warehouseId: warehouseA.id } },
    });
    expect(dec(balance.onHandKg).toString()).toBe('14200');
    expect(dec(balance.reservedKg).toString()).toBe('0');

    const posted = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(dec(posted.totalAmount).toString()).toBe('30000');
    // 5,000 KG at the landed cost of 4.60.
    expect(dec(posted.costOfGoodsUsd).toString()).toBe('23000');
  });

  it('sells a further 4,600 KG of the same batch to a second customer', async () => {
    customerB = await prisma.customer.create({
      data: {
        companyId: ctx.dubai.id,
        customerCode: 'CUS-DXB-B',
        customerName: 'Second Roastery FZE',
        primaryCurrency: 'USD',
        paymentTermDays: 30,
      },
    });

    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-03-05'),
        customerId: customerB.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [
          { batchId: batches[0].id, warehouseId: warehouseA.id, quantity: '4600', unit: 'KG', unitPrice: '5.90' },
        ],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batches[0].id } });
    expect(dec(batch.soldQuantityKg).toString()).toBe('9600');
    expect(dec(batch.availableQuantityKg).toString()).toBe('9600');
  });

  it('updates both customer ledgers and the receivables list', async () => {
    const balanceA = await transaction((tx) => getCustomerBalance(tx, ctx.dubai.id, masters.customer.id));
    const balanceB = await transaction((tx) => getCustomerBalance(tx, ctx.dubai.id, customerB.id));
    expect(balanceA.toString()).toBe('30000');
    expect(balanceB.toString()).toBe('27140');

    const receivables = await getReceivables({ companyId: ctx.dubai.id, onlyOutstanding: true });
    expect(receivables).toHaveLength(2);
    expect(receivables.reduce((a, r) => a.plus(r.outstandingAmountUsd), dec(0)).toString()).toBe('57140');
  });

  it('refuses to sell more than the batch holds in that warehouse', async () => {
    await expect(
      createSalesInvoice(
        {
          companyId: ctx.dubai.id,
          invoiceDate: utcDate('2026-03-10'),
          customerId: masters.customer.id,
          currency: 'USD',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          lines: [
            { batchId: batches[0].id, warehouseId: warehouseA.id, quantity: '12000', unit: 'KG', unitPrice: '5.90' },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/Insufficient stock/);
  });

  it('refuses to sell from a warehouse that does not hold the batch', async () => {
    await expect(
      createSalesInvoice(
        {
          companyId: ctx.dubai.id,
          invoiceDate: utcDate('2026-03-10'),
          customerId: masters.customer.id,
          currency: 'USD',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          lines: [
            { batchId: batches[0].id, warehouseId: warehouseB.id, quantity: '100', unit: 'KG', unitPrice: '5.90' },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/Insufficient stock/);
  });
});

describe('Flow 5 — warehouse transfer never duplicates stock', () => {
  it('moves 3,000 KG from Warehouse A to Warehouse B', async () => {
    const before = await prisma.batch.findUniqueOrThrow({ where: { id: batches[1].id } });
    const companyTotalBefore = dec(before.availableQuantityKg);
    expect(companyTotalBefore.toString()).toBe('19200');

    const transfer = await createStockTransfer(
      {
        companyId: ctx.dubai.id,
        transferDate: utcDate('2026-03-12'),
        fromWarehouseId: warehouseA.id,
        toWarehouseId: warehouseB.id,
        lines: [{ batchId: batches[1].id, quantityKg: '3000', bags: 50 }],
      },
      ctx.admin.id,
    );

    await approveStockTransfer({ id: transfer.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    // While approved the stock is reserved at the source but still owned.
    const reserved = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId: batches[1].id, warehouseId: warehouseA.id } },
    });
    expect(dec(reserved.reservedKg).toString()).toBe('3000');
    expect(dec(reserved.availableKg).toString()).toBe('16200');

    await dispatchStockTransfer({ id: transfer.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    await receiveStockTransfer({ id: transfer.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const fromBalance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId: batches[1].id, warehouseId: warehouseA.id } },
    });
    const toBalance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { batchId_warehouseId: { batchId: batches[1].id, warehouseId: warehouseB.id } },
    });

    expect(dec(fromBalance.onHandKg).toString()).toBe('16200');
    expect(dec(toBalance.onHandKg).toString()).toBe('3000');

    // The company total is unchanged — this is the rule that must never break.
    const after = await prisma.batch.findUniqueOrThrow({ where: { id: batches[1].id } });
    expect(dec(after.availableQuantityKg).toString()).toBe('19200');
    expect(dec(after.receivedQuantityKg).toString()).toBe('19200');
  });

  it('refuses to transfer more than the source warehouse holds', async () => {
    await expect(
      createStockTransfer(
        {
          companyId: ctx.dubai.id,
          transferDate: utcDate('2026-03-13'),
          fromWarehouseId: warehouseB.id,
          toWarehouseId: warehouseA.id,
          lines: [{ batchId: batches[1].id, quantityKg: '5000' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/only 3000.000 KG available/);
  });
});

describe('Flow 6 — landed cost and shipment profitability', () => {
  it('reports gross profit at the pre-landed-cost rate', async () => {
    const profit = await getShipmentProfitabilityById(ctx.dubai.id, shipmentId);
    expect(profit!.soldQuantityKg.toString()).toBe('9600');
    expect(profit!.salesRevenueUsd.toString()).toBe('57140');
    // 9,600 KG at 4.60.
    expect(profit!.allocatedLandedCostUsd.toString()).toBe('44160');
    expect(profit!.grossProfitUsd.toString()).toBe('12980');
  });

  it('capitalises a clearing invoice into landed cost and trues up sold coffee', async () => {
    const aedBank = await getCashAccount(ctx.dubai.id, 'AED');
    const clearing = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, code: 'CLEARING' },
    });
    expect(clearing.capitaliseByDefault).toBe(true);

    // AED 21,153.60 at 3.6725 is exactly USD 5,760.
    const expense = await createExpense(
      {
        companyId: ctx.dubai.id,
        expenseDate: utcDate('2026-03-15'),
        expenseCategoryId: clearing.id,
        shipmentId,
        currency: 'AED',
        amount: '21153.60',
        rateToUsd: '3.6725',
        rateLocalPerUsd: '3.6725',
        cashBankAccountId: aedBank.id,
        description: 'Customs clearing for the job',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    // USD 5,760 over three batches of equal size = 1,920 each.
    // B001 landed cost becomes (88,320 + 1,920) / 19,200 = 4.70.
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batches[0].id } });
    expect(dec(batch.capitalisedCostUsd).toString()).toBe('1920');
    expect(dec(batch.landedUnitCostUsd).toString()).toBe('4.7');

    const summary = await transaction((tx) => getJobCostSummary(tx, ctx.dubai.id, shipmentId));
    expect(summary.goodsUsd.toString()).toBe('264960');
    expect(summary.capitalisedUsd.toString()).toBe('5760');
    expect(summary.totalLandedUsd.toString()).toBe('270720');
    expect(summary.landedCostPerKgUsd.toString()).toBe('4.7');
  });

  it('restates gross profit at the new landed cost', async () => {
    const profit = await getShipmentProfitabilityById(ctx.dubai.id, shipmentId);
    // 9,600 KG now cost 4.70 each.
    expect(profit!.allocatedLandedCostUsd.toString()).toBe('45120');
    expect(profit!.grossProfitUsd.toString()).toBe('12020');
    expect(profit!.profitPerKgUsd.toString()).toBe('1.25208333');
  });

  it('keeps the general ledger in step with the profitability report', async () => {
    const rows = await transaction((tx) => getTrialBalance(tx, ctx.dubai.id));
    const cogs = rows.find((r) => r.code === '5000')!;
    // 44,160 at the original rate plus a 960 true-up on the coffee already sold.
    expect(dec(cogs.debitUsd).minus(dec(cogs.creditUsd)).toString()).toBe('45120');
  });

  it('reduces net profit by period costs without touching gross profit', async () => {
    const aedBank = await getCashAccount(ctx.dubai.id, 'AED');
    const bankCharges = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, code: 'BANK' },
    });
    expect(bankCharges.capitaliseByDefault).toBe(false);

    const expense = await createExpense(
      {
        companyId: ctx.dubai.id,
        expenseDate: utcDate('2026-03-16'),
        expenseCategoryId: bankCharges.id,
        shipmentId,
        currency: 'AED',
        amount: '3672.50',
        rateToUsd: '3.6725',
        rateLocalPerUsd: '3.6725',
        cashBankAccountId: aedBank.id,
        description: 'Letter of credit charges',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const profit = await getShipmentProfitabilityById(ctx.dubai.id, shipmentId);
    expect(profit!.grossProfitUsd.toString()).toBe('12020');
    expect(profit!.otherCostsUsd.toString()).toBe('1000');
    expect(profit!.netProfitUsd.toString()).toBe('11020');
  });
});

describe('accounting integrity', () => {
  it('keeps the trial balance balanced in USD', async () => {
    const rows = await transaction((tx) => getTrialBalance(tx, ctx.dubai.id));
    const debits = rows.reduce((a, r) => a.plus(dec(r.debitUsd)), dec(0));
    const credits = rows.reduce((a, r) => a.plus(dec(r.creditUsd)), dec(0));
    expect(debits.toString()).toBe(credits.toString());
    expect(debits.greaterThan(0)).toBe(true);
  });

  it('reports the job as unpaid until a receipt lands', async () => {
    const settlement = await getShipmentSettlement(prisma as never, ctx.dubai.id, shipmentId);
    expect(settlement.invoicedUsd.toString()).toBe('57140');
    expect(settlement.receivedUsd.toString()).toBe('0');
    expect(settlement.status).toBe('UNPAID');
  });
});
