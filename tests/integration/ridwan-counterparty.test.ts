import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt, getInvoiceOutstanding } from '@/lib/services/receipt';
import { createAgentSettlement, postAgentSettlement } from '@/lib/services/agent-ledger';
import { getAgentLedger, getAgentSummaries, getAgentControlTotals } from '@/lib/services/agent-account';
import { getCustomerLedger } from '@/lib/services/ledger';
import { getGeneralLedger, getBalanceSheet } from '@/lib/services/reports';
import { postJournalEntry, getCashBankBalance } from '@/lib/services/accounting';
import { postLoan } from '@/lib/services/loan';
import { reconcile } from '@/lib/services/reconciliation';
import { transaction } from '@/lib/db';
import { dec } from '@/lib/money';

/**
 * Ridwan Mohammad — one counterparty, several accounts, counted once.
 *
 * A customer gives him a cheque for MAD 46,000 against their invoice. The
 * customer has paid; FID has not received the money; Ridwan owes it. That is
 * one posting: Dr Agent Clearing / Cr the customer. It shows on the Agent
 * Clearing account and again under Ridwan's name, because the agents are the
 * subledger of that account — so the balance sheet must carry 46,000, never
 * 92,000.
 *
 * He also lends the company money on 12 August and is repaid, which belongs
 * on the balance sheet in his own loan account and on his ledger, in the
 * currency it was struck in.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let agentId: string;
let invoiceId: string;
let cashId: string;

async function cash() {
  return dec(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)));
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '9.6', effectiveDate: utcDate('2026-01-01') } });
  cashId = (await getCashAccount(companyId, 'MAD')).id;
  agentId = (await prisma.agent.create({ data: { companyId, agentCode: 'AGT-0001', agentName: 'Ridwan Mohammad', commissionPct: '0' } })).id;

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0', contractReference: 'ICUL/FID/002',
      lines: [{ itemId: masters.item.id, quantity: '5000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  const grn = await createGoodsReceipt(
    {
      companyId, purchaseContractId: contract.id, warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-08-10'), receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '5000', lotNumber: 'LOT-RID' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-09-10'), customerId: masters.customer.id, currency: 'MAD',
      rateToUsd: '9.6', rateLocalPerUsd: '9.6',
      lines: [{ batchId: batch.id, warehouseId: masters.warehouses[0].id, quantity: '766.67', unit: 'KG' as const, unitPrice: '60.00' }],
    },
    ctx.admin.id,
  );
  invoiceId = invoice.id;
  await postSalesInvoice({ id: invoiceId, companyId, userId: ctx.admin.id });
}, 300_000);

describe('a customer cheque held by Ridwan', () => {
  it('settles the customer, leaves cash alone, and makes Ridwan owe the company', async () => {
    const cashBefore = await cash();
    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, invoiceId));

    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-09-15'), customerId: masters.customer.id, currency: 'MAD',
        amount: outstanding.amount.toString(), rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        paymentMethod: 'AGENT_COLLECTION', agentId,
        description: 'Customer cheque collected by Ridwan Mohammad',
        allocations: [{ salesInvoiceId: invoiceId, amount: outstanding.amount.toString() }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    // The customer has paid; the company's cash has not moved.
    expect(Number((await transaction((tx) => getInvoiceOutstanding(tx, invoiceId))).amount)).toBe(0);
    expect(Number((await cash()).minus(cashBefore))).toBe(0);

    // One posting on the clearing account, in MAD, naming the agent.
    const lines = await prisma.journalLine.findMany({
      where: { journalEntry: { companyId, status: 'POSTED' }, account: { systemKey: 'AGENT_CLEARING' } },
      select: { currency: true, debit: true, debitLocal: true, agentId: true },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].currency).toBe('MAD');
    expect(lines[0].agentId).toBe(agentId);
    expect(Number(lines[0].debit)).toBeCloseTo(Number(outstanding.amount), 2);
  }, 300_000);

  it('is counted once: the agents explain the control account, they do not add to it', async () => {
    const control = await getAgentControlTotals(companyId);
    const agents = await getAgentSummaries(companyId);
    const held = agents.reduce((total, a) => total.plus(a.summary.holdingLocal), dec(0));

    // Subledger = control, and nothing is left unexplained.
    expect(control.clearingTaggedLocal.toString()).toBe(held.toString());
    expect(control.clearingLocal.toString()).toBe(held.toString());
    expect(control.untaggedLocal.toString()).toBe('0');

    // The balance sheet carries it once — the agent is not a second asset.
    const sheet = await getBalanceSheet({ companyId, asOf: utcDate('2026-12-31') });
    const clearing = sheet.assets.lines.filter((l) => /agent clearing/i.test(l.name));
    expect(clearing).toHaveLength(1);
    expect(sheet.assets.lines.some((l) => /ridwan/i.test(l.name))).toBe(false);
    expect(sheet.balancesUsd).toBe(true);
  }, 300_000);

  it('reads in MAD on the clearing ledger, with USD only as the equivalent', async () => {
    const account = await prisma.account.findFirstOrThrow({ where: { companyId, systemKey: 'AGENT_CLEARING' } });
    // No currency asked for: the account holds only dirhams, so it opens in dirhams.
    const ledger = await getGeneralLedger({ companyId, accountId: account.id });
    expect(ledger.viewCurrency).toBe('MAD');
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].currency).toBe('MAD');
    expect(Number(ledger.rows[0].debit)).toBeCloseTo(46000, 0);

    const { rows } = await getAgentLedger({ companyId, agentId });
    expect(rows[0].currency).toBe('MAD');
    expect(rows[0].accountKind).toBe('Agent Clearing');
    expect(rows[0].typeLabel).toBe('Customer Payment Collected');
    expect(Number(rows[0].usd)).toBeCloseTo(Number(rows[0].debitLocal) / 9.6, 1);
  }, 300_000);

  it('when Ridwan hands the money over, cash rises and his balance clears — with no second customer payment', async () => {
    const cashBefore = await cash();
    const { rows: before } = await getAgentLedger({ companyId, agentId });
    const owed = before[before.length - 1].balanceLocal;

    const settlement = await createAgentSettlement(
      {
        companyId, agentId, settlementDate: utcDate('2026-09-20'), direction: 'COLLECTION',
        cashBankAccountId: cashId, currency: 'MAD', amount: owed.toString(), rateToUsd: '9.6', rateLocalPerUsd: '9.6',
        notes: 'Handed over in cash',
      },
      ctx.admin.id,
    );
    await postAgentSettlement({ id: settlement.id, companyId, userId: ctx.admin.id });

    expect(Number((await cash()).minus(cashBefore))).toBeCloseTo(Number(owed), 2);
    const summary = (await getAgentSummaries(companyId))[0].summary;
    expect(Number(summary.holdingLocal)).toBe(0);
    expect((await getAgentControlTotals(companyId)).clearingLocal.toString()).toBe('0');

    // The customer was credited once, when the cheque was handed over.
    const ledger = await getCustomerLedger({
      companyId, customerId: masters.customer.id, view: 'TRANSACTION', localCurrency: 'MAD', partyCurrency: 'MAD', currency: 'MAD',
    });
    expect(ledger.rows.filter((r) => Number(r.credit) > 0)).toHaveLength(1);
    expect(ledger.closingBalance.toString()).toBe('0');
  }, 300_000);
});

describe('the 12 August loan from Ridwan', () => {
  it('posts from the loan screen into his own account, his ledger and the balance sheet', async () => {
    const cashBefore = await cash();
    const result = await postLoan({
      companyId, userId: ctx.admin.id, loanDate: utcDate('2026-08-12'), direction: 'RECEIVED',
      agentId, cashBankAccountId: cashId, currency: 'MAD', amount: '100000',
      description: 'Loan received from Ridwan on 12 August',
    });

    expect(result.account.name).toBe('Loan from Ridwan Mohammad');
    expect(result.account.type).toBe('LIABILITY');
    expect(Number((await cash()).minus(cashBefore))).toBe(100000);

    const { rows, summary } = await getAgentLedger({ companyId, agentId });
    const loan = rows.find((r) => r.accountKind === 'Loan from agent')!;
    expect(loan.currency).toBe('MAD');
    expect(Number(loan.credit)).toBe(100000);
    expect(loan.memo).toBe('Loan received from Ridwan on 12 August');
    expect(loan.typeLabel).toBe('Loan Received from Agent');
    expect(summary.loanFromAgentLocal.toString()).toBe('100000');
    // The loan is not mixed into what he holds for the company.
    expect(summary.holdingLocal.toString()).toBe('0');

    const sheet = await getBalanceSheet({ companyId, asOf: utcDate('2026-12-31') });
    expect(sheet.liabilities.lines.some((l) => l.name === 'Loan from Ridwan Mohammad')).toBe(true);
    expect(sheet.balancesUsd).toBe(true);
  }, 300_000);

  it('a journal voucher naming Ridwan reaches his ledger without a second entry', async () => {
    const payable = await prisma.account.findFirstOrThrow({ where: { companyId, systemKey: 'AGENT_COMMISSION_PAYABLE' } });
    const expense = await prisma.account.findFirstOrThrow({ where: { companyId, type: 'EXPENSE', name: { contains: 'ommission' } } });
    const entry = await transaction((tx) =>
      postJournalEntry(tx, {
        companyId, entryDate: utcDate('2026-09-21'), description: 'Commission agreed with Ridwan',
        reference: 'JV-RIDWAN-1', sourceType: 'MANUAL', sourceId: 'jv-ridwan-commission', createdById: ctx.admin.id,
        localCurrency: 'MAD', rateLocalPerUsd: '9.6',
        lines: [
          { accountId: expense.id, direction: 'DEBIT', currency: 'MAD', amount: '2500', rateToUsd: '9.6' },
          { accountId: payable.id, direction: 'CREDIT', currency: 'MAD', amount: '2500', rateToUsd: '9.6', agentId },
        ],
      }),
    );

    const { rows, summary } = await getAgentLedger({ companyId, agentId });
    const line = rows.find((r) => r.journalEntryId === entry.id)!;
    expect(line.accountKind).toBe('Commission');
    expect(line.reference).toBe('JV-RIDWAN-1');
    expect(line.currency).toBe('MAD');
    expect(summary.commissionLocal.toString()).toBe('2500');
    // One line for one voucher — the entry is not repeated on his ledger.
    expect(rows.filter((r) => r.journalEntryId === entry.id)).toHaveLength(1);

    const check = await reconcile(companyId);
    expect(check.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);
});
