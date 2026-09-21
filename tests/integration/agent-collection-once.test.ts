import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { getCustomerLedger } from '@/lib/services/ledger';
import { getAgentLedger, getAgentSummaries } from '@/lib/services/agent-account';
import { getLedgerDirectory } from '@/lib/services/ledger-directory';
import { getJournalForSource } from '@/lib/services/reports';
import { dec } from '@/lib/money';

/**
 * The MAD 46,000 agent collection, as it is on the client's books.
 *
 *   Invoice 15 to BANI   MAD 126,000  (rate 9.85)
 *   Cash received        MAD  80,000  (rate 9.6)
 *   Collected by agent   MAD  46,000  (rate 9.6) — RADOUAN, not yet handed over
 *
 * One receipt, one journal entry, one line on the agent. The agent ledger, the
 * agent balances, the General Ledgers directory and the customer ledger must
 * each show it once, in MAD, with USD only as an equivalent — and the
 * receipt's own journal must total in one currency at a time.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let invoiceId: string;
let agentId: string;
let collectionId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  agentId = (await prisma.agent.create({ data: { companyId, agentCode: 'AGT-0001', agentName: 'RADOUAN MOHAMMED', commissionPct: '0' } })).id;

  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.85', freightAmount: '0',
      lines: [{ itemId: masters.item.id, quantity: '5000', unit: 'KG', unitPrice: '4.00', bagWeightKg: '60' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  const batch = await prisma.batch.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  const grn = await createGoodsReceipt(
    {
      companyId, purchaseContractId: contract.id, warehouseId: masters.warehouses[0].id,
      receiptDate: utcDate('2026-09-01'), receivedById: ctx.admin.id,
      lines: [{ batchId: batch.id, quantityKg: '5000', lotNumber: 'LOT-46' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-09-10'), customerId: masters.customer.id, currency: 'MAD',
      rateToUsd: '9.85', rateLocalPerUsd: '9.85',
      lines: [{ batchId: batch.id, warehouseId: masters.warehouses[0].id, quantity: '2100', unit: 'KG' as const, unitPrice: '60.00' }],
    },
    ctx.admin.id,
  );
  invoiceId = invoice.id;
  await postSalesInvoice({ id: invoiceId, companyId, userId: ctx.admin.id });

  const account = await getCashAccount(companyId, 'MAD');
  const cash = await createReceipt(
    {
      companyId, receiptDate: utcDate('2026-09-12'), customerId: masters.customer.id, currency: 'MAD',
      amount: '80000', rateToUsd: '9.6', rateLocalPerUsd: '9.6', paymentMethod: 'CASH', cashBankAccountId: account.id,
      description: 'Cash received from BANI against INV 15',
      allocations: [{ salesInvoiceId: invoiceId, amount: '80000' }],
    },
    ctx.admin.id,
  );
  await postReceipt({ id: cash.id, companyId, userId: ctx.admin.id });

  const collection = await createReceipt(
    {
      companyId, receiptDate: utcDate('2026-09-15'), customerId: masters.customer.id, currency: 'MAD',
      amount: '46000', rateToUsd: '9.6', rateLocalPerUsd: '9.6', paymentMethod: 'AGENT_COLLECTION', agentId,
      reference: 'PAYMENT FROM BANI INV 015', description: 'Agent collection from RADOUAN MOHAMMED',
      allocations: [{ salesInvoiceId: invoiceId, amount: '46000' }],
    },
    ctx.admin.id,
  );
  collectionId = collection.id;
  await postReceipt({ id: collectionId, companyId, userId: ctx.admin.id });
}, 300_000);

describe('the MAD 46,000 agent collection appears once, in MAD', () => {
  it('is one receipt, one journal entry and one line on the agent', async () => {
    expect(await prisma.receipt.count({ where: { companyId, agentId } })).toBe(1);
    const entries = await prisma.journalEntry.count({ where: { companyId, sourceType: 'RECEIPT', sourceId: collectionId } });
    expect(entries).toBe(1);
    expect(await prisma.journalLine.count({ where: { agentId } })).toBe(1);
  }, 120_000);

  it('the agent ledger shows one MAD 46,000 line, USD only as the equivalent', async () => {
    const { rows, summary } = await getAgentLedger({ companyId, agentId });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.currency).toBe('MAD');
    expect(row.debit.toString()).toBe('46000');
    expect(row.debitLocal.toString()).toBe('46000');
    expect(Number(row.usd)).toBeCloseTo(4791.67, 2);
    expect(row.typeLabel).toBe('Customer Payment Collected');
    expect(row.customerName).toBe(masters.customer.customerName);
    expect(row.documents.map((d) => d.id)).toEqual([invoiceId]);
    expect(row.memo).toBe('Agent collection from RADOUAN MOHAMMED');
    expect(row.balanceLocal.toString()).toBe('46000');
    expect(summary.holdingLocal.toString()).toBe('46000');
    expect(summary.netLocal.toString()).toBe('46000');
    expect(Number(summary.netUsd)).toBeCloseTo(4791.67, 2);
  }, 120_000);

  it('the agent balances list it once, in MAD', async () => {
    const all = await getAgentSummaries(companyId);
    expect(all).toHaveLength(1);
    expect(all[0].summary.holdingLocal.toString()).toBe('46000');
    expect(all[0].summary.commissionLocal.toString()).toBe('0');
    expect(all[0].summary.loanFromAgentLocal.toString()).toBe('0');
  }, 120_000);

  it('General Ledgers shows the agent in MAD and keeps customers and suppliers out of the account list', async () => {
    const entries = await getLedgerDirectory(companyId, 'MAD');
    const agent = entries.find((e) => e.key === `agent:${agentId}`)!;
    expect(agent.currency).toBe('MAD');
    expect(agent.balance.toString()).toBe('46000');
    expect(Number(agent.usdEquivalent)).toBeCloseTo(4791.67, 2);
    expect(entries.filter((e) => (e.kind === 'Customer' || e.kind === 'Supplier') && !e.elsewhere)).toEqual([]);
  }, 120_000);

  it('the customer ledger names the invoice and calls both receipts part payments', async () => {
    const ledger = await getCustomerLedger({
      companyId, customerId: masters.customer.id, view: 'TRANSACTION', localCurrency: 'MAD', partyCurrency: 'MAD', currency: 'MAD',
    });
    const types = ledger.rows.map((r) => r.typeLabel);
    expect(types).toEqual(['Invoice', 'Partial Payment', 'Partial Payment']);
    for (const row of ledger.rows) expect(row.documents.map((d) => d.id)).toEqual([invoiceId]);
    expect(ledger.rows[1].memo).toBe('Cash received from BANI against INV 15');
    expect(ledger.rows[2].collectedBy).toBe('RADOUAN MOHAMMED');
    expect(ledger.rows[2].credit.toString()).toBe('46000');
    expect(ledger.closingBalance.toString()).toBe('0');
  }, 120_000);

  it('its journal balances in MAD and in USD — a USD exchange line is never added into MAD', async () => {
    const [entry] = await getJournalForSource({ companyId, sourceType: 'RECEIPT', sourceId: collectionId });
    const sum = (pick: (l: (typeof entry.lines)[number]) => unknown) =>
      entry.lines.reduce((t, l) => t.plus(dec(pick(l) as string)), dec(0));
    expect(sum((l) => l.debitLocal).toString()).toBe(sum((l) => l.creditLocal).toString());
    expect(Number(sum((l) => l.debitUsd))).toBeCloseTo(Number(sum((l) => l.creditUsd)), 2);
    // The exchange difference is booked in USD; its MAD value is nil, so the
    // MAD total stays 46,000 on each side rather than 46,121.62.
    expect(sum((l) => l.creditLocal).toString()).toBe('46000');
  }, 120_000);
});
