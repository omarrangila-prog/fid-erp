import { beforeAll, describe, expect, it } from 'vitest';
import {
  prisma,
  resetDatabase,
  getContext,
  createMasters,
  getCashAccount,
  utcDate,
  receiveEverything,
} from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createStockTransfer } from '@/lib/services/stock-transfer';
import { createGoodsReceipt } from '@/lib/services/goods-receipt';

/**
 * The awkward inputs.
 *
 * Everything here is something a tired person will eventually type into the
 * real system: a zero, a minus sign, the same reference twice, a transfer to
 * the warehouse the stock is already in. Each one must be refused clearly
 * rather than quietly accepted and reconciled later by an accountant.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let contractId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id);

  const contract = await createPurchaseContract(
    {
      companyId: ctx.dubai.id,
      contractReference: 'EDGE-REF-001',
      contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '3.6725',
      freightAmount: '0',
      lines: [
        {
          itemId: masters.item.id,
          lotNumber: 'EDGE-LOT-1',
          batchNumber: 'EDGE-B001',
          containerNumber: 'EDGU1000001',
          quantity: '10000',
          unit: 'KG',
          unitPrice: '4.00',
          bagWeightKg: '60',
        },
      ],
    },
    ctx.admin.id,
  );
  contractId = contract.id;
  await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  await receiveEverything({
    companyId: ctx.dubai.id,
    purchaseContractId: contract.id,
    warehouseId: masters.warehouse.id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-01-20'),
  });
});

function batch() {
  return prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contractId } });
}

async function sale(quantity: string, unitPrice: string) {
  const b = await batch();
  return createSalesInvoice(
    {
      companyId: ctx.dubai.id,
      invoiceDate: utcDate('2026-02-01'),
      customerId: masters.customer.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '3.6725',
      lines: [
        { batchId: b.id, warehouseId: masters.warehouse.id, quantity, unit: 'KG', unitPrice },
      ],
    },
    ctx.admin.id,
  );
}

describe('quantities that make no sense', () => {
  it('refuses a sale of zero kilograms', async () => {
    await expect(sale('0', '6.00')).rejects.toThrow();
  });

  it('refuses a sale of a negative quantity', async () => {
    await expect(sale('-500', '6.00')).rejects.toThrow();
  });

  it('refuses a negative unit price', async () => {
    await expect(sale('100', '-6.00')).rejects.toThrow();
  });

  it('refuses a purchase line of zero kilograms', async () => {
    await expect(
      createPurchaseContract(
        {
          companyId: ctx.dubai.id,
          contractReference: 'EDGE-REF-ZERO',
          contractDate: utcDate('2026-01-05'),
          vendorId: masters.vendor.id,
          currency: 'USD',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          freightAmount: '0',
          lines: [
            {
              itemId: masters.item.id,
              lotNumber: 'ZERO-LOT',
              batchNumber: 'ZERO-B',
              quantity: '0',
              unit: 'KG',
              unitPrice: '4.00',
              bagWeightKg: '60',
            },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
  });
});

describe('duplicate references', () => {
  it('refuses a second contract with the same reference', async () => {
    await expect(
      createPurchaseContract(
        {
          companyId: ctx.dubai.id,
          contractReference: 'EDGE-REF-001',
          contractDate: utcDate('2026-01-06'),
          vendorId: masters.vendor.id,
          currency: 'USD',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          freightAmount: '0',
          lines: [
            {
              itemId: masters.item.id,
              lotNumber: 'DUP-LOT',
              batchNumber: 'DUP-B',
              quantity: '1000',
              unit: 'KG',
              unitPrice: '4.00',
              bagWeightKg: '60',
            },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/already used/i);
  });

  it('refuses to reuse a batch number inside the same company', async () => {
    await expect(
      createPurchaseContract(
        {
          companyId: ctx.dubai.id,
          contractReference: 'EDGE-REF-002',
          contractDate: utcDate('2026-01-06'),
          vendorId: masters.vendor.id,
          currency: 'USD',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          freightAmount: '0',
          lines: [
            {
              itemId: masters.item.id,
              lotNumber: 'EDGE-LOT-1',
              batchNumber: 'EDGE-B001',
              quantity: '1000',
              unit: 'KG',
              unitPrice: '4.00',
              bagWeightKg: '60',
            },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
  });
});

describe('warehouse transfers', () => {
  it('refuses a transfer into the warehouse the coffee is already in', async () => {
    const b = await batch();
    await expect(
      createStockTransfer(
        {
          companyId: ctx.dubai.id,
          transferDate: utcDate('2026-02-02'),
          fromWarehouseId: masters.warehouse.id,
          toWarehouseId: masters.warehouse.id,
          lines: [{ batchId: b.id, quantityKg: '100' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
  });

  it('refuses a transfer of zero kilograms', async () => {
    const b = await batch();
    await expect(
      createStockTransfer(
        {
          companyId: ctx.dubai.id,
          transferDate: utcDate('2026-02-02'),
          fromWarehouseId: masters.warehouses[0].id,
          toWarehouseId: masters.warehouses[1].id,
          lines: [{ batchId: b.id, quantityKg: '0' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
  });
});

describe('goods receipt limits', () => {
  it('refuses a receipt of zero kilograms', async () => {
    const b = await batch();
    await expect(
      createGoodsReceipt(
        {
          companyId: ctx.dubai.id,
          purchaseContractId: contractId,
          warehouseId: masters.warehouse.id,
          receiptDate: utcDate('2026-01-21'),
          receivedById: ctx.admin.id,
          lines: [{ batchId: b.id, quantityKg: '0' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
  });
});

describe('stock messages are specific', () => {
  it('names the batch and the quantity actually available', async () => {
    const b = await batch();
    // 10,000 KG was received; ask for more.
    let message = '';
    try {
      const invoice = await sale('11000', '6.00');
      await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/available|only/i);
    expect(message).toContain(b.batchNumber);
  });
});

describe('money that does not add up', () => {
  it('refuses a receipt for a negative amount', async () => {
    await expect(
      createReceipt(
        {
          companyId: ctx.dubai.id,
          receiptDate: utcDate('2026-02-10'),
          customerId: masters.customer.id,
          currency: 'USD',
          amount: '-100',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          paymentMethod: 'BANK_TRANSFER',
          cashBankAccountId: (await getCashAccount(ctx.dubai.id, 'USD')).id,
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
  });

  it('refuses a receipt of zero', async () => {
    await expect(
      createReceipt(
        {
          companyId: ctx.dubai.id,
          receiptDate: utcDate('2026-02-10'),
          customerId: masters.customer.id,
          currency: 'USD',
          amount: '0',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          paymentMethod: 'BANK_TRANSFER',
          cashBankAccountId: (await getCashAccount(ctx.dubai.id, 'USD')).id,
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
  });
});

describe('unlimited partial payments keep their own history', () => {
  it('records every instalment separately and tracks the outstanding down', async () => {
    const invoice = await sale('8000', '50.00'); // USD 400,000
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const bank = await getCashAccount(ctx.dubai.id, 'USD');
    const instalments = ['50000', '100000', '25000', '25000'];
    const expectedOutstanding = ['350000', '250000', '225000', '200000'];

    for (const [index, amount] of instalments.entries()) {
      const receipt = await createReceipt(
        {
          companyId: ctx.dubai.id,
          receiptDate: utcDate('2026-03-01'),
          customerId: masters.customer.id,
          currency: 'USD',
          amount,
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          paymentMethod: 'BANK_TRANSFER',
          cashBankAccountId: bank.id,
          allocations: [{ salesInvoiceId: invoice.id, amount }],
        },
        ctx.admin.id,
      );
      await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

      const allocations = await prisma.receiptAllocation.findMany({
        where: { salesInvoiceId: invoice.id },
      });
      // Every instalment survives as its own row — nothing is overwritten.
      expect(allocations).toHaveLength(index + 1);

      const paid = allocations.reduce((sum, a) => sum + Number(a.amount), 0);
      expect(400000 - paid).toBeCloseTo(Number(expectedOutstanding[index]), 2);
    }

    const receipts = await prisma.receipt.findMany({
      where: { companyId: ctx.dubai.id, status: 'POSTED' },
    });
    expect(receipts.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses an instalment larger than what is still owed', async () => {
    const invoice = await prisma.salesInvoice.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, status: 'POSTED' },
      orderBy: { createdAt: 'desc' },
    });
    const bank = await getCashAccount(ctx.dubai.id, 'USD');
    await expect(
      createReceipt(
        {
          companyId: ctx.dubai.id,
          receiptDate: utcDate('2026-03-02'),
          customerId: masters.customer.id,
          currency: 'USD',
          amount: '999999',
          rateToUsd: '1',
          rateLocalPerUsd: '3.6725',
          paymentMethod: 'BANK_TRANSFER',
          cashBankAccountId: bank.id,
          allocations: [{ salesInvoiceId: invoice.id, amount: '999999' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow();
  });
});
