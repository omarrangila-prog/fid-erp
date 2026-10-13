import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createPayment, postPayment } from '@/lib/services/payment';
import { dec } from '@/lib/money';

/**
 * The same trap on the supplier side as Invoice 15 was on the customer side.
 *
 * Record Payment opens with the amount and the allocation both at the
 * contract's full value. Lower the allocation to what was actually paid and
 * leave the amount alone, and the difference becomes a supplier advance
 * nobody paid: cash leaves the books that never left the drawer, and the
 * supplier appears to owe goods for money they never received.
 *
 * A receipt refuses this unless the user says the money really arrived. A
 * payment must ask the same question.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let masters: Awaited<ReturnType<typeof createMasters>>;
let companyId: string;
let cashId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  cashId = (await getCashAccount(companyId, 'USD')).id;
}, 300_000);

async function contractFor(usd: string) {
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-07-01'), vendorId: masters.vendor.id,
      currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10', freightAmount: '0',
      lines: [{ itemId: masters.item.id, quantity: '10000', unit: 'KG', unitPrice: usd, bagWeightKg: '60', lotNumber: `ADV-${usd}` }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  return contract;
}

/** Pay `paid`, but only allocate `allocated` of it to the contract. */
async function pay(contractId: string, paid: string, allocated: string) {
  const payment = await createPayment(
    {
      companyId, paymentDate: utcDate('2026-07-10'), vendorId: masters.vendor.id,
      currency: 'USD', amount: paid, rateToUsd: '1', rateLocalPerUsd: '10',
      paymentMethod: 'CASH', cashBankAccountId: cashId,
      allocations: [{ purchaseContractId: contractId, amount: allocated }],
    } as never,
    ctx.admin.id,
  );
  await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });
  return payment;
}

describe('money said to be paid but not put against anything', () => {
  it('does not invent a supplier advance out of an unallocated remainder', async () => {
    const contract = await contractFor('4.00'); // USD 40,000
    // USD 40,000 "paid", only USD 25,000 allocated. The other 15,000 was
    // never paid — it is the balance still owed, not an advance.
    await expect(pay(contract.id, '40000', '25000')).rejects.toThrow(
      /not put against costs|advance/i,
    );

    // Nothing was written: no cash left, no advance appeared.
    const cash = await prisma.$queryRaw<Array<{ usd: string }>>`
      SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId" AND je."status" = 'POSTED'
      JOIN accounts a ON a."id" = jl."accountId" AND a."systemKey" = 'SUPPLIER_ADVANCES'
      WHERE a."companyId" = ${companyId}`;
    expect(dec(cash[0]?.usd ?? 0).toFixed(2)).toBe('0.00');
  }, 120_000);

  it('takes the part payment when the amount matches what was allocated', async () => {
    const contract = await contractFor('4.50'); // USD 45,000
    // USD 25,000 paid, USD 25,000 allocated: the honest entry.
    const payment = await pay(contract.id, '25000', '25000');
    expect(payment.id).toBeTruthy();
  }, 120_000);

  it('refuses a deposit with nothing allocated unless the user says so', async () => {
    await expect(
      createPayment(
        {
          companyId, paymentDate: utcDate('2026-07-11'), vendorId: masters.vendor.id,
          currency: 'USD', amount: '5000', rateToUsd: '1', rateLocalPerUsd: '10',
          paymentMethod: 'CASH', cashBankAccountId: cashId, allocations: [],
        } as never,
        ctx.admin.id,
      ),
    ).rejects.toThrow(/not put against any cost|advance/i);
  }, 120_000);

  it('posts a real advance when the user means it', async () => {
    // Nothing to allocate against yet: the whole payment is a deposit, and
    // the user says the money really left.
    const payment = await createPayment(
      {
        companyId, paymentDate: utcDate('2026-07-11'), vendorId: masters.vendor.id,
        currency: 'USD', amount: '5000', rateToUsd: '1', rateLocalPerUsd: '10',
        paymentMethod: 'CASH', cashBankAccountId: cashId, allocations: [],
        keepRemainderAsAdvance: true,
      } as never,
      ctx.admin.id,
    );
    await postPayment({ id: payment.id, companyId, userId: ctx.admin.id });
    const advance = await prisma.$queryRaw<Array<{ usd: string }>>`
      SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId" AND je."status" = 'POSTED'
      JOIN accounts a ON a."id" = jl."accountId" AND a."systemKey" = 'SUPPLIER_ADVANCES'
      WHERE a."companyId" = ${companyId}`;
    // An advance to a supplier is an asset: a debit.
    expect(dec(advance[0]?.usd ?? 0).toFixed(2)).toBe('5000.00');
  }, 120_000);
});
