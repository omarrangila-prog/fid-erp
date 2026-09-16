import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, transaction } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt } from '@/lib/services/goods-receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import { postJournalEntry, reverseJournalEntry } from '@/lib/services/accounting';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { dec } from '@/lib/money';

/**
 * Regression coverage for the outstanding, GRN and journal defects that the
 * main trading suites did not walk: tax-inclusive payables are paid elsewhere;
 * this file checks batch splits after freight, over-receipt of one batch, and
 * journal reversals keeping the agent on the line.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  masters = await createMasters(ctx.dubai.id);
});

describe('a goods receipt against one contract batch', () => {
  it('refuses two lines that together take more than was ordered', async () => {
    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id,
        contractDate: utcDate('2026-01-05'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        freightAmount: '0',
        lines: [{ itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });

    await expect(
      createGoodsReceipt(
        {
          companyId: ctx.dubai.id,
          purchaseContractId: contract.id,
          warehouseId: masters.warehouse.id,
          receiptDate: utcDate('2026-01-20'),
          receivedById: ctx.admin.id,
          lines: [
            { batchId: batch.id, quantityKg: '6000', lotNumber: 'OV-LOT', batchNumber: 'OV-B1' },
            { batchId: batch.id, quantityKg: '6000', lotNumber: 'OV-LOT', batchNumber: 'OV-B1' },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/still to be received/i);
  });

  it('moves capitalised freight onto both halves when a batch is split at receipt', async () => {
    const contract = await createPurchaseContract(
      {
        companyId: ctx.dubai.id,
        contractDate: utcDate('2026-02-01'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
        freightAmount: '0',
        lines: [{ itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId: ctx.dubai.id, userId: ctx.admin.id });
    const original = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });

    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, status: 'ACTIVE', kind: 'SHIPMENT', capitaliseByDefault: true },
      orderBy: { code: 'asc' },
    });
    const bank = await getCashAccount(ctx.dubai.id, 'USD');
    const expense = await createExpense(
      {
        companyId: ctx.dubai.id,
        expenseDate: utcDate('2026-02-05'),
        expenseCategoryId: category.id,
        shipmentId: original.shipmentId,
        cashBankAccountId: bank.id,
        currency: 'USD',
        amount: '2000',
        rateToUsd: '1',
        rateLocalPerUsd: '3.6725',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId: ctx.dubai.id, userId: ctx.admin.id });

    const loaded = await prisma.batch.findUniqueOrThrow({ where: { id: original.id } });
    expect(Number(loaded.capitalisedCostUsd)).toBeCloseTo(2000, 2);

    await createGoodsReceipt(
      {
        companyId: ctx.dubai.id,
        purchaseContractId: contract.id,
        warehouseId: masters.warehouse.id,
        receiptDate: utcDate('2026-02-10'),
        receivedById: ctx.admin.id,
        lines: [
          { batchId: original.id, quantityKg: '5000', lotNumber: 'SP-LOT-A', batchNumber: 'SP-A' },
          { batchId: original.id, quantityKg: '5000', lotNumber: 'SP-LOT-B', batchNumber: 'SP-B' },
        ],
      },
      ctx.admin.id,
    );

    const halves = await prisma.batch.findMany({
      where: { purchaseContractId: contract.id },
      orderBy: { batchNumber: 'asc' },
    });
    expect(halves).toHaveLength(2);
    expect(halves.map((b) => Number(b.capitalisedCostUsd).toFixed(2)).sort()).toEqual(['1000.00', '1000.00']);
    expect(halves.reduce((sum, b) => sum.plus(b.capitalisedCostUsd), dec(0)).toString()).toBe('2000');
  });
});

describe('a manual journal reversal', () => {
  it('keeps the agent on every reversed line', async () => {
    const agent = await prisma.agent.create({
      data: { companyId: ctx.dubai.id, agentCode: 'JV-AG', agentName: 'Journal Agent' },
    });
    const sourceId = `JV-AGENT-${Date.now()}`;

    await transaction(async (tx) => {
      await postJournalEntry(tx, {
        companyId: ctx.dubai.id,
        entryDate: utcDate('2026-03-01'),
        description: 'Agent clearing adjustment',
        sourceType: 'MANUAL',
        sourceId,
        createdById: ctx.admin.id,
        localCurrency: 'AED',
        rateLocalPerUsd: '3.6725',
        lines: [
          {
            accountKey: ACCOUNT_KEYS.AGENT_CLEARING,
            direction: 'DEBIT',
            currency: 'USD',
            amount: '250',
            rateToUsd: '1',
            agentId: agent.id,
          },
          {
            accountKey: ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE,
            direction: 'CREDIT',
            currency: 'USD',
            amount: '250',
            rateToUsd: '1',
            agentId: agent.id,
            customerId: masters.customer.id,
          },
        ],
      });
    });

    await transaction(async (tx) => {
      await reverseJournalEntry(tx, {
        companyId: ctx.dubai.id,
        sourceType: 'MANUAL',
        sourceId,
        createdById: ctx.admin.id,
        entryDate: utcDate('2026-03-02'),
        reason: 'Posted to the wrong agent',
      });
    });

    const reversal = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, sourceId, isReversal: true },
      include: { lines: true },
    });
    expect(reversal.lines.length).toBeGreaterThan(0);
    expect(reversal.lines.every((line) => line.agentId === agent.id)).toBe(true);
  });

  it('refuses an account that belongs to the other company', async () => {
    const moroccoCash = await prisma.account.findFirstOrThrow({
      where: { companyId: ctx.morocco.id, systemKey: 'INVENTORY_ADJUSTMENT' },
    });
    const dubaiExpense = await prisma.account.findFirstOrThrow({
      where: { companyId: ctx.dubai.id, type: 'EXPENSE' },
    });

    await expect(
      transaction(async (tx) =>
        postJournalEntry(tx, {
          companyId: ctx.dubai.id,
          entryDate: utcDate('2026-03-03'),
          description: 'Cross-company account',
          sourceType: 'MANUAL',
          sourceId: `JV-XCO-${Date.now()}`,
          createdById: ctx.admin.id,
          localCurrency: 'AED',
          rateLocalPerUsd: '3.6725',
          lines: [
            { accountId: dubaiExpense.id, direction: 'DEBIT', currency: 'USD', amount: '10', rateToUsd: '1' },
            { accountId: moroccoCash.id, direction: 'CREDIT', currency: 'USD', amount: '10', rateToUsd: '1' },
          ],
        }),
      ),
    ).rejects.toThrow(/account/i);
  });
});
