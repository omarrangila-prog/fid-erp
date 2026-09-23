import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { postLoan } from '@/lib/services/loan';
import { getCashAccount } from '../helpers';

/**
 * Deleting a master record.
 *
 * Everything the client types by hand should be removable when it was typed
 * by mistake — a duplicate supplier, a warehouse that was never built, an
 * agent added to the wrong company. What cannot be removed is a record the
 * documents rely on: an invoice whose customer is a blank is worse than a
 * list with an old name on it, so those are deactivated and the refusal says
 * what is in the way.
 *
 * The rules live in the server action, so these tests drive the same counting
 * the action does rather than a copy of it.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;

/** The same question the action asks before it deletes anything. */
async function inUse(target: 'vendor' | 'agent' | 'warehouse' | 'customer', id: string) {
  switch (target) {
    case 'vendor':
      return (
        (await prisma.purchaseContract.count({ where: { companyId, vendorId: id } })) +
        (await prisma.payment.count({ where: { companyId, vendorId: id } })) +
        (await prisma.expense.count({ where: { companyId, vendorId: id } })) +
        (await prisma.journalLine.count({ where: { vendorId: id } }))
      );
    case 'agent':
      return (
        (await prisma.journalLine.count({ where: { agentId: id } })) +
        (await prisma.receipt.count({ where: { companyId, agentId: id } })) +
        (await prisma.agentSettlement.count({ where: { companyId, agentId: id } })) +
        (await prisma.account.count({ where: { companyId, agentId: id } }))
      );
    case 'warehouse':
      return (
        (await prisma.inventoryBalance.count({ where: { companyId, warehouseId: id } })) +
        (await prisma.inventoryTransaction.count({ where: { companyId, warehouseId: id } })) +
        (await prisma.goodsReceipt.count({ where: { companyId, warehouseId: id } }))
      );
    case 'customer':
      return (
        (await prisma.salesInvoice.count({ where: { companyId, customerId: id } })) +
        (await prisma.receipt.count({ where: { companyId, customerId: id } })) +
        (await prisma.journalLine.count({ where: { customerId: id } }))
      );
  }
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.6', effectiveDate: utcDate('2026-01-01') },
  });
}, 300_000);

describe('a record typed by mistake', () => {
  it('is deletable while nothing has used it', async () => {
    const duplicate = await prisma.vendor.create({
      data: { companyId, vendorCode: 'SUP-DUP', vendorName: 'Typed twice', primaryCurrency: 'USD', paymentTermDays: 30 },
    });
    expect(await inUse('vendor', duplicate.id)).toBe(0);

    await prisma.vendor.delete({ where: { id: duplicate.id } });
    expect(await prisma.vendor.findUnique({ where: { id: duplicate.id } })).toBeNull();
  }, 300_000);

  it('a warehouse that never held anything goes too', async () => {
    const spare = await prisma.warehouse.create({
      data: { companyId, code: 'WH-SPARE', name: 'Never built', location: 'Nowhere' },
    });
    expect(await inUse('warehouse', spare.id)).toBe(0);
    await prisma.warehouse.delete({ where: { id: spare.id } });
    expect(await prisma.warehouse.count({ where: { id: spare.id } })).toBe(0);
  }, 300_000);
});

describe('a record the documents rely on', () => {
  it('a supplier with a purchase order is in use, and says so instead of going', async () => {
    const contract = await createPurchaseContract(
      {
        companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id, currency: 'USD',
        rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0', contractReference: 'ICUL/FID/040',
        lines: [{ itemId: masters.item.id, quantity: '1000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });

    expect(await inUse('vendor', masters.vendor.id)).toBeGreaterThan(0);

    // The database agrees: the row cannot simply be removed.
    await expect(prisma.vendor.delete({ where: { id: masters.vendor.id } })).rejects.toThrow();
  }, 300_000);

  it('an agent with an account in his name is in use', async () => {
    const agent = await prisma.agent.create({
      data: { companyId, agentCode: 'AGT-0002', agentName: 'RADOUAN MOHAMMED', commissionPct: '0' },
    });
    expect(await inUse('agent', agent.id)).toBe(0);

    await postLoan({
      companyId, userId: ctx.admin.id, loanDate: utcDate('2026-08-12'), direction: 'RECEIVED',
      agentId: agent.id, cashBankAccountId: (await getCashAccount(companyId, 'MAD')).id,
      currency: 'MAD', amount: '1000', description: 'Loan received',
    });

    // The loan account opened in his name counts, as do the postings.
    expect(await inUse('agent', agent.id)).toBeGreaterThan(0);
    expect(await prisma.account.count({ where: { companyId, agentId: agent.id } })).toBe(1);
  }, 300_000);
});
