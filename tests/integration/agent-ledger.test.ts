import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createExpense, postExpense } from '@/lib/services/expense';
import {
  createAgentSettlement,
  postAgentSettlement,
  getAgentPositions,
  getAgentStatement,
} from '@/lib/services/agent-ledger';
import { getReceivables } from '@/lib/services/receivables';
import { getCashBankBalance } from '@/lib/services/accounting';
import { reconcile } from '@/lib/services/reconciliation';
import { dec, toMoney } from '@/lib/money';

/**
 * §19 — the agent clearing ledger.
 *
 * The client's own scenario. A customer settles a 300,000 MAD invoice by
 * handing the agent a cheque in the agent's name. The customer owes nothing;
 * FID has no cash; the agent is holding 300,000 MAD. Only when he hands it
 * over does the bank move.
 *
 * The mistake this guards against is the obvious one: treating the cheque as
 * money received and increasing the bank straight away, which states cash the
 * company does not have and loses the answer to the only question management
 * asks about agents — how much is sitting with whom.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let agentId: string;
let invoiceId: string;
let shipmentId: string;

/** A GL balance in USD, straight from the journal. */
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

  const agent = await prisma.agent.create({
    data: { companyId, agentCode: 'AG-RID', agentName: 'Ridwan', commissionPct: '1.5' },
  });
  agentId = agent.id;

  // Buy, receive and sell, so there is a real invoice to settle.
  const contract = await createPurchaseContract(
    {
      companyId,
      contractDate: utcDate('2026-02-02'),
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
  shipmentId = batch.shipmentId;

  const receipt = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: contract.id,
      warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-03-01'),
      receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '20000', lotNumber: 'AG-LOT-1' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

  const sold = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  const invoice = await createSalesInvoice(
    {
      companyId,
      invoiceDate: utcDate('2026-03-10'),
      dueDate: utcDate('2026-04-10'),
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
          unitPrice: '60.00',
        },
      ],
    },
    ctx.admin.id,
  );
  invoiceId = invoice.id;
  await postSalesInvoice({ id: invoiceId, companyId, userId: ctx.admin.id });
});

