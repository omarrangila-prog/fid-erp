import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate, receiveEverything } from '../helpers';
import { transaction } from '@/lib/db';
import { createExpenseIn, postExpenseIn } from '@/lib/services/expense';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { reconcile } from '@/lib/services/reconciliation';
import { toMoney } from '@/lib/money';

/**
 * One payment, several cost categories.
 *
 * MAD 20,000 handed over at the port is port charges, labour and
 * documentation. Each line becomes an expense of its own — the categories are
 * treated differently, so one record could not be capitalised and expensed at
 * once — but they are written together, and the cash must fall by the total
 * exactly once.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let shipmentId: string;
let cashId: string;

async function categoryId(companyId: string, code: string) {
  const found = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId, code } });
  return found.id;
}

/** Cash balance in the drawer's own currency, straight from the journal. */
async function cashBalance(accountId: string) {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE jl."cashBankAccountId" = ${accountId} AND je."status" = 'POSTED'`;
  return toMoney(rows[0]?.bal ?? 0);
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  const masters = await createMasters(ctx.morocco.id, { currency: 'MAD' });

  const contract = await createPurchaseContract(
    {
      companyId: ctx.morocco.id,
      contractReference: 'SPLIT-1',
      contractDate: utcDate('2026-02-01'),
      vendorId: masters.vendor.id,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      freightAmount: '0',
      lines: [
        {
          itemId: masters.item.id,
          quantity: '18000',
          unit: 'KG',
          unitPrice: '2.5',
          bagWeightKg: '60',
        },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { purchaseContractId: contract.id } });
  shipmentId = shipment.id;
  await receiveEverything({
    companyId: ctx.morocco.id,
    purchaseContractId: contract.id,
    warehouseId: masters.warehouse.id,
    userId: ctx.admin.id,
    receiptDate: utcDate('2026-02-15'),
  });

  cashId = (await getCashAccount(ctx.morocco.id, 'MAD')).id;
}, 180_000);

describe('a payment split across categories', () => {
  it('writes one expense per category and takes the total out of cash once', async () => {
    const before = await cashBalance(cashId);

    const lines = [
      { code: 'CLEARING', amount: '10000' },
      { code: 'LABOUR', amount: '5000' },
      { code: 'DOCUMENTATION', amount: '5000' },
    ];

    const ids = await transaction(async (tx) => {
      const created: string[] = [];
      for (const line of lines) {
        const expense = await createExpenseIn(
          tx,
          {
            companyId: ctx.morocco.id,
            expenseDate: utcDate('2026-02-20'),
            expenseCategoryId: await categoryId(ctx.morocco.id, line.code),
            shipmentId,
            currency: 'MAD',
            amount: line.amount,
            rateToUsd: '9.85',
            rateLocalPerUsd: '9.85',
            paymentMethod: 'CASH',
            cashBankAccountId: cashId,
            kind: 'SHIPMENT',
            reference: 'PORT-2026-02-20',
          },
          ctx.admin.id,
        );
        await postExpenseIn(tx, { id: expense.id, companyId: ctx.morocco.id, userId: ctx.admin.id });
        created.push(expense.id);
      }
      return created;
    }, 120_000);

    expect(ids).toHaveLength(3);

    // Three vouchers, one reference, one total out of the drawer.
    const written = await prisma.expense.findMany({
      where: { id: { in: ids } },
      select: { reference: true, amount: true, status: true },
    });
    expect(written.every((e) => e.status === 'POSTED')).toBe(true);
    expect(new Set(written.map((e) => e.reference))).toEqual(new Set(['PORT-2026-02-20']));

    const after = await cashBalance(cashId);
    expect(toMoney(before.minus(after)).toString()).toBe('20000');

    const health = await reconcile(ctx.morocco.id);
    expect(health.healthy, health.checks.filter((c) => !c.passed).map((c) => c.label).join('; ')).toBe(true);
  }, 180_000);

  it('lands whole or not at all when one line is wrong', async () => {
    const before = await cashBalance(cashId);
    const good = await categoryId(ctx.morocco.id, 'CLEARING');

    await expect(
      transaction(async (tx) => {
        const first = await createExpenseIn(
          tx,
          {
            companyId: ctx.morocco.id,
            expenseDate: utcDate('2026-02-21'),
            expenseCategoryId: good,
            shipmentId,
            currency: 'MAD',
            amount: '3000',
            rateToUsd: '9.85',
            rateLocalPerUsd: '9.85',
            paymentMethod: 'CASH',
            cashBankAccountId: cashId,
            kind: 'SHIPMENT',
            reference: 'PORT-FAIL',
          },
          ctx.admin.id,
        );
        await postExpenseIn(tx, { id: first.id, companyId: ctx.morocco.id, userId: ctx.admin.id });

        // A category that does not belong to this company: the split must not
        // leave the first line standing on its own.
        await createExpenseIn(
          tx,
          {
            companyId: ctx.morocco.id,
            expenseDate: utcDate('2026-02-21'),
            expenseCategoryId: 'cixxxxxxxxxxxxxxxxxxxxxxx',
            shipmentId,
            currency: 'MAD',
            amount: '2000',
            rateToUsd: '9.85',
            rateLocalPerUsd: '9.85',
            paymentMethod: 'CASH',
            cashBankAccountId: cashId,
            kind: 'SHIPMENT',
            reference: 'PORT-FAIL',
          },
          ctx.admin.id,
        );
      }, 120_000),
    ).rejects.toThrow();

    // Nothing of the failed split survives, and the drawer never moved.
    const orphans = await prisma.expense.count({ where: { reference: 'PORT-FAIL' } });
    expect(orphans).toBe(0);
    expect((await cashBalance(cashId)).toString()).toBe(before.toString());

    const health = await reconcile(ctx.morocco.id);
    expect(health.healthy).toBe(true);
  }, 180_000);
});
