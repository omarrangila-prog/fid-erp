import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { getLedgerDirectory } from '@/lib/services/ledger-directory';
import { postLoan } from '@/lib/services/loan';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';

/**
 * One man, one row.
 *
 * He collects the company's money, lends it money and buys coffee from it.
 * That is an Agent Clearing balance, a loan account and a trade receivable —
 * three accounts, because they are three different things on the balance
 * sheet, and one person. The list the client opens shows him once; the
 * accountant's view shows the accounts as they really are.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let agentId: string;

async function directory() {
  return getLedgerDirectory(companyId, 'MAD');
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.6', effectiveDate: utcDate('2026-01-01') },
  });
  const cashId = (await getCashAccount(companyId, 'MAD')).id;

  agentId = (
    await prisma.agent.create({
      data: { companyId, agentCode: 'AGT-0001', agentName: 'RADOUAN MOHAMMED', commissionPct: '0' },
    })
  ).id;
  await prisma.customer.create({
    data: {
      companyId, customerCode: 'CUS-RAD', customerName: 'RADOUAN MOHAMMED',
      primaryCurrency: 'MAD', paymentTermDays: 30, agentId,
    },
  });

  // He lends the company money: an account is opened in his name.
  await postLoan({
    companyId, userId: ctx.admin.id, loanDate: utcDate('2026-08-12'), direction: 'RECEIVED',
    agentId, cashBankAccountId: cashId, currency: 'MAD', amount: '27000',
    description: 'Loan received from RADOUAN MOHAMMED',
  });

  // And he holds a customer's cheque for the company.
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-08-01'), vendorId: masters.vendor.id, currency: 'USD',
      rateToUsd: '1', rateLocalPerUsd: '9.6', freightAmount: '0', contractReference: 'ICUL/FID/030',
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
      lines: [{ batchId: batch.id, quantityKg: '5000', lotNumber: 'LOT-DIR' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  const invoice = await createSalesInvoice(
    {
      companyId, invoiceDate: utcDate('2026-09-01'), customerId: masters.customer.id, currency: 'MAD',
      rateToUsd: '9.6', rateLocalPerUsd: '9.6',
      lines: [{ batchId: batch.id, warehouseId: masters.warehouses[0].id, quantity: '1000', unit: 'KG' as const, unitPrice: '46.00' }],
    },
    ctx.admin.id,
  );
  await postSalesInvoice({ id: invoice.id, companyId, userId: ctx.admin.id });

  const receipt = await createReceipt(
    {
      companyId, receiptDate: utcDate('2026-09-15'), customerId: masters.customer.id, currency: 'MAD',
      amount: '46000', rateToUsd: '9.6', rateLocalPerUsd: '9.6',
      paymentMethod: 'AGENT_COLLECTION', agentId,
      description: 'Customer cheque collected by RADOUAN MOHAMMED',
      allocations: [{ salesInvoiceId: invoice.id, amount: '46000' }],
    },
    ctx.admin.id,
  );
  await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });
}, 300_000);

describe('the general ledgers list', () => {
  it('carries the party once, with his own accounts underneath rather than beside him', async () => {
    const entries = await directory();
    const party = entries.find((e) => e.key === `agent:${agentId}`);
    expect(party).toBeDefined();
    expect(party?.name).toBe('RADOUAN MOHAMMED');

    const names = party?.children?.map((c) => c.name) ?? [];
    expect(names).toContain('Loan from RADOUAN MOHAMMED');
    expect(names).toContain('RADOUAN MOHAMMED');

    // Those same rows are not offered as separate ledgers in the simple list.
    const loan = entries.find((e) => e.name === 'Loan from RADOUAN MOHAMMED' && e.key.startsWith('account:'));
    expect(loan?.advancedOnly).toBe(true);
  }, 300_000);

  it('says what he owes and what he is owed in words, not in debits', async () => {
    const party = (await directory()).find((e) => e.key === `agent:${agentId}`);
    const summary = Object.fromEntries((party?.summary ?? []).map((s) => [s.label, s.value]));
    expect(summary['RADOUAN owes FID']).toBe('MAD 46,000.00');
    expect(summary['FID owes RADOUAN']).toBe('MAD 27,000.00');
    expect(summary['Net position']).toBe('MAD 19,000.00 receivable');
  }, 300_000);

  it('keeps the net as a reading: both accounts are still there to be opened', async () => {
    const entries = await directory();
    const loan = entries.find((e) => e.name === 'Loan from RADOUAN MOHAMMED' && e.key.startsWith('account:'));
    // The liability still stands at its own value, unoffset.
    expect(Number(loan?.balance)).toBeCloseTo(27000, 2);
    expect(loan?.href).toMatch(/general-ledger/);
  }, 300_000);

  it('is grouped by who the account belongs to, not by the words in its name', async () => {
    const account = await prisma.account.findFirstOrThrow({
      where: { companyId, name: 'Loan from RADOUAN MOHAMMED' },
      select: { id: true, agentId: true },
    });
    expect(account.agentId).toBe(agentId);

    // Correcting the spelling must not scatter his accounts again.
    await prisma.account.update({ where: { id: account.id }, data: { name: 'Loan from Radouan M.' } });
    const party = (await directory()).find((e) => e.key === `agent:${agentId}`);
    expect(party?.children?.some((c) => c.name === 'Loan from Radouan M.')).toBe(true);
    await prisma.account.update({ where: { id: account.id }, data: { name: 'Loan from RADOUAN MOHAMMED' } });
  }, 300_000);
});
