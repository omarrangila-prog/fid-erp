import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { changeShipmentStatus, updateShipmentDetails } from '@/lib/services/shipment';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import { getReceivables } from '@/lib/services/receivables';
import { getFinancialPosition } from '@/lib/services/reports';
import { getCustomerLedger } from '@/lib/services/ledger';
import { reconcile } from '@/lib/services/reconciliation';

/**
 * The client's own two acceptance scenarios, run end to end.
 *
 * These are not unit tests of a service; they are the two sentences the client
 * used to describe his business, executed against the real posting engine and
 * then checked everywhere the result is supposed to appear.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
});

// ---------------------------------------------------------------------------
// §60 — Dubai: container to container
// ---------------------------------------------------------------------------

describe('Dubai: one container, one buyer', () => {
  let masters: Awaited<ReturnType<typeof createMasters>>;
  let contractId: string;
  let shipmentId: string;
  let batchId: string;
  let invoiceId: string;

  it('creates a purchase contract and puts it on the loading sheet automatically', async () => {
    masters = await createMasters(ctx.dubai.id);

    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id,
        contractReference: 'INV JAN26/3995',
        contractDate: utcDate('2026-01-08'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        freightAmount: '0',
        destination: 'Jebel Ali, Dubai',
        lines: [
          {
            itemId: masters.item.id,
            lotNumber: 'ACC/LOT/1',
            batchNumber: 'ACC-B-C001',
            containerNumber: 'C001',
            quantity: '19200',
            unit: 'KG',
            unitPrice: '4.10',
            bagWeightKg: '60',
          },
        ],
      },
      ctx.admin.id,
    );
    contractId = contract.id;

    await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    // Both references survive, and both are on the sheet.
    const sheet = await getLoadingSheet(ctx.dubai.id);
    const row = sheet.find((entry) => entry.contractReference === 'INV JAN26/3995');
    expect(row, 'the contract should appear on the loading sheet without anyone creating a row').toBeDefined();
    expect(row!.contractNumber).toMatch(/^FID-DXB-PO-/);
    expect(row!.containerNumber).toBe('C001');

    // The importer is the FID company, never typed by the user.
    expect(row!.importer).toBe(ctx.dubai.name);
    // Nobody has bought it yet.
    expect(row!.consignee).toBeNull();
    expect(row!.saleStatus).toBe('UNSOLD');
    expect(row!.paymentStatus).toBe('NONE');

    shipmentId = row!.shipmentId;
    batchId = row!.batchId;
  });

  it('does not put the coffee in a warehouse merely because it was ordered', async () => {
    const onHand = await prisma.inventoryBalance.aggregate({
      where: { batchId },
      _sum: { onHandKg: true },
    });
    expect(Number(onHand._sum.onHandKg ?? 0)).toBe(0);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(Number(batch.inTransitQuantityKg)).toBeCloseTo(19_200, 3);
  });

  it('carries the shipping line, B/L and ETA onto the sheet as they are entered', async () => {
    await updateShipmentDetails({
      shipmentId,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      shippingLineId: masters.shippingLine.id,
      billOfLading: 'MAEU-2026-77120',
      bookingNumber: 'BKG-77120',
      vesselName: 'MV Jebel Trader',
      voyageNumber: 'JT2604',
      portOfLoading: 'Santos',
      portOfDischarge: 'Jebel Ali',
      loadingDate: utcDate('2026-01-25'),
      etdDate: utcDate('2026-01-26'),
      etaDate: utcDate('2026-02-18'),
    });
    // The workflow will not skip a step: a container is awaiting loading before
    // it is loaded, and refusing the jump is what keeps the sheet honest.
    for (const toStatus of ['AWAITING_LOADING', 'LOADED'] as const) {
      await changeShipmentStatus({ shipmentId, companyId: ctx.dubai.id, userId: ctx.admin.id, toStatus });
    }

    const row = (await getLoadingSheet(ctx.dubai.id)).find((entry) => entry.batchId === batchId)!;
    expect(row.billOfLading).toBe('MAEU-2026-77120');
    expect(row.status).toBe('LOADED');
    expect(row.etaDate?.toISOString().slice(0, 10)).toBe('2026-02-18');
  });

  it('sells the whole container and fills in the consignee by itself', async () => {
    await receiveEverything({
      companyId: ctx.dubai.id,
      purchaseContractId: contractId,
      warehouseId: masters.warehouse.id,
      userId: ctx.admin.id,
      receiptDate: utcDate('2026-02-20'),
    });

    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-02-25'),
        customerId: masters.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [
          { batchId, warehouseId: masters.warehouse.id, quantity: '19200', unit: 'KG', unitPrice: '6.20' },
        ],
      },
      ctx.admin.id,
    );
    invoiceId = invoice.id;
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const row = (await getLoadingSheet(ctx.dubai.id)).find((entry) => entry.batchId === batchId)!;
    // Nobody typed the consignee onto the sheet; the sale supplied it.
    expect(row.consignee).toBe(masters.customer.customerName);
    expect(row.saleStatus).toBe('FULLY_SOLD');
    // Dated in February on 30-day terms, so by now it is past due — which is
    // the more useful thing to say than merely "unpaid".
    expect(row.paymentStatus).toBe('OVERDUE');
    expect(row.allocations).toHaveLength(1);
    expect(row.allocations[0].invoiceNumber).toMatch(/^FID-DXB-SI-/);
  });

  it('settles a USD invoice with an AED payment at the rate agreed that day', async () => {
    // The customer owes USD 119,040 and pays AED 100,000, agreed at USD 27,240.
    const aed = await getCashAccount(ctx.dubai.id, 'AED');

    const receipt = await createReceipt(
      {
        companyId: ctx.dubai.id,
        receiptDate: utcDate('2026-03-10'),
        customerId: masters.customer.id,
        currency: 'AED',
        amount: '100000',
        usdEquivalent: '27240',
        rateLocalPerUsd: '3.6725',
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: aed.id,
        allocations: [{ salesInvoiceId: invoiceId, amount: '27240' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    // The bank got exactly what arrived…
    const bank = await prisma.$queryRaw<Array<{ bal: string }>>`
      SELECT COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS bal
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      WHERE je."companyId" = ${ctx.dubai.id} AND je."status" = 'POSTED'
        AND jl."cashBankAccountId" = ${aed.id}`;
    expect(Number(bank[0].bal)).toBeCloseTo(100_000, 2);

    // …and the customer's USD balance fell by the agreed USD figure, not by
    // AED 100,000 converted at some other rate.
    const receivables = await getReceivables({ companyId: ctx.dubai.id, onlyOutstanding: true });
    const row = receivables.find((entry) => entry.invoiceId === invoiceId)!;
    expect(Number(row.outstandingAmount)).toBeCloseTo(119_040 - 27_240, 2);

    // The rate is stored on the voucher, so it is never recomputed later.
    const stored = await prisma.receipt.findFirstOrThrow({ where: { id: receipt.id } });
    expect(Number(stored.rateToUsd)).toBeCloseTo(100_000 / 27_240, 6);
  });

  it('shows the payment on the loading sheet and the customer ledger', async () => {
    const row = (await getLoadingSheet(ctx.dubai.id)).find((entry) => entry.batchId === batchId)!;
    // Part paid, but the balance is still past its due date, and being overdue
    // is what the person chasing it needs to see.
    expect(row.paymentStatus).toBe('OVERDUE');
    expect(row.allocations[0].settlement).toBe('OVERDUE');

    const ledger = await getCustomerLedger({
      companyId: ctx.dubai.id,
      customerId: masters.customer.id,
      view: 'TRANSACTION',
      localCurrency: 'AED',
      partyCurrency: 'USD',
    });
    // The invoice and the receipt, both on the customer's own account.
    expect(ledger.rows.length).toBeGreaterThanOrEqual(2);
    expect(Number(ledger.closingBalance)).toBeCloseTo(119_040 - 27_240, 2);
  });

  it('leaves every control account agreeing with its sub-ledger', async () => {
    const result = await reconcile(ctx.dubai.id);
    expect(result.checks.filter((check) => !check.passed).map((c) => c.label)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §61 — Morocco: one purchase, many customers
// ---------------------------------------------------------------------------

describe('Morocco: one container split across four customers', () => {
  let masters: Awaited<ReturnType<typeof createMasters>>;
  let customers: Array<{ id: string; customerName: string }>;
  let contractId: string;
  let batchId: string;

  it('receives 20,000 KG into warehouse A', async () => {
    masters = await createMasters(ctx.morocco.id, { currency: 'MAD' });

    customers = [masters.customer];
    for (const name of ['Customer B', 'Customer C', 'Customer D']) {
      customers.push(
        await prisma.customer.create({
          data: {
            companyId: ctx.morocco.id,
            customerCode: `ACC-${name.replace(/\s+/g, '')}`,
            customerName: name,
            country: 'Morocco',
            primaryCurrency: 'MAD',
            paymentTermDays: 30,
          },
        }),
      );
    }

    const contract = await createPurchaseContract(
      {
        companyId: ctx.morocco.id,
        contractReference: 'ACC-MA-2026-01',
        contractDate: utcDate('2026-01-10'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '0',
        lines: [
          {
            itemId: masters.item.id,
            lotNumber: 'ACC/MA/LOT',
            batchNumber: 'B001',
            quantity: '20000',
            unit: 'KG',
            unitPrice: '3.00',
            bagWeightKg: '60',
          },
        ],
      },
      ctx.admin.id,
    );
    contractId = contract.id;
    await postPurchaseContract({ id: contract.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

    await receiveEverything({
      companyId: ctx.morocco.id,
      purchaseContractId: contract.id,
      warehouseId: masters.warehouses[0].id,
      userId: ctx.admin.id,
      receiptDate: utcDate('2026-02-01'),
    });

    batchId = (await prisma.batch.findFirstOrThrow({ where: { companyId: ctx.morocco.id, batchNumber: 'B001' } })).id;

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { batchId, warehouseId: masters.warehouses[0].id },
    });
    expect(Number(balance.onHandKg)).toBeCloseTo(20_000, 3);
  });

  it('sells it to four customers without overwriting the purchase', async () => {
    const splits = [4_000, 3_000, 2_000, 5_000];

    for (const [index, quantity] of splits.entries()) {
      const invoice = await createSalesInvoice(
        {
          companyId: ctx.morocco.id,
          invoiceDate: utcDate(`2026-02-${String(10 + index * 3).padStart(2, '0')}`),
          customerId: customers[index].id,
          currency: 'MAD',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
          paymentTermDays: 30,
          lines: [
            {
              batchId,
              warehouseId: masters.warehouses[0].id,
              quantity: String(quantity),
              unit: 'KG',
              unitPrice: '42.00',
            },
          ],
        },
        ctx.admin.id,
      );
      await postSalesInvoice({ id: invoice.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
    }

    // The purchase is still one contract with one batch.
    const contract = await prisma.purchaseContract.findUniqueOrThrow({
      where: { id: contractId },
      include: { lines: true, batches: true },
    });
    expect(contract.lines).toHaveLength(1);
    expect(contract.batches).toHaveLength(1);

    // Four separate sales.
    const invoices = await prisma.salesInvoice.findMany({
      where: { companyId: ctx.morocco.id, status: 'POSTED' },
    });
    expect(invoices).toHaveLength(4);
  });

  it('reports 14,000 KG sold and 6,000 KG remaining', async () => {
    const row = (await getLoadingSheet(ctx.morocco.id)).find((entry) => entry.batchId === batchId)!;

    expect(Number(row.quantityKg)).toBeCloseTo(20_000, 3);
    expect(Number(row.soldKg)).toBeCloseTo(14_000, 3);
    expect(Number(row.availableKg)).toBeCloseTo(6_000, 3);
    expect(row.saleStatus).toBe('PARTIALLY_SOLD');

    // The row names the count, not the last customer to take some.
    expect(row.consignee).toBe('4 customers');
    expect(row.allocations).toHaveLength(4);
    expect(row.allocations.map((a) => Number(a.quantityKg))).toEqual([4_000, 3_000, 2_000, 5_000]);
  });

  it('keeps each customer ledger separate', async () => {
    for (const [index, expected] of [4_000, 3_000, 2_000, 5_000].entries()) {
      const ledger = await getCustomerLedger({
        companyId: ctx.morocco.id,
        customerId: customers[index].id,
        view: 'TRANSACTION',
        localCurrency: 'MAD',
        partyCurrency: 'MAD',
      });
      // MAD 42 per KG, and nobody else's tonnage on their account.
      expect(Number(ledger.closingBalance)).toBeCloseTo(expected * 42, 2);
    }
  });

  it('values the remaining stock and the cost of what was sold correctly', async () => {
    const position = await getFinancialPosition({ companyId: ctx.morocco.id });
    // 6,000 KG left at USD 3.00 landed.
    expect(Number(position.inventoryValueUsd)).toBeCloseTo(18_000, 2);

    const cogs = await prisma.$queryRaw<Array<{ bal: string }>>`
      SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      JOIN accounts a ON a."id" = jl."accountId"
      WHERE je."companyId" = ${ctx.morocco.id} AND je."status" = 'POSTED'
        AND a."systemKey" = 'COST_OF_GOODS_SOLD'`;
    // 14,000 KG sold at USD 3.00.
    expect(Number(cogs[0].bal)).toBeCloseTo(42_000, 2);
  });

  it('leaves Morocco reconciled, and Dubai untouched by any of it', async () => {
    for (const company of [ctx.morocco, ctx.dubai]) {
      const result = await reconcile(company.id);
      expect(
        result.checks.filter((check) => !check.passed).map((c) => `${company.code}: ${c.label}`),
      ).toEqual([]);
    }

    // Company isolation: Morocco's batch is invisible from Dubai.
    const crossCompany = await prisma.batch.findFirst({ where: { id: batchId, companyId: ctx.dubai.id } });
    expect(crossCompany).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A contract raised with the minimum a person actually has to hand
// ---------------------------------------------------------------------------

describe('the least a purchase contract needs', () => {
  it('saves without a supplier reference, and uses the FID number instead', async () => {
    const masters = await createMasters(ctx.dubai.id);

    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id,
        // No contractReference at all: the deal is agreed, the paperwork has
        // not arrived, and there is nothing to type here yet.
        contractDate: utcDate('2026-04-01'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        freightAmount: '0',
        lines: [
          {
            itemId: masters.item.id,
            // A lot only. The supplier gave no batch mark.
            lotNumber: 'MIN/LOT/1',
            quantity: '5000',
            unit: 'KG',
            unitPrice: '4.25',
            bagWeightKg: '60',
          },
        ],
      },
      ctx.admin.id,
    );

    expect(contract.contractNumber).toMatch(/^FID-DXB-PO-/);
    // The reference falls back to the number the system issued, so it is still
    // unique and still searchable — it just was not typed.
    expect(contract.contractReference).toBe(contract.contractNumber);

    // And the missing batch was filled from the lot, so stock can still move.
    expect(contract.lines[0].lotNumber).toBe('MIN/LOT/1');
    expect(contract.lines[0].batchNumber).toBe('MIN/LOT/1');
  });

  it('saves with a batch and no lot, the other way round', async () => {
    const masters = await createMasters(ctx.dubai.id);

    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id,
        contractReference: 'MIN-REF-2',
        contractDate: utcDate('2026-04-02'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        freightAmount: '0',
        lines: [
          {
            itemId: masters.item.id,
            batchNumber: 'MIN-BATCH-2',
            quantity: '3000',
            unit: 'KG',
            unitPrice: '4.25',
            bagWeightKg: '60',
          },
        ],
      },
      ctx.admin.id,
    );

    expect(contract.lines[0].batchNumber).toBe('MIN-BATCH-2');
    expect(contract.lines[0].lotNumber).toBe('MIN-BATCH-2');
  });

  it('still refuses a line with neither', async () => {
    const masters = await createMasters(ctx.dubai.id);

    await expect(
      createPurchaseContract(
        {
          companyId: ctx.dubai.id,
          contractDate: utcDate('2026-04-03'),
          vendorId: masters.vendor.id,
          currency: 'USD',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          freightAmount: '0',
          lines: [
            { itemId: masters.item.id, quantity: '1000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/lot number or a batch number/i);
  });
});