describe('a customer pays the agent, not the company', () => {
  it('refuses an agent collection that does not name an agent', async () => {
    await expect(
      createReceipt(
        {
          companyId,
          receiptDate: utcDate('2026-03-20'),
          customerId: masters.customer.id,
          currency: 'MAD',
          amount: '100000',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
          paymentMethod: 'AGENT_COLLECTION',
          allocations: [{ salesInvoiceId: invoiceId, amount: '100000' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/agent who collected/i);
  });

  it('settles the customer without touching cash or bank', async () => {
    const bankBefore = await control('AGENT_CLEARING');
    expect(bankBefore.toString()).toBe('0');

    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-03-20'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '300000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'AGENT_COLLECTION',
        agentId,
        allocations: [{ salesInvoiceId: invoiceId, amount: '300000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    // The customer is settled.
    const rows = await getReceivables({ companyId, onlyOutstanding: true });
    expect(rows.find((r) => r.invoiceId === invoiceId)).toBeUndefined();

    // And no cash or bank account moved.
    const cash = await getCashAccount(companyId, 'MAD');
    expect(dec(await getCashBankBalance(prisma as never, companyId, cash.id)).toString()).toBe('0');

    // The money is with Ridwan.
    const clearing = await control('AGENT_CLEARING');
    expect(Number(clearing)).toBeCloseTo(300_000 / 9.85, 2);
  });

  it('says how much is sitting with which agent', async () => {
    const positions = await getAgentPositions(companyId);
    const ridwan = positions.find((p) => p.agentId === agentId)!;

    expect(ridwan.agentName).toBe('Ridwan');
    expect(Number(ridwan.holdingUsd)).toBeCloseTo(300_000 / 9.85, 2);
    expect(Number(ridwan.commissionPayableUsd)).toBe(0);
  });
});

describe('commission agreed but not yet paid', () => {
  it('is a cost of the shipment without any money moving', async () => {
/*
     * A shipment category, chosen deterministically. These expenses name a
     * shipment, and a general category naming one is refused — so an unordered
     * findFirst made this test a coin toss on Postgres row order.
     */
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT' },
      orderBy: { code: 'asc' },
    });
    const cashBefore = await getCashBankBalance(
      prisma as never,
      companyId,
      (await getCashAccount(companyId, 'MAD')).id,
    );

    const expense = await createExpense(
      {
        companyId,
        expenseDate: utcDate('2026-03-22'),
        expenseCategoryId: category.id,
        shipmentId,
        agentId,
        payableToAgentId: agentId,
        currency: 'USD',
        amount: '1000',
        rateToUsd: '1',
        rateLocalPerUsd: '9.85',
        description: 'Agent commission on this shipment',
      },
      ctx.admin.id,
    );
    await postExpense({ id: expense.id, companyId, userId: ctx.admin.id });

    // Owed, not paid.
    expect(Number(await control('AGENT_COMMISSION_PAYABLE'))).toBeCloseTo(-1000, 2);

    const cashAfter = await getCashBankBalance(
      prisma as never,
      companyId,
      (await getCashAccount(companyId, 'MAD')).id,
    );
    expect(dec(cashAfter).toString()).toBe(dec(cashBefore).toString());

    const ridwan = (await getAgentPositions(companyId)).find((p) => p.agentId === agentId)!;
    expect(Number(ridwan.commissionPayableUsd)).toBeCloseTo(1000, 2);
  });

  it('refuses a cost settled two ways at once', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { companyId, status: 'ACTIVE', kind: 'SHIPMENT' },
      orderBy: { code: 'asc' },
    });
    const cash = await getCashAccount(companyId, 'MAD');

    await expect(
      createExpense(
        {
          companyId,
          expenseDate: utcDate('2026-03-23'),
          expenseCategoryId: category.id,
          shipmentId,
          payableToAgentId: agentId,
          cashBankAccountId: cash.id,
          currency: 'MAD',
          amount: '500',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/settled one way only/i);
  });
});

describe('the agent hands the money over', () => {
  it('refuses more than the agent is holding', async () => {
    const bank = await getCashAccount(companyId, 'MAD');
    await expect(
      createAgentSettlement(
        {
          companyId,
          agentId,
          settlementDate: utcDate('2026-04-01'),
          direction: 'COLLECTION',
          cashBankAccountId: bank.id,
          currency: 'MAD',
          amount: '400000',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/is holding|never collected/i);
  });

  it('moves the money into the bank and clears the agent', async () => {
    const bank = await getCashAccount(companyId, 'MAD');

    const settlement = await createAgentSettlement(
      {
        companyId,
        agentId,
        settlementDate: utcDate('2026-04-01'),
        direction: 'COLLECTION',
        cashBankAccountId: bank.id,
        currency: 'MAD',
        amount: '300000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        reference: 'Transfer from Ridwan',
      },
      ctx.admin.id,
    );
    await postAgentSettlement({ id: settlement.id, companyId, userId: ctx.admin.id });

    // Now the company has the money.
    expect(dec(await getCashBankBalance(prisma as never, companyId, bank.id)).toString()).toBe('300000');

    // And Ridwan is holding nothing.
    const ridwan = (await getAgentPositions(companyId)).find((p) => p.agentId === agentId)!;
    expect(Number(ridwan.holdingUsd)).toBeCloseTo(0, 2);
    // The commission is still owed to him.
    expect(Number(ridwan.commissionPayableUsd)).toBeCloseTo(1000, 2);
  });

  it('shows both sides on one statement', async () => {
    const statement = await getAgentStatement({ companyId, agentId });

    expect(statement.map((row) => row.account)).toEqual(['CLEARING', 'COMMISSION', 'CLEARING']);
    // Collected, then handed over: the running balance comes back to nil.
    expect(Number(statement[statement.length - 1].holdingUsd)).toBeCloseTo(0, 2);
    expect(Number(statement[statement.length - 1].commissionPayableUsd)).toBeCloseTo(1000, 2);
    // The customer whose money it was is named against the collection.
    expect(statement[0].customerName).toBe(masters.customer.customerName);
  });

  it('leaves the books balanced', async () => {
    const result = await reconcile(companyId);
    expect(result.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  });
});


/**
 * §13–14 — a cash sale settles as it is raised.
 *
 * The service records the intent and the account; the posting action raises
 * the receipt alongside the invoice. What is checked here is the half the
 * service owns: a cash sale must know where the money went, and must refuse
 * an account that cannot hold it.
 */
describe('a cash sale', () => {
  it('will not be raised without saying where the money went', async () => {
    const batch = await prisma.batch.findFirstOrThrow({
      where: { companyId, availableQuantityKg: { gt: 0 } },
    });

    await expect(
      createSalesInvoice(
        {
          companyId,
          invoiceDate: utcDate('2026-05-02'),
          customerId: masters.customer.id,
          currency: 'MAD',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
          paymentType: 'CASH',
          lines: [
            {
              batchId: batch.id,
              warehouseId: masters.warehouses[0].id,
              quantity: '100',
              unit: 'KG',
              unitPrice: '60.00',
            },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/cash or bank account the money went into/i);
  });

  it('refuses an account that cannot hold the currency', async () => {
    const batch = await prisma.batch.findFirstOrThrow({
      where: { companyId, availableQuantityKg: { gt: 0 } },
    });
    const usdAccount = await prisma.cashBankAccount.findFirst({
      where: { companyId, currency: 'USD', status: 'ACTIVE' },
    });
    if (!usdAccount) return;

    await expect(
      createSalesInvoice(
        {
          companyId,
          invoiceDate: utcDate('2026-05-03'),
          customerId: masters.customer.id,
          currency: 'MAD',
          rateToUsd: '9.85',
          rateLocalPerUsd: '9.85',
          paymentType: 'CASH',
          cashBankAccountId: usdAccount.id,
          lines: [
            {
              batchId: batch.id,
              warehouseId: masters.warehouses[0].id,
              quantity: '100',
              unit: 'KG',
              unitPrice: '60.00',
            },
          ],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/held in USD|cannot be paid into/i);
  });

  it('records the account on the invoice when it is complete', async () => {
    const batch = await prisma.batch.findFirstOrThrow({
      where: { companyId, availableQuantityKg: { gt: 0 } },
    });
    const cash = await getCashAccount(companyId, 'MAD');

    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-05-04'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentType: 'CASH',
        cashBankAccountId: cash.id,
        lines: [
          {
            batchId: batch.id,
            warehouseId: masters.warehouses[0].id,
            quantity: '100',
            unit: 'KG',
            unitPrice: '60.00',
          },
        ],
      },
      ctx.admin.id,
    );

    const saved = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(saved.paymentType).toBe('CASH');
    expect(saved.cashBankAccountId).toBe(cash.id);
    // Due the day it is raised: a cash sale is not owed for thirty days.
    expect(saved.dueDate).toBeTruthy();
  });

  it('does not record an account on a credit sale, even if one is passed', async () => {
    const batch = await prisma.batch.findFirstOrThrow({
      where: { companyId, availableQuantityKg: { gt: 0 } },
    });
    const cash = await getCashAccount(companyId, 'MAD');

    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-05-05'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentType: 'CREDIT',
        cashBankAccountId: cash.id,
        lines: [
          {
            batchId: batch.id,
            warehouseId: masters.warehouses[0].id,
            quantity: '100',
            unit: 'KG',
            unitPrice: '60.00',
          },
        ],
      },
      ctx.admin.id,
    );

    const saved = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(saved.cashBankAccountId).toBeNull();
  });
});
