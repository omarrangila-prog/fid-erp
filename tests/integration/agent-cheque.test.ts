import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt, getInvoiceOutstanding } from '@/lib/services/receipt';
import { changeChequeStatus } from '@/lib/services/cheque';
import { createAgentSettlement, postAgentSettlement, getAgentPositions } from '@/lib/services/agent-ledger';
import { getCashBankBalance } from '@/lib/services/accounting';
import { reconcile } from '@/lib/services/reconciliation';
import { transaction } from '@/lib/db';
import { dec, toMoney } from '@/lib/money';

/**
 * The client's own daily flow: an invoice settled part in cash, part by a
 * cheque the agent takes away.
 *
 *   Invoice          MAD 200,000
 *   Cash             MAD  50,000   → cash goes up by 50,000, and only that
 *   Cheque to agent  MAD 150,000   → the customer owes nothing; Ridwan owes us
 *
 * The cheque is a real instrument with a number, a date and a bank, and it can
 * clear or bounce. Clearing it changes nothing about our position — it cleared
 * in his hands, and he still owes us. Bouncing it takes the money back off him
 * and puts the debt back on the customer.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let agentId: string;
let invoiceId: string;

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

async function cashBalance() {
  const cash = await getCashAccount(companyId, 'MAD');
  return dec(await transaction((tx) => getCashBankBalance(tx, companyId, cash.id)));
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });

  const agent = await prisma.agent.create({
    data: { companyId, agentCode: 'AG-CHQ', agentName: 'Ridwan', commissionPct: '1.5' },
  });
  agentId = agent.id;

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
  const grn = await createGoodsReceipt(
    {
      companyId,
      purchaseContractId: contract.id,
      warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-03-01'),
      receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '20000', lotNumber: 'CHQ-LOT-1' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  // MAD 200,000: 4,000 KG at 50.
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
          batchId: batch.id,
          warehouseId: masters.warehouses[0].id,
          quantity: '4000',
          unit: 'KG',
          unitPrice: '50.00',
        },
      ],
    },
    ctx.admin.id,
  );
  invoiceId = invoice.id;
  await postSalesInvoice({ id: invoiceId, companyId, userId: ctx.admin.id });
}, 300_000);

describe('the first payment: MAD 50,000 in cash', () => {
  it('leaves the invoice partly paid and the rest still owed', async () => {
    const cash = await getCashAccount(companyId, 'MAD');
    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-03-20'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '50000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'CASH',
        cashBankAccountId: cash.id,
        allocations: [{ salesInvoiceId: invoiceId, amount: '50000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, invoiceId));
    expect(outstanding.amount.toString()).toBe('150000');
    expect((await cashBalance()).toString()).toBe('50000');
  }, 180_000);
});

describe('the second payment: a MAD 150,000 cheque the agent takes away', () => {
  let chequeId: string;

  it('settles the customer in full without any money reaching us', async () => {
    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-03-21'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '150000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'AGENT_COLLECTION',
        agentId,
        cheque: {
          chequeNumber: 'CHQ-889900',
          // Dated three days out: a future-dated cheque is still a collection.
          chequeDate: utcDate('2026-03-24'),
          bankName: 'Attijariwafa Bank',
          notes: 'Handed to Ridwan at the warehouse',
        },
        allocations: [{ salesInvoiceId: invoiceId, amount: '150000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    // The customer owes nothing.
    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, invoiceId));
    expect(outstanding.amount.toString()).toBe('0');

    // Cash rose by the 50,000 that was actually paid in cash, and no more.
    expect((await cashBalance()).toString()).toBe('50000');

    // Ridwan is holding 150,000.
    expect(Number(await control('AGENT_CLEARING'))).toBeCloseTo(150_000 / 9.85, 2);
  }, 180_000);

  it('records the cheque itself, with its number, date and bank', async () => {
    const cheque = await prisma.cheque.findFirstOrThrow({
      where: { companyId, chequeNumber: 'CHQ-889900' },
    });
    chequeId = cheque.id;

    expect(cheque.status).toBe('RECEIVED');
    expect(cheque.agentId).toBe(agentId);
    expect(cheque.customerId).toBe(masters.customer.id);
    expect(cheque.bankName).toBe('Attijariwafa Bank');
    expect(cheque.amount.toString()).toBe('150000');
    // No bank of ours stands behind it: the money comes when Ridwan settles.
    expect(cheque.cashBankAccountId).toBeNull();
  }, 120_000);

  it('clearing it puts nothing in our bank — he still owes us', async () => {
    const cashBefore = await cashBalance();
    const owedBefore = await control('AGENT_CLEARING');

    await changeChequeStatus({
      chequeId,
      companyId,
      userId: ctx.admin.id,
      toStatus: 'CLEARED',
      effectiveDate: utcDate('2026-03-24'),
    });

    expect((await prisma.cheque.findUniqueOrThrow({ where: { id: chequeId } })).status).toBe('CLEARED');
    expect((await cashBalance()).toString()).toBe(cashBefore.toString());
    expect((await control('AGENT_CLEARING')).toString()).toBe(owedBefore.toString());
  }, 180_000);

  it('does not demand a bank account to clear a cheque we never held', async () => {
    // The old rule refused to clear without naming the bank it cleared
    // through. There is no such bank: it cleared into the agent's account.
    const cheque = await prisma.cheque.findUniqueOrThrow({ where: { id: chequeId } });
    expect(cheque.cashBankAccountId).toBeNull();
    expect(cheque.status).toBe('CLEARED');
  }, 120_000);

  it('leaves the books balanced', async () => {
    const health = await reconcile(companyId);
    expect(health.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);
});

describe('the agent hands the money over', () => {
  it('moves it into cash and clears what he owed', async () => {
    const owed = await control('AGENT_CLEARING');
    expect(Number(owed)).toBeCloseTo(150_000 / 9.85, 2);

    const cash = await getCashAccount(companyId, 'MAD');
    const settlement = await createAgentSettlement(
      {
        companyId,
        agentId,
        settlementDate: utcDate('2026-04-01'),
        currency: 'MAD',
        amount: '150000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        cashBankAccountId: cash.id,
        direction: 'COLLECTION',
      },
      ctx.admin.id,
    );
    await postAgentSettlement({ id: settlement.id, companyId, userId: ctx.admin.id });

    expect((await cashBalance()).toString()).toBe('200000');
    expect(Number(await control('AGENT_CLEARING'))).toBeCloseTo(0, 2);

    const positions = await getAgentPositions(companyId);
    const ridwan = positions.find((p) => p.agentId === agentId)!;
    expect(Number(ridwan.holdingUsd)).toBeCloseTo(0, 2);
  }, 300_000);
});

describe('a second invoice, whose agent cheque bounces', () => {
  let secondInvoiceId: string;
  let chequeId: string;

  it('is settled by an agent cheque like any other', async () => {
    const batch = await prisma.batch.findFirstOrThrow({ where: { companyId } });
    const invoice = await createSalesInvoice(
      {
        companyId,
        invoiceDate: utcDate('2026-05-01'),
        dueDate: utcDate('2026-06-01'),
        customerId: masters.customer.id,
        currency: 'MAD',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        lines: [
          {
            batchId: batch.id,
            warehouseId: masters.warehouses[0].id,
            quantity: '2000',
            unit: 'KG',
            unitPrice: '50.00',
          },
        ],
      },
      ctx.admin.id,
    );
    secondInvoiceId = invoice.id;
    await postSalesInvoice({ id: secondInvoiceId, companyId, userId: ctx.admin.id });

    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-05-05'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '100000',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'AGENT_COLLECTION',
        agentId,
        cheque: {
          chequeNumber: 'CHQ-991111',
          chequeDate: utcDate('2026-05-08'),
          bankName: 'Banque Populaire',
        },
        allocations: [{ salesInvoiceId: secondInvoiceId, amount: '100000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, secondInvoiceId));
    expect(outstanding.amount.toString()).toBe('0');

    chequeId = (await prisma.cheque.findFirstOrThrow({ where: { companyId, chequeNumber: 'CHQ-991111' } })).id;
    expect(Number(await control('AGENT_CLEARING'))).toBeCloseTo(100_000 / 9.85, 2);
  }, 300_000);

  it('takes the money back off the agent and puts the debt back on the customer', async () => {
    const cashBefore = await cashBalance();

    await changeChequeStatus({
      chequeId,
      companyId,
      userId: ctx.admin.id,
      toStatus: 'BOUNCED',
      effectiveDate: utcDate('2026-05-12'),
      reason: 'Returned unpaid — insufficient funds',
    });

    // Off the agent.
    expect(Number(await control('AGENT_CLEARING'))).toBeCloseTo(0, 2);

    // Back on the customer.
    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, secondInvoiceId));
    expect(outstanding.amount.toString()).toBe('100000');

    // A bounce is not a cost, and it is not a cash movement.
    expect((await cashBalance()).toString()).toBe(cashBefore.toString());
  }, 300_000);

  it('keeps the cheque on the record rather than deleting it', async () => {
    const cheque = await prisma.cheque.findUniqueOrThrow({
      where: { id: chequeId },
      include: { statusHistory: true },
    });

    expect(cheque.status).toBe('BOUNCED');
    expect(cheque.chequeNumber).toBe('CHQ-991111');
    expect(cheque.agentId).toBe(agentId);

    // Who said so, when, and why.
    const bounce = cheque.statusHistory.find((h) => h.toStatus === 'BOUNCED');
    expect(bounce).toBeDefined();
    expect(bounce?.notes).toMatch(/insufficient funds/i);
    expect(bounce?.changedById).toBe(ctx.admin.id);
    expect(bounce?.fromStatus).toBe('RECEIVED');
    expect(bounce?.changedAt).toBeInstanceOf(Date);
  }, 120_000);

  it('leaves the books balanced after the bounce', async () => {
    const health = await reconcile(companyId);
    expect(health.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);
});

describe('a cheque whose bank we were never told', () => {
  it('is recorded even when the drawee bank is not known', async () => {
    // What reaches us is often a number and a date. Refusing the cheque for
    // want of a bank name meant recording no cheque at all.
    const receipt = await createReceipt(
      {
        companyId,
        receiptDate: utcDate('2026-03-22'),
        customerId: masters.customer.id,
        currency: 'MAD',
        amount: '1',
        rateToUsd: '9.85',
        rateLocalPerUsd: '9.85',
        paymentMethod: 'AGENT_COLLECTION',
        agentId,
        cheque: { chequeNumber: 'CHQ-NOBANK', chequeDate: utcDate('2026-03-25') },
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const cheque = await prisma.cheque.findFirstOrThrow({
      where: { companyId, chequeNumber: 'CHQ-NOBANK' },
    });
    expect(cheque.bankName).toBeNull();
    expect(cheque.status).toBe('RECEIVED');
  }, 180_000);
});
