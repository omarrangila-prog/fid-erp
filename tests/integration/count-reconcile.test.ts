import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createStockCount, recordCount, postStockCount } from '@/lib/services/stock-count';
import {
  openReconciliation, getReconciliationWorkspace, setLineReconciled, completeReconciliation,
} from '@/lib/services/bank-reconciliation';
import { getTrialBalanceReport } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let batchId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id);

  const contract = await createPurchaseContract(
    {
      companyId: ctx.dubai.id, contractReference: 'SC-PO-1', contractDate: utcDate('2026-01-05'),
      vendorId: masters.vendor.id, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
      freightAmount: '0',
      lines: [{ itemId: masters.item.id, lotNumber: 'SC-LOT', batchNumber: 'SC-B001',
                quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
  await receiveEverything({
    companyId: ctx.dubai.id, purchaseContractId: contract.id,
    warehouseId: masters.warehouse.id, userId: ctx.admin.id, receiptDate: utcDate('2026-01-20'),
  });
  batchId = (await prisma.batch.findFirstOrThrow({ where: { batchNumber: 'SC-B001' } })).id;
});

describe('physical stock count', () => {
  let countId: string;

  it('produces a sheet that snapshots what the system believes is there', async () => {
    const count = await createStockCount(
      { companyId: ctx.dubai.id, warehouseId: masters.warehouse.id, countDate: utcDate('2026-03-01') },
      ctx.admin.id,
    );
    countId = count.id;
    expect(count.lines).toHaveLength(1);
    expect(Number(count.lines[0].systemKg)).toBeCloseTo(10000, 3);
  });

  it('refuses a second open count for the same warehouse', async () => {
    await expect(
      createStockCount(
        { companyId: ctx.dubai.id, warehouseId: masters.warehouse.id, countDate: utcDate('2026-03-02') },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/still open/i);
  });

  it('will not accept a difference without a reason', async () => {
    await expect(
      recordCount({
        id: countId, companyId: ctx.dubai.id, userId: ctx.admin.id,
        lines: [{ batchId, countedKg: '9950' }],
      }),
    ).rejects.toThrow(/reason/i);
  });

  it('records a shortage and posts the write-down', async () => {
    await recordCount({
      id: countId, companyId: ctx.dubai.id, userId: ctx.admin.id,
      lines: [{ batchId, countedKg: '9950', reason: 'LOSS', notes: 'Sweepings, damaged bags' }],
    });
    await postStockCount({ id: countId, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const balance = await prisma.inventoryBalance.findFirstOrThrow({
      where: { batchId, warehouseId: masters.warehouse.id },
    });
    expect(Number(balance.onHandKg)).toBeCloseTo(9950, 3);

    // 50 KG at the 4.00 landed cost leaves inventory.
    const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
      SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      JOIN accounts a ON a."id" = jl."accountId"
      WHERE je."companyId" = ${ctx.dubai.id} AND je."sourceType" = 'STOCK_COUNT' AND a."systemKey" = 'INVENTORY'`;
    expect(Number(rows[0].bal)).toBeCloseTo(-200, 2);
  });

  it('leaves the books balanced and every reconciliation check passing', async () => {
    expect((await getTrialBalanceReport({ companyId: ctx.dubai.id })).isBalanced).toBe(true);
    const result = await reconcile(ctx.dubai.id);
    expect(result.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  });
});

describe('bank reconciliation', () => {
  let reconciliationId: string;
  let bankId: string;

  beforeAll(async () => {
    const bank = await getCashAccount(ctx.dubai.id, 'USD');
    bankId = bank.id;

    const invoice = await createSalesInvoice(
      {
        companyId: ctx.dubai.id, invoiceDate: utcDate('2026-03-05'), customerId: masters.customer.id,
        currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '3.6725',
        lines: [{ batchId, warehouseId: masters.warehouse.id, quantity: '1000', unit: 'KG', unitPrice: '6.00' }],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    for (const amount of ['4000', '2000']) {
      const receipt = await createReceipt(
        {
          companyId: ctx.dubai.id, receiptDate: utcDate('2026-03-10'), customerId: masters.customer.id,
          currency: 'USD', amount, rateToUsd: '1', rateLocalPerUsd: '3.6725',
          paymentMethod: 'BANK_TRANSFER', cashBankAccountId: bank.id,
          allocations: [{ salesInvoiceId: invoice.id, amount }],
        },
        ctx.admin.id,
      );
      await postReceipt({ id: receipt.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    }
  });

  it('lists the ledger lines waiting to be ticked', async () => {
    const created = await openReconciliation(
      {
        companyId: ctx.dubai.id, cashBankAccountId: bankId,
        statementDate: utcDate('2026-03-31'), statementBalance: '6000',
      },
      ctx.admin.id,
    );
    reconciliationId = created.id;

    const workspace = await getReconciliationWorkspace({
      companyId: ctx.dubai.id, cashBankAccountId: bankId, statementDate: utcDate('2026-03-31'),
    });
    expect(workspace.lines.length).toBeGreaterThanOrEqual(2);
    expect(workspace.lines.every((line) => !line.reconciled)).toBe(true);
  });

  it('refuses sign-off while the statement and the ticked lines differ', async () => {
    await expect(
      completeReconciliation({ id: reconciliationId, companyId: ctx.dubai.id, userId: ctx.admin.id }),
    ).rejects.toThrow(/differ by/i);
  });

  it('signs off once everything is ticked and the difference is nil', async () => {
    const workspace = await getReconciliationWorkspace({
      companyId: ctx.dubai.id, cashBankAccountId: bankId, statementDate: utcDate('2026-03-31'),
    });
    for (const line of workspace.lines) {
      await setLineReconciled({
        companyId: ctx.dubai.id, reconciliationId, journalLineId: line.journalLineId, reconciled: true,
      });
    }

    const after = await getReconciliationWorkspace({
      companyId: ctx.dubai.id, cashBankAccountId: bankId, statementDate: utcDate('2026-03-31'),
    });
    expect(Number(after.reconciledBalance)).toBeCloseTo(6000, 2);
    expect(Number(after.difference)).toBeCloseTo(0, 2);

    const completed = await completeReconciliation({
      id: reconciliationId, companyId: ctx.dubai.id, userId: ctx.admin.id,
    });
    expect(completed.isComplete).toBe(true);
  });

  it('will not let a signed-off reconciliation be altered', async () => {
    const workspace = await getReconciliationWorkspace({
      companyId: ctx.dubai.id, cashBankAccountId: bankId, statementDate: utcDate('2026-03-31'),
    });
    await expect(
      setLineReconciled({
        companyId: ctx.dubai.id, reconciliationId,
        journalLineId: workspace.lines[0].journalLineId, reconciled: false,
      }),
    ).rejects.toThrow(/signed off/i);
  });

  it('reconciling posts nothing to the ledger', async () => {
    expect((await getTrialBalanceReport({ companyId: ctx.dubai.id })).isBalanced).toBe(true);
    const result = await reconcile(ctx.dubai.id);
    expect(result.failed).toBe(0);
  });
});
