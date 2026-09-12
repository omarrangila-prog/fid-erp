import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract, getReceiptStatus } from '@/lib/services/purchase';
import { getCashBankBalance } from '@/lib/services/accounting';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import { markShipmentLoaded } from '@/lib/services/shipment';
import { getBatchStock } from '@/lib/services/stock';
import { getReceivables } from '@/lib/services/receivables';
import { reconcile } from '@/lib/services/reconciliation';
import { dec } from '@/lib/money';

/**
 * The Morocco workflow, run exactly as the client wrote it.
 *
 * This is §42 of the correction brief, end to end and in order: a purchase
 * order with no lot number, the loading sheet that appears from it, the
 * loading information added when the coffee actually ships, a receipt that
 * splits one contract into two lots in one warehouse, a sale drawn from a
 * named lot at a named location, and two partial payments that both survive.
 *
 * It is written as one narrative rather than as isolated units because that is
 * how it fails in practice — each step depends on the one before, and the
 * client's complaint was never about a single screen but about the joins
 * between them.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let contractId: string;
let contractNumber: string;
let shipmentId: string;
let warehouseA: { id: string; name: string };
let lot229BatchId: string;
let invoiceId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  warehouseA = masters.warehouses[0];
});

describe('1 — the purchase order asks only what is known', () => {
  it('saves 42,000 KG with no lot and no batch', async () => {
    const contract = await createPurchaseContract(
      {
        companyId,
        contractDate: utcDate('2026-03-02'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '2100',
        lines: [
          {
            itemId: masters.item.id,
            quantity: '42000',
            unit: 'KG',
            unitPrice: '4.00',
            bagWeightKg: '60',
          },
        ],
      },
      ctx.admin.id,
    );

    contractId = contract.id;
    contractNumber = contract.contractNumber;

    // The whole point: it saved. No lot, no batch, no payment term, no
    // expected shipment date, no consignee.
    expect(contract.status).toBe('DRAFT');
    expect(contract.lines[0].lotNumber).toBeNull();
    expect(contract.lines[0].batchNumber).toBeNull();
    expect(dec(contract.lines[0].quantityKg).toString()).toBe('42000');
  });

  it('is due on its own date when no due date was agreed', async () => {
    // The supplier's standing terms, not a Net 30 the user had to choose.
    const contract = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contractId } });
    expect(contract.dueDate).toBeTruthy();
  });
});

describe('2 — approving it opens the job and the loading sheet row', () => {
  it('creates the shipment and one batch, pending identification', async () => {
    await postPurchaseContract({ id: contractId, companyId, userId: ctx.admin.id });

    const shipment = await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contractId } });
    shipmentId = shipment.id;
    expect(shipment.status).toBe('CONTRACT_CREATED');

    const batches = await prisma.batch.findMany({ where: { purchaseContractId: contractId } });
    expect(batches).toHaveLength(1);
    expect(batches[0].traceabilityPending).toBe(true);
    expect(dec(batches[0].inTransitQuantityKg).toString()).toBe('42000');
  });

  it('appears on the loading sheet with nothing retyped', async () => {
    const rows = (await getLoadingSheet(companyId)).filter((r) => r.contractId === contractId);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    // Straight off the purchase contract, as §5 asks.
    expect(row.contractNumber).toBe(contractNumber);
    expect(row.exporter).toBe(masters.vendor.vendorName);
    expect(row.importer).toBe(ctx.morocco.name);
    expect(row.itemName).toBe(masters.item.itemName);
    expect(dec(row.quantityKg).toString()).toBe('42000');

    // Blank until somebody buys it — not a guess, and not the supplier.
    expect(row.consignee).toBeNull();
    expect(row.saleStatus).toBe('UNSOLD');

    // And it is not pretending to be loaded.
    expect(row.status).toBe('CONTRACT_CREATED');
    expect(row.billOfLading).toBeNull();
    expect(row.etaDate).toBeNull();
  });
});

describe('3 — mark as loaded, which is when shipping details exist', () => {
  it('records the loading information in one action', async () => {
    await markShipmentLoaded(
      {
        companyId,
        shipmentId,
        loadingDate: utcDate('2026-03-20'),
        etaDate: utcDate('2026-04-18'),
        shippingLineId: masters.shippingLine.id,
        bookingNumber: 'BK-556677',
        billOfLading: 'MSCUMA2026/0412',
        containerNumber: 'MSCU1234567',
      },
      ctx.admin.id,
    );

    const row = (await getLoadingSheet(companyId)).find((r) => r.contractId === contractId)!;
    expect(row.status).toBe('LOADED');
    expect(row.etaDate).toEqual(utcDate('2026-04-18'));
    expect(row.shippingLine).toBe(masters.shippingLine.name);
    expect(row.bookingNumber).toBe('BK-556677');
    expect(row.billOfLading).toBe('MSCUMA2026/0412');
  });

  it('refuses to mark it loaded without the information that makes it loaded', async () => {
    const second = await createPurchaseContract(
      {
        companyId,
        contractDate: utcDate('2026-03-05'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '0',
        lines: [{ itemId: masters.item.id, quantity: '1000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: second.id, companyId, userId: ctx.admin.id });
    const other = await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: second.id } });

    await expect(
      markShipmentLoaded(
        { companyId, shipmentId: other.id, loadingDate: utcDate('2026-03-21'), etaDate: null },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/estimated arrival|shipping line/i);
  });
});

describe('4 — receiving splits one contract into two lots', () => {
  it('refuses a receipt that does not say what arrived', async () => {
    const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contractId } });

    await expect(
      createGoodsReceipt(
        {
          companyId,
          purchaseContractId: contractId,
          warehouseId: warehouseA.id,
          receiptDate: utcDate('2026-04-20'),
          receivedById: ctx.admin.id,
          lines: [{ batchId: batch.id, quantityKg: '21000' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/Lot Number or a Batch Number/i);
  });

  it('receives 21,000 KG as lot 120229 and 21,000 KG as lot 120230', async () => {
    const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contractId } });

    const receipt = await createGoodsReceipt(
      {
        companyId,
        purchaseContractId: contractId,
        warehouseId: warehouseA.id,
        receiptDate: utcDate('2026-04-20'),
        receivedById: ctx.admin.id,
        lines: [
          { batchId: batch.id, quantityKg: '21000', lotNumber: '120229' },
          { batchId: batch.id, quantityKg: '21000', lotNumber: '120230' },
        ],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const batches = await prisma.batch.findMany({
      where: { purchaseContractId: contractId },
      include: { lot: true },
      orderBy: { batchNumber: 'asc' },
    });

    // One contract line, two lots, and the placeholder gone from both.
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.lot.lotNumber)).toEqual(['120229', '120230']);
    expect(batches.every((b) => !b.traceabilityPending)).toBe(true);
    for (const b of batches) {
      expect(dec(b.receivedQuantityKg).toString()).toBe('21000');
    }

    lot229BatchId = batches[0].id;
  });

  it('puts 42,000 KG into the warehouse, 21,000 under each lot', async () => {
    const stock = (await getBatchStock({ companyId })).filter((r) => ['120229', '120230'].includes(r.lotNumber));

    expect(stock).toHaveLength(2);
    expect(stock.every((r) => r.warehouseNames === warehouseA.name)).toBe(true);

    const total = stock.reduce((sum, r) => sum.plus(dec(r.availableKg)), dec(0));
    expect(total.toString()).toBe('42000');
    for (const row of stock) {
      expect(dec(row.availableKg).toString()).toBe('21000');
    }
  });

  it('leaves nothing in transit and nothing still to receive', async () => {
    const batches = await prisma.batch.findMany({ where: { purchaseContractId: contractId } });
    for (const b of batches) {
      expect(dec(b.inTransitQuantityKg).toString()).toBe('0');
    }

    // Every contract line fully received, so nothing is still outstanding.
    const status = await getReceiptStatus(prisma as never, contractId);
    expect(status.every((line) => dec(line.outstandingKg).isZero())).toBe(true);
  });
});

describe('5 — the sale draws from a named lot at a named location', () => {
  it('invoices 5,000 KG of lot 120229 with a due date the user chose', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-05-10'),
        // The client's own example: dated the 10th, due on the 15th. Not a
        // term, a date.
        dueDate: utcDate('2026-05-15'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '0.101522',
        rateLocalPerUsd: '9.85',
        lines: [
          {
            batchId: lot229BatchId,
            warehouseId: warehouseA.id,
            quantity: '5000',
            unit: 'KG',
            unitPrice: '62.00',
          },
        ],
      },
      ctx.admin.id,
    );
    invoiceId = invoice.id;
    await postSalesInvoice({ id: invoiceId, companyId, userId: ctx.admin.id });

    const posted = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(posted.dueDate).toEqual(utcDate('2026-05-15'));
    // Derived from the two dates, not chosen from a list.
    expect(posted.paymentTermDays).toBe(5);
  });

  it('takes the coffee out of lot 120229 only', async () => {
    const stock = await getBatchStock({ companyId });
    const lot229 = stock.find((r) => r.lotNumber === '120229')!;
    const lot230 = stock.find((r) => r.lotNumber === '120230')!;

    expect(dec(lot229.availableKg).toString()).toBe('16000');
    expect(dec(lot230.availableKg).toString()).toBe('21000');
  });

  it('will not sell more of a lot than that lot holds', async () => {
    await expect(
      createSalesInvoice(
        {
          companyId,
          invoiceDate: utcDate('2026-05-11'),
          customerId: masters.customer.id,
          currency: 'MAD',
          rateToUsd: '0.101522',
          rateLocalPerUsd: '9.85',
          lines: [
            { batchId: lot229BatchId, warehouseId: warehouseA.id, quantity: '17000', unit: 'KG', unitPrice: '62.00' },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/available|enough/i);
  });

  it('shows the customer as the consignee on the loading sheet', async () => {
    const row = (await getLoadingSheet(companyId)).find((r) => r.batchId === lot229BatchId)!;
    expect(row.consignee).toBe(masters.customer.customerName);
    expect(row.saleStatus).toBe('PARTIALLY_SOLD');
    expect(dec(row.soldKg).toString()).toBe('5000');
  });
});

describe('6 — two partial payments, both kept', () => {
  it('records a first cash payment and reduces what is outstanding', async () => {
    const cash = await getCashAccount(companyId, 'MAD');

    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-05-16'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '120000',
        rateToUsd: '0.101522',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'CASH',
        cashBankAccountId: cash.id,
        allocations: [{ salesInvoiceId: invoiceId, amount: '120000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const rows = await getReceivables({ companyId, onlyOutstanding: true });
    const row = rows.find((r) => r.invoiceId === invoiceId)!;
    // 5,000 KG at MAD 62.00 is MAD 310,000.
    expect(dec(row.originalAmount).toString()).toBe('310000');
    expect(dec(row.paidAmount).toString()).toBe('120000');
    expect(dec(row.outstandingAmount).toString()).toBe('190000');
    expect(row.status).toBe('PARTIAL');
  });

  it('records a second payment without overwriting the first', async () => {
    const cash = await getCashAccount(companyId, 'MAD');

    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-05-28'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '90000',
        rateToUsd: '0.101522',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'CASH',
        cashBankAccountId: cash.id,
        allocations: [{ salesInvoiceId: invoiceId, amount: '90000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    // Both payments stand as separate transactions against the invoice.
    const allocations = await prisma.receiptAllocation.findMany({
      where: { salesInvoiceId: invoiceId },
      include: { receipt: true },
      orderBy: { receipt: { receiptDate: 'asc' } },
    });
    expect(allocations).toHaveLength(2);
    expect(allocations.map((a) => dec(a.amount).toString())).toEqual(['120000', '90000']);

    const rows = await getReceivables({ companyId, onlyOutstanding: true });
    const row = rows.find((r) => r.invoiceId === invoiceId)!;
    expect(dec(row.paidAmount).toString()).toBe('210000');
    expect(dec(row.outstandingAmount).toString()).toBe('100000');
  });

  it('moves the cash, and the books still reconcile', async () => {
    const cash = await getCashAccount(companyId, 'MAD');
    const balance = await getCashBankBalance(prisma as never, companyId, cash.id);
    expect(dec(balance).toString()).toBe('210000');

    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  });
});
