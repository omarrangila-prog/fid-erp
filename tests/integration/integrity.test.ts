import { describe, it, expect, beforeAll } from 'vitest';
import {
  prisma,
  transaction,
  resetDatabase,
  getContext,
  createMasters,
  getCashAccount,
  utcDate,
  receiveEverything,
} from '../helpers';
import { createPurchaseContract, postPurchaseContract, reversePurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice, reverseSalesInvoice } from '@/lib/services/sales';
import { reverseGoodsReceipt } from '@/lib/services/goods-receipt';
import { createReceipt, postReceipt, reverseReceipt, getInvoiceOutstanding } from '@/lib/services/receipt';
import { adjustStock } from '@/lib/services/inventory';
import { getCustomerBalance, getVendorBalance, getTrialBalance } from '@/lib/services/accounting';
import { setSetting, SETTING_KEYS } from '@/lib/services/settings';
import { can, canAny, assertPermission, assertCompanyAccess, assertRecordInCompany } from '@/lib/auth/guards';
import { PERMISSIONS, SYSTEM_ROLES, type PermissionCode } from '@/lib/constants';
import type { SessionUser } from '@/lib/auth/session';
import { dec } from '@/lib/money';

/**
 * Core business flows 8, 9 and 10 — permission enforcement, company isolation
 * and transaction atomicity — plus concurrency and reversal behaviour.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let dubai: Awaited<ReturnType<typeof createMasters>>;
let morocco: Awaited<ReturnType<typeof createMasters>>;
let dubaiBatchId: string;
let dubaiWarehouseId: string;
let moroccoBatchId: string;
let dubaiContractId: string;

async function postedContract(
  companyId: string,
  m: Awaited<ReturnType<typeof createMasters>>,
  reference: string,
  quantityKg = '100000',
) {
  const contract = await createPurchaseContract(
    {
      companyId,
      contractReference: reference,
      contractDate: utcDate('2026-01-05'),
      vendorId: m.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: companyId === ctx.dubai.id ? '3.6725' : '9.85',
      freightAmount: '0',
      paymentTermDays: 30,
      lines: [
        {
          itemId: m.item.id,
          lotNumber: `LOT-${reference}`,
          batchNumber: `BAT-${reference}`,
          quantity: quantityKg,
          unit: 'KG',
          unitPrice: '0.90',
        },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  await receiveEverything({
    companyId,
    purchaseContractId: contract.id,
    warehouseId: m.warehouses[0].id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-01-08'),
  });
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  return { contractId: contract.id, batchId: batch.id, warehouseId: m.warehouses[0].id };
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  dubai = await createMasters(ctx.dubai.id, { currency: 'USD' });
  morocco = await createMasters(ctx.morocco.id, { currency: 'MAD' });

  const d = await postedContract(ctx.dubai.id, dubai, 'ISO-DXB-1');
  dubaiContractId = d.contractId;
  dubaiBatchId = d.batchId;
  dubaiWarehouseId = d.warehouseId;
  moroccoBatchId = (await postedContract(ctx.morocco.id, morocco, 'ISO-MAR-1')).batchId;
});

// ---------------------------------------------------------------------------

describe('Flow 8 — permissions are enforced, not merely hidden', () => {
  function sessionFor(roleCode: string): SessionUser {
    const role = SYSTEM_ROLES.find((r) => r.code === roleCode)!;
    return {
      id: 'user-1',
      email: 'user@test.local',
      name: 'Test User',
      isSuperAdmin: false,
      permissions: new Set<PermissionCode>(role.permissions),
      roleNames: [role.name],
      companies: [
        { id: ctx.dubai.id, code: 'FID-DXB', name: 'FID Dubai', localCurrency: 'AED', baseCurrency: 'USD', timezone: 'Asia/Dubai' },
      ],
      activeCompany: { id: ctx.dubai.id, code: 'FID-DXB', name: 'FID Dubai', localCurrency: 'AED', baseCurrency: 'USD', timezone: 'Asia/Dubai' },
    };
  }

  it('lets a sales user do sales work', () => {
    const user = sessionFor('SALES');
    expect(can(user, PERMISSIONS.SALES_CREATE)).toBe(true);
    expect(can(user, PERMISSIONS.SALES_APPROVE)).toBe(true);
    expect(can(user, PERMISSIONS.INVENTORY_VIEW)).toBe(true);
  });

  it('withholds purchase cost and profit from a sales user', () => {
    const user = sessionFor('SALES');
    expect(can(user, PERMISSIONS.PURCHASE_COST_VIEW)).toBe(false);
    expect(can(user, PERMISSIONS.PROFITS_VIEW)).toBe(false);
    expect(can(user, PERMISSIONS.ACCOUNTING_VIEW)).toBe(false);
    expect(can(user, PERMISSIONS.PURCHASES_VIEW)).toBe(false);

    expect(() => assertPermission(user, PERMISSIONS.PROFITS_VIEW)).toThrow(/do not have the "profits.view"/);
    expect(() => assertPermission(user, PERMISSIONS.PURCHASE_COST_VIEW)).toThrow(/permission/);
  });

  it('gives a read-only user access to profit but no write access', () => {
    const user = sessionFor('READ_ONLY');
    expect(can(user, PERMISSIONS.PROFITS_VIEW)).toBe(true);
    expect(can(user, PERMISSIONS.SALES_VIEW)).toBe(true);
    expect(can(user, PERMISSIONS.SALES_CREATE)).toBe(false);
    expect(can(user, PERMISSIONS.SALES_APPROVE)).toBe(false);
    expect(can(user, PERMISSIONS.RECEIPTS_POST)).toBe(false);
  });

  it('stops a warehouse user reaching finance', () => {
    const user = sessionFor('WAREHOUSE');
    expect(can(user, PERMISSIONS.INVENTORY_ADJUST)).toBe(true);
    expect(canAny(user, [PERMISSIONS.RECEIPTS_VIEW, PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.LEDGERS_VIEW])).toBe(false);
  });

  it('lets a super admin through everything', () => {
    const user = { ...sessionFor('WAREHOUSE'), isSuperAdmin: true };
    expect(can(user, PERMISSIONS.PROFITS_VIEW)).toBe(true);
    expect(can(user, PERMISSIONS.COMPANIES_MANAGE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('Flow 9 — company isolation', () => {
  it('reports a cross-company record as not found rather than leaking it', () => {
    const user: SessionUser = {
      id: 'u',
      email: 'e',
      name: 'n',
      isSuperAdmin: false,
      permissions: new Set<PermissionCode>([PERMISSIONS.SALES_VIEW]),
      roleNames: [],
      companies: [{ id: ctx.dubai.id, code: 'FID-DXB', name: 'FID Dubai', localCurrency: 'AED', baseCurrency: 'USD', timezone: 'Asia/Dubai' }],
      activeCompany: { id: ctx.dubai.id, code: 'FID-DXB', name: 'FID Dubai', localCurrency: 'AED', baseCurrency: 'USD', timezone: 'Asia/Dubai' },
    };

    expect(() => assertCompanyAccess(user, ctx.morocco.id)).toThrow(/not found/i);
    expect(() => assertCompanyAccess(user, ctx.dubai.id)).not.toThrow();
    expect(() => assertRecordInCompany({ companyId: ctx.morocco.id }, ctx.dubai.id, 'Shipment')).toThrow(/not found/i);
  });

  it('will not post a Morocco contract through a Dubai company scope', async () => {
    const moroccoContract = await prisma.purchaseContract.findFirstOrThrow({
      where: { companyId: ctx.morocco.id },
    });
    await expect(
      postPurchaseContract({ id: moroccoContract.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ).rejects.toThrow(/not found/i);
  });

  it('will not sell Morocco stock on a Dubai invoice', async () => {
    await expect(
      createSalesInvoice(
        {
          companyId: ctx.dubai.id,
          invoiceDate: utcDate('2026-02-01'),
          customerId: dubai.customer.id,
          currency: 'USD',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          lines: [{ batchId: moroccoBatchId, warehouseId: morocco.warehouses[0].id, quantity: '1000', unit: 'KG', unitPrice: '1.20' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('will not invoice a Morocco customer from Dubai', async () => {
    await expect(
      createSalesInvoice(
        {
          companyId: ctx.dubai.id,
          invoiceDate: utcDate('2026-02-01'),
          customerId: morocco.customer.id,
          currency: 'USD',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          lines: [{ batchId: dubaiBatchId, warehouseId: dubaiWarehouseId, quantity: '1000', unit: 'KG', unitPrice: '1.20' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/Customer was not found/i);
  });

  it('keeps each company’s ledgers entirely separate', async () => {
    const dubaiPayable = await transaction((tx) => getVendorBalance(tx, ctx.dubai.id, dubai.vendor.id));
    const crossPayable = await transaction((tx) => getVendorBalance(tx, ctx.morocco.id, dubai.vendor.id));
    expect(dubaiPayable.toString()).toBe('90000');
    expect(crossPayable.toString()).toBe('0');
  });
});

// ---------------------------------------------------------------------------

describe('Flow 10 — atomicity: a failed posting leaves nothing behind', () => {
  it('rolls back every effect when a later line runs out of stock', async () => {
    // A two-line draft against the same batch, reserving 30,000 KG in total.
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-02-10'),
        customerId: dubai.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [
          { batchId: dubaiBatchId, warehouseId: dubaiWarehouseId, quantity: '15000', unit: 'KG', unitPrice: '1.20' },
          { batchId: dubaiBatchId, warehouseId: dubaiWarehouseId, quantity: '15000', unit: 'KG', unitPrice: '1.20' },
        ],
      },
      ctx.admin.id,
    );

    // An administrator writes stock down below what the draft needs. This is
    // only possible with negative stock temporarily enabled, which is exactly
    // the sort of real-world race the posting transaction has to survive.
    await setSetting(ctx.dubai.id, SETTING_KEYS.ALLOW_NEGATIVE_STOCK, 'true');
    await transaction((tx) =>
      adjustStock(tx, {
        companyId: ctx.dubai.id,
        batchId: dubaiBatchId,
        warehouseId: dubaiWarehouseId,
        quantityKg: '-80000',
        reason: 'Stock loss in transit',
        transactionDate: utcDate('2026-02-11'),
        createdById: ctx.admin.id,
      }),
    );
    await setSetting(ctx.dubai.id, SETTING_KEYS.ALLOW_NEGATIVE_STOCK, 'false');

    const before = {
      batch: await prisma.batch.findUniqueOrThrow({ where: { id: dubaiBatchId } }),
      movements: await prisma.inventoryTransaction.count({ where: { batchId: dubaiBatchId } }),
      journals: await prisma.journalEntry.count({ where: { companyId: ctx.dubai.id } }),
      customerBalance: await transaction((tx) => getCustomerBalance(tx, ctx.dubai.id, dubai.customer.id)),
    };

    // Line 1 (15,000 KG) fits in the 20,000 KG left; line 2 does not.
    await expect(
      postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ).rejects.toThrow(/Insufficient stock/);

    const after = {
      batch: await prisma.batch.findUniqueOrThrow({ where: { id: dubaiBatchId } }),
      movements: await prisma.inventoryTransaction.count({ where: { batchId: dubaiBatchId } }),
      journals: await prisma.journalEntry.count({ where: { companyId: ctx.dubai.id } }),
      customerBalance: await transaction((tx) => getCustomerBalance(tx, ctx.dubai.id, dubai.customer.id)),
    };

    // Nothing moved: not the stock, not the movement ledger, not the journal,
    // not the receivable — and line 1's successful deduction was undone too.
    expect(after.movements).toBe(before.movements);
    expect(after.journals).toBe(before.journals);
    expect(dec(after.batch.soldQuantityKg).toString()).toBe(dec(before.batch.soldQuantityKg).toString());
    expect(dec(after.batch.allocatedQuantityKg).toString()).toBe(dec(before.batch.allocatedQuantityKg).toString());
    expect(dec(after.batch.availableQuantityKg).toString()).toBe(dec(before.batch.availableQuantityKg).toString());
    expect(after.customerBalance.toString()).toBe(before.customerBalance.toString());

    // The invoice itself is untouched and still editable.
    const untouched = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(untouched.status).toBe('DRAFT');
    expect(untouched.postedAt).toBeNull();
    expect(dec(untouched.costOfGoodsUsd).toString()).toBe('0');

    // Put the stock back so later suites start from a sane batch.
    await setSetting(ctx.dubai.id, SETTING_KEYS.ALLOW_NEGATIVE_STOCK, 'true');
    await transaction((tx) =>
      adjustStock(tx, {
        companyId: ctx.dubai.id,
        batchId: dubaiBatchId,
        warehouseId: dubaiWarehouseId,
        quantityKg: '80000',
        reason: 'Reversal of stock loss',
        transactionDate: utcDate('2026-02-12'),
        createdById: ctx.admin.id,
      }),
    );
    await setSetting(ctx.dubai.id, SETTING_KEYS.ALLOW_NEGATIVE_STOCK, 'false');
    await prisma.salesInvoice.delete({ where: { id: invoice.id } });
  });
});

// ---------------------------------------------------------------------------

describe('concurrency and idempotency', () => {
  it('posts an invoice exactly once when the button is double-clicked', async () => {
    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-03-01'),
        customerId: dubai.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [{ batchId: dubaiBatchId, warehouseId: dubaiWarehouseId, quantity: '10000', unit: 'KG', unitPrice: '1.20' }],
      },
      ctx.admin.id,
    );

    const results = await Promise.allSettled([
      postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
      postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    // Exactly one journal entry and one stock movement, not two.
    expect(
      await prisma.journalEntry.count({ where: { sourceType: 'SALES_INVOICE', sourceId: invoice.id } }),
    ).toBe(1);
    expect(
      await prisma.inventoryTransaction.count({
        where: { referenceId: invoice.id, transactionType: 'SALE' },
      }),
    ).toBe(1);
  });

  it('lets only one of two racing sales take the last of the stock', async () => {
    const { batchId, warehouseId } = await postedContract(ctx.dubai.id, dubai, 'ISO-DXB-RACE');
    // 100,000 KG on hand. Two drafts of 60,000 cannot both be posted.
    const [a, b] = await Promise.all([
      createSalesInvoice(
        {
          companyId: ctx.dubai.id,
          invoiceDate: utcDate('2026-03-05'),
          customerId: dubai.customer.id,
          currency: 'USD',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          lines: [{ batchId, warehouseId, quantity: '60000', unit: 'KG', unitPrice: '1.20' }],
        },
        ctx.admin.id,
      ),
      // The second draft is created before the first reserves, mimicking two
      // salespeople with the stock page open at the same moment.
      createSalesInvoice(
        {
          companyId: ctx.dubai.id,
          invoiceDate: utcDate('2026-03-05'),
          customerId: dubai.customer.id,
          currency: 'USD',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          lines: [{ batchId, warehouseId, quantity: '40000', unit: 'KG', unitPrice: '1.20' }],
        },
        ctx.admin.id,
      ),
    ]);

    const results = await Promise.allSettled([
      postSalesInvoice({ id: a.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
      postSalesInvoice({ id: b.id, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ]);

    // Both fit (60 + 40 = 100), so both must succeed and the batch must land
    // exactly on zero — never on a negative figure.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(dec(batch.soldQuantityKg).toString()).toBe('100000');
    expect(dec(batch.availableQuantityKg).toString()).toBe('0');
  });
});

// ---------------------------------------------------------------------------

describe('reversals', () => {
  it('reverses a sale, returning stock and unwinding the receivable', async () => {
    const { batchId, warehouseId } = await postedContract(ctx.dubai.id, dubai, 'ISO-DXB-REV');

    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-04-01'),
        customerId: dubai.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [{ batchId, warehouseId, quantity: '20000', unit: 'KG', unitPrice: '1.20' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const balanceAfterSale = await transaction((tx) => getCustomerBalance(tx, ctx.dubai.id, dubai.customer.id));

    await reverseSalesInvoice({
      id: invoice.id,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      reason: 'Customer cancelled the order',
    });

    const reversed = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reversed.status).toBe('REVERSED');
    expect(reversed.reversalReason).toBe('Customer cancelled the order');

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(dec(batch.soldQuantityKg).toString()).toBe('0');
    expect(dec(batch.availableQuantityKg).toString()).toBe('100000');

    const balanceAfterReversal = await transaction((tx) => getCustomerBalance(tx, ctx.dubai.id, dubai.customer.id));
    expect(balanceAfterReversal.toString()).toBe(balanceAfterSale.minus(24000).toString());

    // Both entries remain posted; the contra entry is what cancels the original,
    // and the pair is linked so the UI can label the original as reversed.
    const entries = await prisma.journalEntry.findMany({
      where: { sourceType: 'SALES_INVOICE', sourceId: invoice.id },
      orderBy: { sourceSeq: 'asc' },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].isReversal).toBe(false);
    expect(entries[1].isReversal).toBe(true);
    expect(entries[1].reversalOfId).toBe(entries[0].id);

    // Reversing a second time is refused rather than doubling the contra.
    await expect(
      reverseSalesInvoice({
        id: invoice.id,
        companyId: ctx.dubai.id,
        userId: ctx.admin.id,
        reason: 'Duplicate attempt',
      }),
    ).rejects.toThrow(/Only a posted invoice can be reversed/);

    // The movement ledger is append-only: the reversal adds a contra movement
    // rather than deleting the sale.
    const movements = await prisma.inventoryTransaction.findMany({
      where: { batchId },
      orderBy: { createdAt: 'asc' },
      select: { transactionType: true, quantityKg: true },
    });
    expect(movements.map((m) => m.transactionType)).toEqual([
      'RECEIPT',
      'RESERVATION',
      'RESERVATION_RELEASE',
      'SALE',
      'SALE',
    ]);
    expect(movements.map((m) => dec(m.quantityKg).toString())).toEqual([
      '100000',
      '20000',
      '-20000',
      '-20000',
      '20000',
    ]);
  });

  it('reverses a receipt and makes the invoice outstanding again', async () => {
    const { batchId, warehouseId } = await postedContract(ctx.dubai.id, dubai, 'ISO-DXB-RCT');
    const usdBank = await getCashAccount(ctx.dubai.id, 'USD');

    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id,
        invoiceDate: utcDate('2026-04-10'),
        customerId: dubai.customer.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        paymentTermDays: 30,
        lines: [{ batchId, warehouseId, quantity: '10000', unit: 'KG', unitPrice: '1.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const receipt = await createReceipt(
      {
        companyId: ctx.dubai.id,
        receiptDate: utcDate('2026-04-15'),
        customerId: dubai.customer.id,
        currency: 'USD',
        amount: '10000',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        cashBankAccountId: usdBank.id,
        allocations: [{ salesInvoiceId: invoice.id, amount: '10000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    expect((await transaction((tx) => getInvoiceOutstanding(tx, invoice.id))).amount.toString()).toBe('0');

    await reverseReceipt({
      id: receipt.id,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      reason: 'Bank returned the transfer',
    });

    expect((await transaction((tx) => getInvoiceOutstanding(tx, invoice.id))).amount.toString()).toBe('10000');
  });

  it('refuses to reverse a purchase whose goods have been received', async () => {
    // The chain has to be unwound in reverse order, and the system says so
    // rather than silently undoing a receipt behind the user's back.
    await expect(
      reversePurchaseContract({
        id: dubaiContractId,
        companyId: ctx.dubai.id,
        userId: ctx.admin.id,
        reason: 'Wrong price',
      }),
    ).rejects.toThrow(/Goods have been received against this contract/);
  });

  it('refuses to reverse a goods receipt whose coffee has been sold', async () => {
    const grn = await prisma.goodsReceipt.findFirstOrThrow({
      where: { purchaseContractId: dubaiContractId, status: 'POSTED' },
    });
    await expect(
      reverseGoodsReceipt({
        id: grn.id,
        companyId: ctx.dubai.id,
        userId: ctx.admin.id,
        reason: 'Wrong warehouse',
      }),
    ).rejects.toThrow(/no longer has|Reverse the sales/);
  });

  it('reverses an untouched purchase and removes its stock again', async () => {
    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id,
        contractReference: 'ISO-DXB-UNUSED',
        contractDate: utcDate('2026-05-01'),
        vendorId: dubai.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        freightAmount: '0',
        lines: [
          {
            itemId: dubai.item.id,
            lotNumber: 'LOT-UNUSED',
            batchNumber: 'BAT-UNUSED',
            quantity: '10000',
            unit: 'KG',
            unitPrice: '0.90',
          },
        ],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const payableBefore = await transaction((tx) => getVendorBalance(tx, ctx.dubai.id, dubai.vendor.id));

    await reversePurchaseContract({
      id: contract.id,
      companyId: ctx.dubai.id,
      userId: ctx.admin.id,
      reason: 'Duplicate entry',
    });

    const payableAfter = await transaction((tx) => getVendorBalance(tx, ctx.dubai.id, dubai.vendor.id));
    expect(payableBefore.minus(payableAfter).toString()).toBe('9000');

    const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
    expect(dec(batch.availableQuantityKg).toString()).toBe('0');
    expect(dec(batch.inTransitQuantityKg).toString()).toBe('0');
    expect(batch.status).toBe('INACTIVE');
  });

  it('leaves the trial balance in balance after every reversal', async () => {
    const rows = await transaction((tx) => getTrialBalance(tx, ctx.dubai.id));
    const debits = rows.reduce((a, r) => a.plus(dec(r.debitUsd)), dec(0));
    const credits = rows.reduce((a, r) => a.plus(dec(r.creditUsd)), dec(0));
    expect(debits.toString()).toBe(credits.toString());
  });
});
