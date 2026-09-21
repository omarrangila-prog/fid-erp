import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt, getInvoiceOutstanding } from '@/lib/services/receipt';
import { getCustomerLedger } from '@/lib/services/ledger';
import { getCashBankBalance } from '@/lib/services/accounting';
import { reconcile } from '@/lib/services/reconciliation';
import { transaction } from '@/lib/db';
import { dec, toMoney } from '@/lib/money';

/**
 * Invoice 15, as it happened on the client's books.
 *
 *   Invoice to BANI    MAD 126,000
 *   Cash received      MAD  80,000
 *   Still owed         MAD  46,000 — to be paid later by a cheque via an agent
 *
 * Record Payment opened with both "Amount received" and the allocation at the
 * full MAD 126,000. The allocation was lowered to the MAD 80,000 paid; the
 * amount was not. The receipt then put MAD 126,000 into Cash in Hand and
 * booked MAD 46,000 as a customer advance nobody paid — and the customer's
 * ledger read zero while the invoice still said MAD 46,000 was due.
 *
 * An outstanding balance is not a payment. The system must wait for the user
 * to record one.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let invoiceId: string;
let agentId: string;

async function control(systemKey: string) {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return toMoney(rows[0]?.bal ?? 0);
}

async function cash() {
  const account = await getCashAccount(companyId, 'MAD');
  return dec(await transaction((tx) => getCashBankBalance(tx, companyId, account.id)));
}

async function customerBalance() {
  const ledger = await getCustomerLedger({
    companyId, customerId: masters.customer.id, view: 'TRANSACTION', localCurrency: 'MAD', partyCurrency: 'MAD',
  });
  return ledger.closingBalance;
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  agentId = (await prisma.agent.create({ data: { companyId, agentCode: 'AG-15', agentName: 'Mohammed', commissionPct: '0' } })).id;

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
      lines: [{ batchId: batch.id, quantityKg: '5000', lotNumber: 'LOT-15' }],
    },
    ctx.admin.id,
  );
  await postGoodsReceipt({ id: grn.id, companyId, userId: ctx.admin.id });

  // MAD 126,000: 2,100 KG at 60.
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
}, 300_000);

describe('Invoice 15 — MAD 80,000 cash on a MAD 126,000 invoice', () => {
  it('refuses the receipt as it was entered: MAD 126,000 received, MAD 80,000 applied', async () => {
    const account = await getCashAccount(companyId, 'MAD');
    await expect(
      createReceipt(
        {
          companyId, receiptDate: utcDate('2026-09-18'), customerId: masters.customer.id, currency: 'MAD',
          amount: '126000', rateToUsd: '9.6', rateLocalPerUsd: '9.6', paymentMethod: 'CASH', cashBankAccountId: account.id,
          allocations: [{ salesInvoiceId: invoiceId, amount: '80000' }],
        },
        ctx.admin.id,
      ),
    ).rejects.toThrow(/only MAD 80000\.00 applied/);
    // Nothing was written.
    expect(await prisma.receipt.count({ where: { companyId } })).toBe(0);
    expect(Number(await control('CUSTOMER_ADVANCES'))).toBe(0);
  }, 300_000);

  it('records the MAD 80,000 actually received, and leaves MAD 46,000 owed everywhere', async () => {
    const cashBefore = await cash();
    const account = await getCashAccount(companyId, 'MAD');
    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-09-18'), customerId: masters.customer.id, currency: 'MAD',
        amount: '80000', rateToUsd: '9.6', rateLocalPerUsd: '9.6', paymentMethod: 'CASH', cashBankAccountId: account.id,
        reference: 'CASH RECVD BY MOHAMMED', allocations: [{ salesInvoiceId: invoiceId, amount: '80000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, invoiceId));
    expect(outstanding.amount.toString()).toBe('46000');
    expect(Number(await customerBalance())).toBeCloseTo(46000, 2);
    expect(Number((await cash()).minus(cashBefore))).toBeCloseTo(80000, 2);
    // No advance, no agent clearing, no cheque: nothing the user did not enter.
    expect(Number(await control('CUSTOMER_ADVANCES'))).toBe(0);
    expect(Number(await control('AGENT_CLEARING'))).toBe(0);
    expect(await prisma.cheque.count({ where: { companyId } })).toBe(0);
    expect(await prisma.receipt.count({ where: { companyId } })).toBe(1);

    const check = await reconcile(companyId);
    expect(check.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);

  it('only when the cheque is recorded through the agent does the customer owe nothing', async () => {
    const cashBefore = await cash();
    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-09-25'), customerId: masters.customer.id, currency: 'MAD',
        amount: '46000', rateToUsd: '9.85', rateLocalPerUsd: '9.85', paymentMethod: 'AGENT_COLLECTION', agentId,
        cheque: { chequeNumber: 'CHQ-15', chequeDate: utcDate('2026-09-30'), bankName: 'Attijariwafa Bank' },
        allocations: [{ salesInvoiceId: invoiceId, amount: '46000' }],
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });

    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, invoiceId));
    expect(outstanding.amount.toString()).toBe('0');
    expect(Number(await customerBalance())).toBeCloseTo(0, 2);
    // FID's cash does not move; the agent now owes FID the cheque.
    expect(Number((await cash()).minus(cashBefore))).toBe(0);
    expect(Number(await control('AGENT_CLEARING'))).toBeCloseTo(46000, 2);
    expect(Number(await control('CUSTOMER_ADVANCES'))).toBe(0);
  }, 300_000);

  it('still lets a genuine advance be kept — when the user says so', async () => {
    const account = await getCashAccount(companyId, 'MAD');
    const receipt = await createReceipt(
      {
        companyId, receiptDate: utcDate('2026-09-26'), customerId: masters.customer.id, currency: 'MAD',
        amount: '5000', rateToUsd: '9.85', rateLocalPerUsd: '9.85', paymentMethod: 'CASH', cashBankAccountId: account.id,
        keepRemainderAsAdvance: true,
      },
      ctx.admin.id,
    );
    await postReceipt({ id: receipt.id, companyId, userId: ctx.admin.id });
    expect(Number(await control('CUSTOMER_ADVANCES'))).toBeCloseTo(-5000, 2);
  }, 300_000);
});
