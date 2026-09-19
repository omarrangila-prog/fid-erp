import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate, transaction } from '../helpers';
import { computePurchaseTotals } from '@/lib/calc/purchase';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, updateSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt, getInvoiceOutstanding } from '@/lib/services/receipt';
import { createPayment, postPayment } from '@/lib/services/payment';
import { createExpense, postExpense } from '@/lib/services/expense';
import {
  markShipmentLoaded,
  changeDocumentStatus,
  changeShipmentStatus,
  markOrderArrived,
  updateShipmentEta,
  getEtaHistory,
} from '@/lib/services/shipment';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import { getBatchStock } from '@/lib/services/stock';
import { getCustomerLedger, getVendorLedger } from '@/lib/services/ledger';
import { getCashBankBalance } from '@/lib/services/accounting';
import { getChartOfAccounts, createLedgerAccount, updateLedgerAccount, deactivateLedgerAccount, postAccountOpeningBalance } from '@/lib/services/chart-of-accounts';
import { getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getTrialBalanceReport, getProfitAndLoss, getBalanceSheet } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';
import { buildCsv, buildWorkbook } from '@/lib/services/workbook';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { DOCUMENT_STATUS_META } from '@/lib/constants';
import { dec, sum } from '@/lib/money';

/**
 * Point-by-point Morocco acceptance.
 *
 * Until a check in this file is green, that item is specified, not completed.
 * Extra fields on the forms (origin, incoterm, due date, container type) are
 * not under test here and must stay.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let itemBId: string;
let contractId: string;
let shipmentId: string;
let shipmentIds: string[] = [];
let batchAId: string;
let batchBId: string;
let invoiceId: string;
let cashMadId: string;
let bankUsdId: string;
let agentId: string;

async function cashBalance(accountId: string) {
  return transaction((tx) => getCashBankBalance(tx, companyId, accountId));
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  const second = await prisma.coffeeItem.create({
    data: {
      companyId,
      itemCode: `ITM-B-${Date.now().toString(36)}`,
      itemName: 'Colombia Supremo Huila',
      coffeeType: 'ARABICA',
      originCountry: 'Colombia',
      grade: 'Supremo',
      bagWeightKg: '70',
      defaultUnit: 'KG',
    },
  });
  itemBId = second.id;

  cashMadId = (
    await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId, currency: 'MAD', accountType: 'CASH' },
    })
  ).id;
  bankUsdId = (
    await prisma.cashBankAccount.findFirstOrThrow({
      where: { companyId, currency: 'USD', accountType: 'BANK' },
    })
  ).id;

  const agent = await prisma.agent.create({
    data: { companyId, agentCode: 'AG-ACC', agentName: 'Acceptance Agent' },
  });
  agentId = agent.id;
});

describe('1 — PO total calculation is correct', () => {
  it('KG × USD rate equals goods value, freight sits on top', () => {
    const totals = computePurchaseTotals({
      currency: 'USD',
      rateToUsd: '1',
      freightAmount: '5000',
      lines: [
        { itemId: masters.item.id, quantity: '40000', unit: 'KG', unitPrice: '4.50', bagWeightKg: '60' },
        { itemId: itemBId, quantity: '20000', unit: 'KG', unitPrice: '4.20', bagWeightKg: '70' },
      ],
    });

    // 40,000 × 4.50 = 180,000; 20,000 × 4.20 = 84,000; freight 5,000.
    expect(totals.subtotal.toString()).toBe('264000');
    expect(totals.totalValue.toString()).toBe('269000');
    expect(totals.grossPayable.toString()).toBe('269000');
    expect(totals.totalQuantityKg.toString()).toBe('60000');
  });
});

describe('2 — one PO, multiple items, container total is not duplicated', () => {
  it('saves two coffees and two containers as one contract', async () => {
    const contract = await createPurchaseContract(
      {
        companyId,
        contractReference: 'MA-ACC-2026-01',
        contractDate: utcDate('2026-01-10'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '5000',
        containers: 2,
        lines: [
          { itemId: masters.item.id, quantity: '40000', unit: 'KG', unitPrice: '4.50', bagWeightKg: '60' },
          { itemId: itemBId, quantity: '20000', unit: 'KG', unitPrice: '4.20', bagWeightKg: '70' },
        ],
      },
      ctx.admin.id,
    );
    contractId = contract.id;

    expect(contract.lines).toHaveLength(2);
    expect(dec(contract.totalValue).toString()).toBe('269000');
    expect(contract.containers).toBe(2);
  });

  it('approving it creates one loading-sheet row per shipment, added up once', async () => {
    await postPurchaseContract({ id: contractId, companyId, userId: ctx.admin.id });

    // One order, two containers, two shipments: two rows whose containers and
    // kilograms add to the order's — never the order's total on every row.
    const rows = (await getLoadingSheet(companyId)).filter((r) => r.contractId === contractId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.lines).toHaveLength(1);
      expect(row.containers).toBe(1);
      expect(row.importer).toBe(ctx.morocco.name);
      expect(row.exporter).toBe(masters.vendor.vendorName);
    }
    expect(rows.reduce((t, r) => t + r.containers, 0)).toBe(2);
    expect(dec(sum(rows.map((r) => dec(r.quantityKg)))).toString()).toBe('60000');

    shipmentId = rows[0].shipmentId;
    shipmentIds = rows.map((r) => r.shipmentId);
  });
});

describe('3 — separate container numbers', () => {
  it('refuses Loaded without shipping line and ETA', async () => {
    await expect(
      markShipmentLoaded(
        { companyId, shipmentId, loadingDate: utcDate('2026-02-01'), etaDate: null },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/estimated arrival|shipping line/i);
  });

  it('assigns a distinct number to each container', async () => {
    // Each shipment on the order is one container: loaded on its own, with
    // its own number, the way containers really sail.
    const numbers = ['MSCU1111111', 'MSCU2222222'];
    for (const [index, id] of shipmentIds.entries()) {
      await markShipmentLoaded(
        {
          companyId,
          shipmentId: id,
          loadingDate: utcDate('2026-02-01'),
          etaDate: utcDate('2026-03-10'),
          shippingLineId: masters.shippingLine.id,
          bookingNumber: `BK-ACC-${index + 1}`,
          billOfLading: `BL-ACC-${index + 1}`,
          portOfLoading: 'Santos',
          portOfDischarge: 'Casablanca',
          containerNumbers: [numbers[index]],
        },
        ctx.admin.id,
      );
    }

    const containers = await prisma.container.findMany({
      where: { purchaseContractId: contractId },
      orderBy: { containerNumber: 'asc' },
    });
    expect(containers.map((c) => c.containerNumber)).toEqual(numbers);

    const batches = await prisma.batch.findMany({
      where: { purchaseContractId: contractId },
      include: { container: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(new Set(batches.map((b) => b.container?.containerNumber)).size).toBe(2);

    const rows = (await getLoadingSheet(companyId)).filter((r) => r.contractId === contractId);
    expect(rows.flatMap((r) => r.containerNumbers).sort()).toEqual(numbers);
  });
});

describe('4 — document status works independently of cargo', () => {
  it('uses the Morocco labels and records a change without recreating the PO', async () => {
    expect(DOCUMENT_STATUS_META.DRAFT_PENDING.label).toBe('Pending');
    expect(DOCUMENT_STATUS_META.ORIGINALS_WITH_SUPPLIER.label).toBe('With Supplier');
    expect(DOCUMENT_STATUS_META.DRAFT_RECEIVED.label).toBe('Received');
    expect(DOCUMENT_STATUS_META.UNDER_APPROVAL.label).toBe('Awaiting Approval');
    expect(DOCUMENT_STATUS_META.APPROVED.label).toBe('Approved');
    expect(DOCUMENT_STATUS_META.COMPLETED.label).toBe('Complete');

    await changeDocumentStatus({
      shipmentId,
      companyId,
      userId: ctx.admin.id,
      toStatus: 'ORIGINALS_WITH_SUPPLIER',
      notes: 'Originals still with Fazenda',
    });
    await changeDocumentStatus({
      shipmentId,
      companyId,
      userId: ctx.admin.id,
      toStatus: 'APPROVED',
    });

    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    expect(shipment.documentStatus).toBe('APPROVED');
    expect(shipment.status).toBe('LOADED');

    const history = await prisma.shipmentDocumentStatusHistory.findMany({ where: { shipmentId } });
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps an ETA history of old → new → user → time', async () => {
    await updateShipmentEta(
      { companyId, shipmentId, etaDate: utcDate('2026-03-18') },
      ctx.admin.id,
    );
    await updateShipmentEta(
      { companyId, shipmentId, etaDate: utcDate('2026-03-22') },
      ctx.admin.id,
    );

    const history = await getEtaHistory(companyId, shipmentId);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].changedBy).toBeTruthy();
    expect(history[0].to).toBeTruthy();
    expect(history[0].from).toBeTruthy();
  });
});

describe('5 — Arrived then Receive PO per container, batch and warehouse', () => {
  it('marks arrived then receives each container into a named warehouse', async () => {
    // Both containers landed together: one action marks every shipment on
    // the order arrived, each keeping its own history line.
    const marked = await markOrderArrived({ companyId, contractId, userId: ctx.admin.id, ataDate: utcDate('2026-03-22') });
    expect(marked).toEqual({ marked: 2, total: 2 });

    const batches = await prisma.batch.findMany({
      where: { purchaseContractId: contractId },
      orderBy: { orderedQuantityKg: 'desc' },
    });
    expect(batches).toHaveLength(2);

    const warehouseA = masters.warehouses.find((w) => w.code === 'MA-CASA-A') ?? masters.warehouses[0];
    const warehouseB = masters.warehouses.find((w) => w.code === 'MA-CASA-B') ?? masters.warehouses[1];

    const first = await createGoodsReceipt(
      {
        companyId,
        purchaseContractId: contractId,
        warehouseId: warehouseA.id,
        receiptDate: utcDate('2026-03-23'),
        receivedById: ctx.admin.id,
        lines: [
          {
            batchId: batches[0].id,
            quantityKg: batches[0].orderedQuantityKg.toString(),
            lotNumber: 'LOT-A',
            batchNumber: 'BATCH-A',
            containerNumber: 'MSCU1111111',
          },
        ],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: first.id, companyId, userId: ctx.admin.id });

    const second = await createGoodsReceipt(
      {
        companyId,
        purchaseContractId: contractId,
        warehouseId: warehouseB.id,
        receiptDate: utcDate('2026-03-23'),
        receivedById: ctx.admin.id,
        lines: [
          {
            batchId: batches[1].id,
            quantityKg: batches[1].orderedQuantityKg.toString(),
            lotNumber: 'LOT-B',
            batchNumber: 'BATCH-B',
            containerNumber: 'MSCU2222222',
          },
        ],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: second.id, companyId, userId: ctx.admin.id });

    const received = await prisma.batch.findMany({
      where: { purchaseContractId: contractId, batchNumber: { in: ['BATCH-A', 'BATCH-B'] } },
      include: { container: true },
      orderBy: { batchNumber: 'asc' },
    });
    expect(received).toHaveLength(2);
    batchAId = received.find((b) => b.batchNumber === 'BATCH-A')!.id;
    batchBId = received.find((b) => b.batchNumber === 'BATCH-B')!.id;
    expect(received.find((b) => b.batchNumber === 'BATCH-A')?.container?.containerNumber).toBe('MSCU1111111');
    expect(received.find((b) => b.batchNumber === 'BATCH-B')?.container?.containerNumber).toBe('MSCU2222222');
  });
});

describe('6 — inventory KG matches received stock', () => {
  it('shows 60,000 KG on hand across the two warehouses and blocks a sale beyond it', async () => {
    const stock = await getBatchStock({ companyId, purchaseContractId: contractId, includeEmpty: true });
    const received = stock.filter((row) => Number(row.receivedKg) > 0);
    const totalReceived = received.reduce((sum, row) => sum.plus(row.receivedKg), dec(0));
    const totalAvailable = received.reduce((sum, row) => sum.plus(row.availableKg), dec(0));
    expect(Number(totalReceived)).toBeCloseTo(60_000, 3);
    expect(Number(totalAvailable)).toBeCloseTo(60_000, 3);

    const warehouseA = stock.find((row) => row.batchId === batchAId);
    const warehouseB = stock.find((row) => row.batchId === batchBId);
    expect(warehouseA?.warehouseNames).toMatch(/Casablanca Warehouse A/);
    expect(warehouseB?.warehouseNames).toMatch(/Ridwan Warehouse/);

    await expect(
      createSalesInvoice(
        {
          companyId,
          invoiceDate: utcDate('2026-04-01'),
          customerId: masters.customer.id,
          currency: 'MAD',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
          paymentType: 'CREDIT',
          lines: [
            {
              batchId: batchAId,
              warehouseId: masters.warehouses[0].id,
              quantity: '999999',
              unit: 'KG',
              unitPrice: '60',
            },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/available|stock|exceed/i);
  });
});

describe('7 — credit sales invoice posts a balanced journal', () => {
  it('posts without an unbalanced general entry', async () => {
    const warehouseA = masters.warehouses.find((w) => w.code === 'MA-CASA-A') ?? masters.warehouses[0];
    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-04-01'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentType: 'CREDIT',
        lines: [
          {
            batchId: batchAId,
            warehouseId: warehouseA.id,
            quantity: '1000',
            unit: 'KG',
            unitPrice: '70',
          },
        ],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });
    invoiceId = invoice.id;

    const posted = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(posted.status).toBe('POSTED');
    expect(Number(posted.taxAmount)).toBe(0);
    expect(Number(posted.totalAmount)).toBeCloseTo(70_000, 2);

    const unbalanced = await prisma.$queryRaw<Array<{ entryNumber: string }>>`
      SELECT je."entryNumber"
      FROM journal_entries je
      JOIN journal_lines jl ON jl."journalEntryId" = je."id"
      WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'
      GROUP BY je."id", je."entryNumber"
      HAVING ABS(SUM(jl."debitUsd") - SUM(jl."creditUsd")) > 0.0001
    `;
    expect(unbalanced).toEqual([]);
  });
});

describe('8 — editing a posted invoice adjusts stock and the customer ledger', () => {
  it('reduces the quantity and puts the kilograms back', async () => {
    const warehouseA = masters.warehouses.find((w) => w.code === 'MA-CASA-A') ?? masters.warehouses[0];
    const before = await getBatchStock({ companyId, batchId: batchAId, includeEmpty: true });
    const availableBefore = Number(before[0]?.availableKg ?? 0);

    await updateSalesInvoice(
      invoiceId,
      {
        companyId,
        invoiceDate: utcDate('2026-04-01'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentType: 'CREDIT',
        lines: [
          {
            batchId: batchAId,
            warehouseId: warehouseA.id,
            quantity: '800',
            unit: 'KG',
            unitPrice: '70',
          },
        ],
      },
      ctx.admin.id,
    );

    const after = await getBatchStock({ companyId, batchId: batchAId, includeEmpty: true });
    expect(Number(after[0]?.availableKg)).toBeCloseTo(availableBefore + 200, 3);

    const invoice = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('POSTED');
    expect(Number(invoice.totalAmount)).toBeCloseTo(56_000, 2);
  });
});

describe('9 — Record Payment on a credit invoice', () => {
  it('takes a MAD receipt at a rate, without a fake USD amount of zero', async () => {
    const outstandingBefore = await transaction((tx) => getInvoiceOutstanding(tx, invoiceId));
    expect(Number(outstandingBefore.amount)).toBeCloseTo(56_000, 2);

    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-04-05'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '20000',
        rateToUsd: '9.85',
        usdEquivalent: '0',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'CASH',
        cashBankAccountId: cashMadId,
        allocations: [{ salesInvoiceId: invoiceId, amount: '20000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const outstandingAfter = await transaction((tx) => getInvoiceOutstanding(tx, invoiceId));
    expect(Number(outstandingAfter.amount)).toBeCloseTo(36_000, 2);
  });
});

describe('10 — Cash in Hand and Bank update', () => {
  it('puts the receipt into Cash in Hand and a vendor payment out of the USD bank', async () => {
    const cash = await cashBalance(cashMadId);
    expect(Number(cash)).toBeCloseTo(20_000, 2);

    const bankBefore = await cashBalance(bankUsdId);

    const payment = await createPayment(
      {
        companyId,
        paymentDate: utcDate('2026-04-06'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        amount: '1000',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: bankUsdId,
        allocations: [{ purchaseContractId: contractId, amount: '1000' }],
      },
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });

    const bankAfter = await cashBalance(bankUsdId);
    expect(Number(bankBefore.minus(bankAfter))).toBeCloseTo(1000, 2);
  });
});

describe('11 — customer and supplier ledgers show the right amounts', () => {
  it('debits the customer for the invoice and credits the receipt', async () => {
    const ledger = await getCustomerLedger({
      companyId,
      customerId: masters.customer.id,
      view: 'TRANSACTION',
      localCurrency: 'MAD',
      partyCurrency: 'MAD',
    });
    expect(Number(ledger.closingBalance)).toBeCloseTo(36_000, 2);
    expect(ledger.rows.some((row) => row.sourceType === 'SALES_INVOICE')).toBe(true);
    expect(ledger.rows.some((row) => row.sourceType === 'RECEIPT')).toBe(true);
  });

  it('posts goods + freight to the supplier, then the USD payment', async () => {
    const ledger = await getVendorLedger({
      companyId,
      vendorId: masters.vendor.id,
      view: 'USD',
      localCurrency: 'MAD',
      partyCurrency: 'USD',
    });
    // 269,000 payable less 1,000 paid.
    expect(Number(ledger.closingBalance)).toBeCloseTo(268_000, 2);
  });
});

describe('12 — Chart of Accounts exists and journals balance', () => {
  it('lists cash, AR, inventory, AP, sales and COGS', async () => {
    const chart = await getChartOfAccounts(companyId, 'MAD');
    const names = chart.sections.flatMap((section) => section.accounts.map((account) => account.name));
    expect(chart.sections.map((section) => section.key)).toEqual(
      expect.arrayContaining(['cash-bank', 'assets', 'liabilities', 'equity', 'revenue', 'cogs']),
    );
    expect(names.some((name) => /cash in hand/i.test(name))).toBe(true);
    expect(names.some((name) => /receivable/i.test(name))).toBe(true);
    expect(names.some((name) => /inventory/i.test(name))).toBe(true);
    expect(names.some((name) => /payable/i.test(name))).toBe(true);
    expect(names.some((name) => /sales/i.test(name))).toBe(true);
  });
});

describe('13 — ledger export includes every matching row', () => {
  it('builds a CSV from the full customer and supplier ledgers, not a page slice', async () => {
    const customer = await getCustomerLedger({
      companyId,
      customerId: masters.customer.id,
      view: 'TRANSACTION',
      localCurrency: 'MAD',
      partyCurrency: 'MAD',
    });
    const vendor = await getVendorLedger({
      companyId,
      vendorId: masters.vendor.id,
      view: 'USD',
      localCurrency: 'MAD',
      partyCurrency: 'USD',
    });

    const csv = buildCsv(
      ['Date', 'Reference', 'Debit', 'Credit', 'Balance'],
      customer.rows.map((row) => [
        row.entryDate.toISOString().slice(0, 10),
        row.reference,
        Number(row.debit),
        Number(row.credit),
        Number(row.balance),
      ]),
    );
    const text = csv.toString('utf8');
    expect(customer.rows.length).toBeGreaterThanOrEqual(2);
    expect(vendor.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of customer.rows) {
      expect(text).toContain(row.entryDate.toISOString().slice(0, 10));
    }
  });
});

describe('14 — shipment costing and paid vs unpaid expenses', () => {
  it('adds a paid shipment cost to the job and leaves a general expense off it', async () => {
    const clearing = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, code: 'CLEARING' },
    });
    const meals = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, code: 'MEALS' },
    });

    const paid = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-03-24'),
        expenseCategoryId: clearing.id,
        shipmentId,
        currency: 'MAD',
        amount: '9850',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'CASH',
        cashBankAccountId: cashMadId,
        kind: 'SHIPMENT',
        description: 'Clearing',
      },
      ctx.admin.id,
    );
    await postExpense({ id: paid.id, companyId, userId: ctx.admin.id });

    const unpaid = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-03-24'),
        expenseCategoryId: clearing.id,
        shipmentId,
        vendorId: masters.vendor.id,
        currency: 'MAD',
        amount: '1970',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        kind: 'SHIPMENT',
        description: 'Unpaid duty',
      },
      ctx.admin.id,
    );
    await postExpense({ id: unpaid.id, companyId, userId: ctx.admin.id });

    const dinner = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-03-24'),
        expenseCategoryId: meals.id,
        currency: 'MAD',
        amount: '500',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'CASH',
        cashBankAccountId: cashMadId,
        kind: 'GENERAL',
        description: 'Staff dinner',
      },
      ctx.admin.id,
    );
    await postExpense({ id: dinner.id, companyId, userId: ctx.admin.id });

    // The order is two shipments now; its costing is their sheets added up.
    // The clearing charge, booked once, is shared between the two containers
    // and appears once — the staff dinner is a running cost and appears on
    // neither.
    const sheets = await Promise.all(shipmentIds.map((id) => getShipmentCostSheet(companyId, id)));
    expect(Number(sum(sheets.map((x) => x.goodsUsd)))).toBeCloseTo(269_000, 2);
    expect(Number(sum(sheets.map((x) => x.capitalisedUsd)))).toBeCloseTo(1_200, 2);
    const allLines = sheets.flatMap((x) => x.lines);
    expect(allLines).toHaveLength(2);
    expect(allLines.every((line) => line.category !== 'Food / Meals')).toBe(true);
    expect(Number(sum(sheets.map((x) => x.revenueUsd)))).toBeGreaterThan(0);
  });
});

describe('15 — P&L, Balance Sheet and Trial Balance reconcile', () => {
  it('balances the trial balance, the balance sheet and the control checks', async () => {
    const tb = await getTrialBalanceReport({ companyId });
    expect(tb.isBalanced).toBe(true);

    const bs = await getBalanceSheet({ companyId, asOf: utcDate('2026-12-31') });
    expect(bs.balancesUsd).toBe(true);

    const pnl = await getProfitAndLoss({
      companyId,
      from: utcDate('2026-01-01'),
      to: utcDate('2026-12-31'),
    });
    expect(Number(pnl.totals.revenueUsd)).toBeGreaterThan(0);

    const result = await reconcile(companyId);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.label)).toEqual([]);
  });
});

describe('PDF controls — agent clearing and frozen FX', () => {
  it('collects through an agent without increasing Cash in Hand', async () => {
    const warehouseA = masters.warehouses.find((w) => w.code === 'MA-CASA-A') ?? masters.warehouses[0];
    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-04-10'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentType: 'CREDIT',
        lines: [
          {
            batchId: batchAId,
            warehouseId: warehouseA.id,
            quantity: '100',
            unit: 'KG',
            unitPrice: '70',
          },
        ],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

    const cashBefore = await cashBalance(cashMadId);

    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-04-11'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '7000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'AGENT_COLLECTION',
        agentId,
        allocations: [{ salesInvoiceId: invoice.id, amount: '7000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const cashAfter = await cashBalance(cashMadId);
    expect(Number(cashAfter)).toBeCloseTo(Number(cashBefore), 2);

    const stored = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(stored.rateToUsd)).toBeCloseTo(9.85, 6);
  });
});

describe('16 — Chart of Accounts edit, deactivate and opening balance', () => {
  it('renames a custom head, posts an opening and refuses to deactivate a system account', async () => {
    const created = await createLedgerAccount({
      companyId,
      code: '6210',
      name: 'Warehouse rent',
      type: 'EXPENSE',
      reportGroup: 'OPERATING',
    });

    const renamed = await updateLedgerAccount({
      id: created.id,
      companyId,
      name: 'Casablanca warehouse rent',
      reportGroup: 'OPERATING',
    });
    expect(renamed.name).toBe('Casablanca warehouse rent');

    await postAccountOpeningBalance({
      accountId: created.id,
      companyId,
      userId: ctx.admin.id,
      amount: '10000',
      asOf: utcDate('2026-01-01'),
      currency: 'MAD',
      rateToUsd: '9.85',
      rateLocalPerUsd: '9.85',
    });

    const chart = await getChartOfAccounts(companyId, 'MAD');
    const rent = chart.sections.flatMap((section) => section.accounts).find((account) => account.id === created.id);
    expect(rent?.name).toBe('Casablanca warehouse rent');
    expect(Number(rent?.balanceUsd ?? 0)).toBeCloseTo(10000 / 9.85, 2);

    await expect(
      postAccountOpeningBalance({
        accountId: created.id,
        companyId,
        userId: ctx.admin.id,
        amount: '1',
        asOf: utcDate('2026-01-02'),
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
      }),
    ).rejects.toThrow(/already has an opening/i);

    const sales = await prisma.account.findFirstOrThrow({
      where: { companyId, systemKey: 'SALES_REVENUE' },
    });
    await expect(deactivateLedgerAccount({ id: sales.id, companyId })).rejects.toThrow(/system account/i);

    await deactivateLedgerAccount({ id: created.id, companyId });
    const after = await getChartOfAccounts(companyId, 'MAD');
    const hidden = after.sections
      .find((section) => section.key === 'inactive')
      ?.accounts.find((account) => account.id === created.id);
    expect(hidden?.status).toBe('INACTIVE');

    const tb = await getTrialBalanceReport({ companyId });
    expect(tb.isBalanced).toBe(true);
  });
});

describe('17 — a shipment expense can land on one container and batch', () => {
  it('capitalises against BATCH-A only and leaves BATCH-B untouched', async () => {
    const before = await prisma.batch.findMany({
      where: { id: { in: [batchAId, batchBId] } },
      select: { id: true, batchNumber: true, capitalisedCostUsd: true, containerId: true },
    });
    const beforeA = before.find((row) => row.batchNumber === 'BATCH-A')!;
    const beforeB = before.find((row) => row.batchNumber === 'BATCH-B')!;

    const clearing = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, code: 'CLEARING' },
    });

    const targeted = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-04-12'),
        expenseCategoryId: clearing.id,
        shipmentId,
        containerId: beforeA.containerId,
        batchId: batchAId,
        currency: 'MAD',
        amount: '985',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'CASH',
        cashBankAccountId: cashMadId,
        kind: 'SHIPMENT',
        capitaliseToLandedCost: true,
        description: 'Inspection on container A',
      },
      ctx.admin.id,
    );
    await postExpense({ id: targeted.id, companyId, userId: ctx.admin.id });

    const after = await prisma.batch.findMany({
      where: { id: { in: [batchAId, batchBId] } },
      select: { batchNumber: true, capitalisedCostUsd: true },
    });
    const afterA = after.find((row) => row.batchNumber === 'BATCH-A')!;
    const afterB = after.find((row) => row.batchNumber === 'BATCH-B')!;

    expect(Number(afterA.capitalisedCostUsd) - Number(beforeA.capitalisedCostUsd)).toBeCloseTo(100, 2);
    expect(Number(afterB.capitalisedCostUsd)).toBeCloseTo(Number(beforeB.capitalisedCostUsd), 2);

    // The cost is filed under the shipment that actually carries BATCH-A,
    // whichever shipment the form happened to be opened from.
    const carrier = await prisma.batch.findUniqueOrThrow({ where: { id: batchAId }, select: { shipmentId: true } });
    const sheet = await getShipmentCostSheet(companyId, carrier.shipmentId);
    const line = sheet.lines.find((row) => row.expenseId === targeted.id);
    expect(line?.batchNumber).toBe('BATCH-A');
    expect(line?.containerNumber).toBe('MSCU1111111');
  });
});

describe('18 — profitability exports as a real Excel workbook', () => {
  it('writes a workbook whose first two bytes are PK', async () => {
    const rows = await getShipmentProfitability({ companyId });
    expect(rows.length).toBeGreaterThan(0);

    const buffer = await buildWorkbook({
      companyName: 'FID Trading International SARL',
      title: 'Profitability',
      subtitle: 'By job',
      rows,
      columns: [
        { header: 'Job', value: (r) => r.jobNumber },
        { header: 'Revenue (USD)', value: (r) => Number(r.salesRevenueUsd), type: 'money' },
        { header: 'Net profit (USD)', value: (r) => Number(r.netProfitUsd), type: 'money' },
      ],
    });

    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(buffer.byteLength).toBeGreaterThan(2_000);
  });
});
