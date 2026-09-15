import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { quickCreateAgent } from '@/lib/services/agent';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { getReceivables } from '@/lib/services/receivables';
import { getCashBankBalance } from '@/lib/services/accounting';
import { getAgentPositions } from '@/lib/services/agent-ledger';
import { ConflictError } from '@/lib/errors';
import { dec, toMoney } from '@/lib/money';
import { agentSchema, warehouseSchema } from '@/lib/validation/masters';

describe('master codes may be left blank', () => {
  it('accepts an agent with only a name', () => {
    const result = agentSchema.safeParse({
      agentName: 'Ridwan',
      email: '',
      status: 'ACTIVE',
    });
    expect(result.success, result.success ? '' : JSON.stringify(result.error.flatten())).toBe(true);
  });

  it('accepts a warehouse with only a name', () => {
    const result = warehouseSchema.safeParse({
      name: 'Ridwan Warehouse',
      status: 'ACTIVE',
    });
    expect(result.success, result.success ? '' : JSON.stringify(result.error.flatten())).toBe(true);
  });
});

describe('quickCreateAgent', () => {
  let ctx: Awaited<ReturnType<typeof getContext>>;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await getContext();
  });

  it('creates an agent that can collect a receipt immediately', async () => {
    const created = await quickCreateAgent({
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      agentName: 'Ridwan',
      phone: '0612345678',
      notes: 'Collects customer cheques in Morocco',
    });

    expect(created.agentName).toBe('Ridwan');
    expect(created.agentCode).toMatch(/^AGT-/);
    expect(created.phone).toBe('0612345678');
  });

  it('refuses a name that is already an agent', async () => {
    await expect(
      quickCreateAgent({
        companyId: ctx.morocco.id,
        userId: ctx.admin.id,
        agentName: 'ridwan',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('issues a distinct code for a second agent', async () => {
    const second = await quickCreateAgent({
      companyId: ctx.morocco.id,
      userId: ctx.admin.id,
      agentName: 'Karim',
    });
    expect(second.agentCode).toMatch(/^AGT-/);
    expect(second.agentName).toBe('Karim');
  });
});

describe('an agent-collection receipt after quick-create', () => {
  it('settles the customer without touching FID cash or bank', async () => {
    const ctx = await getContext();
    const companyId = ctx.morocco.id;
    const masters = await createMasters(companyId, { currency: 'MAD' });
    const agent = await prisma.agent.findFirstOrThrow({
      where: { companyId, agentName: 'Ridwan' },
    });

    const contract = await createPurchaseContract(
      {
        companyId,
        contractDate: utcDate('2026-08-01'),
        vendorId: masters.vendor.id,
        currency: 'USD',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        freightAmount: '0',
        lines: [{ itemId: masters.item.id, quantity: '20000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
      },
      ctx.admin.id,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });

    const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
    const goods = await createGoodsReceipt(
      {
        companyId,
        purchaseContractId: contract.id,
        warehouseId: masters.warehouses[0].id,
        receiptDate: utcDate('2026-08-15'),
        receivedById: ctx.admin.id,
        lines: [{ batchId: batch.id, quantityKg: '20000', lotNumber: 'AGT-Q-1' }],
      },
      ctx.admin.id,
    );
    await postGoodsReceipt({ id: goods.id, companyId, userId: ctx.admin.id });

    const sold = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-09-01'),
        dueDate: utcDate('2026-10-01'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        lines: [
          {
            batchId: sold.id,
            warehouseId: masters.warehouses[0].id,
            quantity: '5000',
            unit: 'KG',
            unitPrice: '70.00',
          },
        ],
      },
      ctx.admin.id,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-09-03'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '120000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'AGENT_COLLECTION',
        agentId: agent.id,
        reference: 'Cheque 4412',
        allocations: [{ salesInvoiceId: invoice.id, amount: '120000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const postedInvoice = await prisma.salesInvoice.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { totalAmount: true },
    });
    const expectedOutstanding = Number(postedInvoice.totalAmount) - 120_000;

    const rows = await getReceivables({ companyId, onlyOutstanding: true });
    const open = rows.find((r) => r.invoiceId === invoice.id);
    expect(Number(open?.outstandingAmount ?? 0)).toBeCloseTo(expectedOutstanding, 2);

    const cash = await getCashAccount(companyId, 'MAD');
    expect(dec(await getCashBankBalance(prisma as never, companyId, cash.id)).toString()).toBe('0');

    const clearing = await prisma.$queryRaw<Array<{ bal: string }>>`
      SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS bal
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      JOIN accounts a ON a."id" = jl."accountId"
      WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = 'AGENT_CLEARING'`;
    expect(Number(toMoney(clearing[0]?.bal ?? 0))).toBeCloseTo(120_000 / 9.85, 2);

    const positions = await getAgentPositions(companyId, agent.id);
    expect(positions[0]?.agentName).toBe('Ridwan');
    expect(Number(positions[0]?.holdingUsd ?? 0)).toBeCloseTo(120_000 / 9.85, 2);
  });
});
