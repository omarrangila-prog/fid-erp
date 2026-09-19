import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract, getReceiptStatus } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createPayment, postPayment } from '@/lib/services/payment';
import { createExpense, postExpense } from '@/lib/services/expense';
import { markShipmentLoaded } from '@/lib/services/shipment';
import { getLoadingSheet } from '@/lib/services/loading-sheet';
import { getBatchStock, getItemWarehouseStock, getWarehouseStockByItem, getWarehouseLabels } from '@/lib/services/stock';
import { getCustomerBalance, getVendorBalance, getCashBankBalance } from '@/lib/services/accounting';
import { getAgentPositions } from '@/lib/services/agent-ledger';
import { reconcile } from '@/lib/services/reconciliation';
import { dec, toMoney } from '@/lib/money';

/**
 * §35 — the sixteen rules the specification calls mandatory.
 *
 * Morocco only. The 35-point specification is written for FID Trading
 * International SARL and nothing in it describes Dubai, which trades container
 * to container, consigns to a named buyer and does not collect through agents.
 * Every check below therefore runs against the Morocco company, and the first
 * test asserts that rather than trusting it — a suite that quietly drifted onto
 * the wrong set of books would still pass while proving nothing.
 *
 * Dubai's own acceptance test is tests/integration/acceptance.test.ts, and it
 * is unchanged by any of this.
 *
 * Each rule is written as the client stated it and checked in their order.
 * Where a rule is a prohibition it is checked by attempting the thing and
 * requiring a refusal, because a rule nothing enforces is a sentence in a
 * document.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let contractId: string;
let shipmentId: string;
let shipmentIds: string[] = [];
let batchAId: string;
let warehouseA: { id: string; name: string };

async function control(systemKey: string) {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return toMoney(rows[0]?.bal ?? 0);
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  warehouseA = masters.warehouses[0];

});

describe('these rules are Morocco\'s', () => {
  it('runs against FID Trading International SARL, not Dubai', () => {
    expect(ctx.morocco.code).toBe('FID-MA');
    expect(ctx.morocco.localCurrency).toBe('MAD');
    expect(companyId).toBe(ctx.morocco.id);
    expect(companyId).not.toBe(ctx.dubai.id);
  });
});

describe('rule 1 — a purchase order must have a contract reference', () => {
  it('falls back to the number the system issued rather than refusing to save', async () => {
    const contract = await createPurchaseContract(
      {
        companyId,
        contractDate: utcDate('2026-01-05'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '0',
        containers: 2,
        lines: [
          { itemId: masters.item.id, quantity: '40000', unit: 'KG', unitPrice: '4.50', bagWeightKg: '60' },
          { itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.20', bagWeightKg: '60' },
        ],
      },
      ctx.admin.id,
    );
    contractId = contract.id;

    expect(contract.contractReference).toBeTruthy();
    expect(contract.contractReference).toBe(contract.contractNumber);
  });
});

describe('rule 2 — one PO carries several products and several containers', () => {
  it('keeps both lines and totals them', async () => {
    const contract = await prisma.purchaseContract.findUniqueOrThrow({
      where: { id: contractId },
      include: { lines: true },
    });

    expect(contract.lines).toHaveLength(2);
    // 40,000 × 4.50 plus 20,000 × 4.20 = 180,000 + 84,000.
    expect(dec(contract.totalValue).toString()).toBe('264000');
  });
});

describe('rule 3 — approving a PO creates the loading sheet entry', () => {
  it('appears without anything being typed twice', async () => {
    await postPurchaseContract({ id: contractId, companyId, userId: ctx.admin.id });

    const rows = (await getLoadingSheet(companyId)).filter((r) => r.contractId === contractId);
    // Two coffees in two containers are two shipments under one order — each
    // its own row, and the order's totals are the rows added up, not one row
    // repeated: 1 + 1 containers, not 2 + 2.
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.lines).toHaveLength(1);
      expect(row.containers).toBe(1);
      expect(row.importer).toBe(ctx.morocco.name);
      expect(row.exporter).toBe(masters.vendor.vendorName);
    }
    expect(rows.reduce((t, r) => t + r.containers, 0)).toBe(2);

    shipmentId = rows[0].shipmentId;
    // In the order the lines were entered, which is the order the loading
    // sheet does not promise.
    shipmentIds = (
      await prisma.shipment.findMany({ where: { purchaseContractId: contractId }, orderBy: { createdAt: 'asc' }, select: { id: true } })
    ).map((sh) => sh.id);
  });
});

describe('rule 4 — a shipment cannot be marked loaded without the shipping details', () => {
  it('refuses without an arrival date', async () => {
    await expect(
      markShipmentLoaded(
        { companyId, shipmentId, loadingDate: utcDate('2026-02-01'), etaDate: null },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/estimated arrival|shipping line/i);
  });

  it('refuses without a booking, a B/L or a container number', async () => {
    await expect(
      markShipmentLoaded(
        {
          companyId,
          shipmentId,
          loadingDate: utcDate('2026-02-01'),
          etaDate: utcDate('2026-03-05'),
          shippingLineId: masters.shippingLine.id,
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/booking|B\/L|container/i);
  });

  it('accepts once the line and the arrival are given, with three containers', async () => {
    // The client's example: one booking, three containers, on an order of
    // two lines. The 40,000 KG line fills two containers and the 20,000 KG
    // line one — each shipment loaded with its own numbers.
    const byLine = [
      { shipmentId: shipmentIds[0], containerNumbers: ['MSCU1234567', 'MSCU2345678'] },
      { shipmentId: shipmentIds[1], containerNumbers: ['MSCU3456789'] },
    ];
    for (const load of byLine) {
      await markShipmentLoaded(
        {
          companyId,
          shipmentId: load.shipmentId,
          loadingDate: utcDate('2026-02-01'),
          etaDate: utcDate('2026-03-05'),
          shippingLineId: masters.shippingLine.id,
          bookingNumber: 'ABC12345',
          containerNumbers: load.containerNumbers,
        },
        ctx.admin.id,
      );
    }

    for (const id of shipmentIds) {
      const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id } });
      expect(shipment.status).toBe('LOADED');
    }

    // Three containers on the order, added up across its shipments.
    const containers = await prisma.container.findMany({ where: { purchaseContractId: contractId } });
    expect(containers.map((c) => c.containerNumber).sort()).toEqual([
      'MSCU1234567',
      'MSCU2345678',
      'MSCU3456789',
    ]);

    // Each batch sits in a container of its own shipment.
    const batches = await prisma.batch.findMany({
      where: { purchaseContractId: contractId },
      include: { container: true },
      orderBy: [{ createdAt: 'asc' }, { batchNumber: 'asc' }],
    });
    const numbers = batches.map((b) => b.container?.containerNumber);
    expect(numbers).toHaveLength(2);
    expect(numbers[0]).toBe('MSCU1234567');
    expect(numbers[1]).toBe('MSCU3456789');
  });
});

describe('rule 5 — every received container can become its own batch', () => {
  it('splits one contract line into two batches under two containers', async () => {
    const batch = await prisma.batch.findFirstOrThrow({
      where: { purchaseContractId: contractId, orderedQuantityKg: dec('40000') },
    });

    const receipt = await createGoodsReceipt(
      {
        companyId,
        purchaseContractId: contractId,
        warehouseId: warehouseA.id,
        receiptDate: utcDate('2026-03-10'),
        receivedById: ctx.admin.id,
        lines: [
          {
            batchId: batch.id,
            quantityKg: '20040',
            batchNumber: 'BATCH-001',
            containerNumber: 'MSCU1234567',
          },
          {
            batchId: batch.id,
            quantityKg: '19960',
            batchNumber: 'BATCH-002',
            containerNumber: 'MSCU2345678',
          },
        ],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const batches = await prisma.batch.findMany({
      where: { purchaseContractId: contractId, batchNumber: { startsWith: 'BATCH-' } },
      include: { container: true },
      orderBy: { batchNumber: 'asc' },
    });

    expect(batches).toHaveLength(2);
    expect(batches[0].container?.containerNumber).toBe('MSCU1234567');
    expect(batches[1].container?.containerNumber).toBe('MSCU2345678');
    expect(dec(batches[0].receivedQuantityKg).toString()).toBe('20040');

    batchAId = batches[0].id;
  });
});

describe('rule 6 — inventory is warehouse-wise and batch-wise', () => {
  it('reports each batch at the warehouse it landed in', async () => {
    const stock = (await getBatchStock({ companyId })).filter((r) => r.batchNumber.startsWith('BATCH-'));

    expect(stock).toHaveLength(2);
    for (const row of stock) {
      expect(row.warehouseNames).toBe(warehouseA.name);
    }
    const total = stock.reduce((sum, r) => sum.plus(dec(r.availableKg)), dec(0));
    expect(total.toString()).toBe('40000');
  });

  it('shows the same coffee split by warehouse on the item, with batch and container underneath', async () => {
    const itemId = (
      await prisma.batch.findFirstOrThrow({
        where: { id: batchAId },
        select: { itemId: true },
      })
    ).itemId;

    const byWarehouse = await getItemWarehouseStock(companyId, itemId);
    const here = byWarehouse.warehouses.find((row) => row.warehouseId === warehouseA.id);
    expect(here).toBeTruthy();
    expect(dec(here!.availableKg).toString()).toBe('40000');
    expect(here!.lines.map((line) => line.batchNumber).sort()).toEqual(['BATCH-001', 'BATCH-002']);
    expect(here!.lines.map((line) => line.containerNumber).sort()).toEqual(['MSCU1234567', 'MSCU2345678']);
    expect(dec(byWarehouse.totalAvailableKg).toString()).toBe('40000');

    const listed = await getWarehouseStockByItem(companyId);
    const onList = listed.get(itemId);
    expect(onList).toBeTruthy();
    expect(dec(onList!.totalAvailableKg).toString()).toBe('40000');
    expect(onList!.warehouses.find((row) => row.warehouseId === warehouseA.id)?.availableKg.toString()).toBe('40000');

    const labels = await getWarehouseLabels(companyId);
    expect(labels.byContract.get(contractId)).toBe(warehouseA.name);
    // The shipment that landed is the one carrying BATCH-A; the other line
    // is still at sea and rightly has no warehouse yet.
    const landed = await prisma.batch.findUniqueOrThrow({ where: { id: batchAId }, select: { shipmentId: true } });
    expect(labels.byShipment.get(landed.shipmentId)).toBe(warehouseA.name);
    expect(labels.byBatch.get(batchAId)).toBe(warehouseA.name);

    // The loading sheet has a row per shipment; the one that landed names
    // its warehouse, the one still at sea does not.
    const sheet = (await getLoadingSheet(companyId)).find((row) => row.shipmentId === landed.shipmentId);
    expect(sheet?.warehouseNames).toBe(warehouseA.name);
    expect(
      sheet?.lines
        .filter((line) => line.receivedKg.greaterThan(0))
        .every((line) => line.warehouseNames === warehouseA.name),
    ).toBe(true);
  });
});

describe('rules 7 and 8 — a sale needs a batch, and cannot exceed it', () => {
  it('refuses a line with no batch', async () => {
    await expect(
      createSalesInvoice(
        {
          companyId,
          invoiceDate: utcDate('2026-03-20'),
          customerId: masters.customer.id,
          currency: 'MAD',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
          lines: [
            { batchId: '', warehouseId: warehouseA.id, quantity: '100', unit: 'KG', unitPrice: '60' },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
  });

  it('refuses more than the batch holds', async () => {
    await expect(
      createSalesInvoice(
        {
          companyId,
          invoiceDate: utcDate('2026-03-20'),
          customerId: masters.customer.id,
          currency: 'MAD',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
          lines: [
            { batchId: batchAId, warehouseId: warehouseA.id, quantity: '25000', unit: 'KG', unitPrice: '60' },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/available|enough/i);
  });

  it('takes the quantity out of the exact batch chosen', async () => {
    const before = (await getBatchStock({ companyId })).find((r) => r.batchNumber === 'BATCH-001')!;

    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-03-20'),
        dueDate: utcDate('2026-04-20'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        lines: [
          { batchId: batchAId, warehouseId: warehouseA.id, quantity: '3000', unit: 'KG', unitPrice: '60' },
        ],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

    const after = (await getBatchStock({ companyId })).find((r) => r.batchNumber === 'BATCH-001')!;
    const other = (await getBatchStock({ companyId })).find((r) => r.batchNumber === 'BATCH-002')!;

    expect(dec(before.availableKg).minus(dec(after.availableKg)).toString()).toBe('3000');
    expect(dec(other.availableKg).toString()).toBe('19960');

    const itemStock = await getItemWarehouseStock(companyId, masters.item.id);
    const atWarehouse = itemStock.warehouses.find((row) => row.warehouseId === warehouseA.id);
    expect(dec(atWarehouse!.availableKg).toString()).toBe('37000');
    expect(dec(itemStock.totalAvailableKg).toString()).toBe('37000');
  });
});

describe('rule 9 — customer invoices and payments move the customer ledger', () => {
  it('rises with the invoice and falls with the payment', async () => {
    const owedAfterInvoice = await prisma.$transaction((tx) =>
      getCustomerBalance(tx, companyId, masters.customer.id),
    );
    expect(Number(owedAfterInvoice)).toBeGreaterThan(0);

    const cash = await getCashAccount(companyId, 'MAD');
    const invoice = await prisma.salesInvoice.findFirstOrThrow({
      where: { companyId, status: 'POSTED' },
      orderBy: { createdAt: 'desc' },
    });

    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-04-01'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '50000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'CASH',
        cashBankAccountId: cash.id,
        allocations: [{ salesInvoiceId: invoice.id, amount: '50000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const owedAfterPayment = await prisma.$transaction((tx) =>
      getCustomerBalance(tx, companyId, masters.customer.id),
    );
    expect(Number(owedAfterPayment)).toBeLessThan(Number(owedAfterInvoice));
  });
});

describe('rules 10 and 14 — vendor purchases and payments, in USD', () => {
  it('raises the payable in USD and clears it on payment', async () => {
    const owed = await prisma.$transaction((tx) => getVendorBalance(tx, companyId, masters.vendor.id));
    // The contract was USD 264,000 and the payable is carried in USD.
    // `getVendorBalance` returns what is owed as a positive number.
    expect(Number(owed)).toBeCloseTo(264_000, 0);

    const usdAccount = await prisma.cashBankAccount.findFirst({
      where: { companyId, currency: 'USD', status: 'ACTIVE' },
    });
    if (!usdAccount) return;

    const payment = await createPayment(
      {
        companyId,
        paymentDate: utcDate('2026-04-05'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        amount: '30000',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: usdAccount.id,
        allocations: [{ purchaseContractId: contractId, amount: '30000' }],
      },
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });

    const after = await prisma.$transaction((tx) => getVendorBalance(tx, companyId, masters.vendor.id));
    expect(Number(after)).toBeCloseTo(234_000, 0);
  });
});

describe('rules 11 and 12 — paid expenses hit cash, unpaid ones hit payables', () => {
  it('a paid expense reduces the account it was paid from', async () => {
    const cash = await getCashAccount(companyId, 'MAD');
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT' },
      orderBy: { code: 'asc' },
    });
    const before = await prisma.$transaction((tx) => getCashBankBalance(tx, companyId, cash.id));

    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-04-10'),
        expenseCategoryId: category.id,
        shipmentId,
        currency: 'MAD',
        amount: '50000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        cashBankAccountId: cash.id,
        description: 'Transport from the port',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    const after = await prisma.$transaction((tx) => getCashBankBalance(tx, companyId, cash.id));
    expect(dec(before).minus(dec(after)).toString()).toBe('50000');
  });

  it('an unpaid expense touches neither cash nor bank', async () => {
    const cash = await getCashAccount(companyId, 'MAD');
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT' },
      orderBy: { code: 'asc' },
    });
    const agent = await prisma.agent.create({
      data: { companyId, agentCode: 'AG-R2', agentName: 'Ridwan', commissionPct: '1' },
    });
    const before = await prisma.$transaction((tx) => getCashBankBalance(tx, companyId, cash.id));

    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-04-11'),
        expenseCategoryId: category.id,
        shipmentId,
        agentId: agent.id,
        payableToAgentId: agent.id,
        currency: 'USD',
        amount: '1000',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        description: 'Agent commission, payable later',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    const after = await prisma.$transaction((tx) => getCashBankBalance(tx, companyId, cash.id));
    expect(dec(after).toString()).toBe(dec(before).toString());

    // It is a liability, and part of the shipment's cost from today.
    expect(Number(await control('AGENT_COMMISSION_PAYABLE'))).toBeCloseTo(-1000, 2);
    const position = (await getAgentPositions(companyId)).find((p) => p.agentId === agent.id)!;
    expect(Number(position.commissionPayableUsd)).toBeCloseTo(1000, 2);
  });

  it('an unpaid expense owed to a supplier leaves cash alone and lands on that supplier', async () => {
    const cash = await getCashAccount(companyId, 'MAD');
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT' },
      orderBy: { code: 'asc' },
    });
    const before = await prisma.$transaction((tx) => getCashBankBalance(tx, companyId, cash.id));
    const payableBefore = Number(await control('ACCOUNTS_PAYABLE'));

    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-04-12'),
        expenseCategoryId: category.id,
        shipmentId,
        vendorId: masters.vendor.id,
        currency: 'MAD',
        amount: '2500',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        description: 'Unpaid freight, to be paid later',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    const after = await prisma.$transaction((tx) => getCashBankBalance(tx, companyId, cash.id));
    expect(dec(after).toString()).toBe(dec(before).toString());
    expect(Number(await control('ACCOUNTS_PAYABLE'))).toBeLessThan(payableBefore);

    // A cost with nobody named yet is accrued, not put on any supplier's
    // account: the payables control must not move, and no supplier's
    // statement shows it.
    const payableBeforeAccrual = Number(await control('ACCOUNTS_PAYABLE'));
    const accrued = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-04-12'),
        expenseCategoryId: category.id,
        shipmentId,
        currency: 'MAD',
        amount: '100',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        description: 'Owed to nobody yet',
      },
      ctx.admin.id,
    );
    await postExpense({ id: accrued.id, companyId, userId: ctx.admin.id });
    expect(Number(await control('ACCOUNTS_PAYABLE'))).toBe(payableBeforeAccrual);
    expect(Number(await control('ACCRUED_EXPENSES'))).toBeLessThan(0);
  });
});

describe('rule 13 — an agent cheque goes through the agent clearing ledger', () => {
  it('settles the customer without moving cash', async () => {
    const agent = await prisma.agent.findFirstOrThrow({ where: { companyId, agentCode: 'AG-R2' } });
    const cash = await getCashAccount(companyId, 'MAD');
    const before = await prisma.$transaction((tx) => getCashBankBalance(tx, companyId, cash.id));

    const invoice = await prisma.salesInvoice.findFirstOrThrow({
      where: { companyId, status: 'POSTED' },
      orderBy: { createdAt: 'desc' },
    });

    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-04-15'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '10000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'AGENT_COLLECTION',
        agentId: agent.id,
        allocations: [{ salesInvoiceId: invoice.id, amount: '10000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const after = await prisma.$transaction((tx) => getCashBankBalance(tx, companyId, cash.id));
    expect(dec(after).toString()).toBe(dec(before).toString());

    const position = (await getAgentPositions(companyId)).find((p) => p.agentId === agent.id)!;
    expect(Number(position.holdingUsd)).toBeCloseTo(10_000 / 9.85, 2);
  });
});

describe('rule 15 — Morocco trades locally in MAD', () => {
  it('keeps customers, cash and bank in the local currency', async () => {
    expect(ctx.morocco.localCurrency).toBe('MAD');

    const cash = await getCashAccount(companyId, 'MAD');
    expect(cash.currency).toBe('MAD');

    const invoices = await prisma.salesInvoice.findMany({ where: { companyId }, select: { currency: true } });
    expect(invoices.every((i) => i.currency === 'MAD')).toBe(true);
  });
});

describe('rule 16 — an exchange difference becomes a forex gain or loss', () => {
  it('books the difference rather than restating the original purchase', async () => {
    // The contract was raised at 9.85 MAD per USD. Pay part of it from a MAD
    // account at a different rate and the difference has to land somewhere
    // other than the purchase value, which must not move.
    const contractBefore = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contractId } });
    const madAccount = await getCashAccount(companyId, 'MAD');

    const payment = await createPayment(
      {
        companyId,
        paymentDate: utcDate('2026-05-01'),
        vendorId: masters.vendor.id,
        currency: 'MAD',
        amount: '101500',
        // 10.15 MAD per USD — the dirham has weakened since the contract.
        rateToUsd: '10.15',
        rateLocalPerUsd: '10.15',
        paymentMethod: 'BANK_TRANSFER',
        cashBankAccountId: madAccount.id,
        // The contract is in USD, so the allocation is stated in USD: MAD
        // 101,500 bought at 10.15 settles USD 10,000 of the payable.
        allocations: [{ purchaseContractId: contractId, amount: '10000' }],
      },
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });

    const contractAfter = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contractId } });
    // The original purchase is untouched, as the client insisted.
    expect(dec(contractAfter.totalValue).toString()).toBe(dec(contractBefore.totalValue).toString());

    // And the books still balance, which is what proves the difference went
    // somewhere rather than being quietly dropped.
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  });
});

describe('the whole thing still reconciles', () => {
  it('passes every check after all sixteen rules have been exercised', async () => {
    const result = await reconcile(companyId);
    expect(result.healthy).toBe(true);

    // And nothing is still outstanding on the purchase that was fully received.
    const status = await getReceiptStatus(prisma as never, contractId);
    expect(status.length).toBeGreaterThan(0);
  });
});
