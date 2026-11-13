import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { getPayables } from '@/lib/services/receivables';
import { getTrialBalanceReport } from '@/lib/services/reports';
import { getCashBankBalance } from '@/lib/services/accounting';
import { postSupplierEntry, previewSupplierEntry, localDifference } from '@/lib/services/supplier-payment-entry';
import { dec } from '@/lib/money';

/**
 * Money leaves a Moroccan bank in dirhams; the supplier is settled in dollars.
 *
 *   MAD 2,100 out of the MAD bank  →  USD 200 to the supplier, at 10.50
 *
 * A. against an order booked at 10.00: the payable falls by USD 200 at its
 *    booked MAD 2,000, and the MAD 100 more that left the bank is a realised
 *    exchange loss.
 * B. with no invoice: USD 200 is the supplier's advance, at MAD 2,100.
 *
 * Either way the MAD bank falls by exactly 2,100, no other drawer moves, and
 * the entry balances in MAD.
 */
let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let vendorId: string;
let contractId: string;
let madBankGl: string;

const base = () => ({
  companyId,
  entryDate: utcDate('2026-11-10'),
  description: 'MAD bank to supplier in USD',
  vendorId,
  bankAccountId: madBankGl,
  bankCurrency: 'MAD',
  bankAmount: '2100',
  supplierCurrency: 'USD',
  supplierAmount: '200',
  rateToUsd: '10.5',
  rateLocalPerUsd: '10.5',
});

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId);
  vendorId = masters.vendor.id;
  const contract = await createPurchaseContract(
    {
      companyId, contractDate: utcDate('2026-10-01'), vendorId, currency: 'USD', rateToUsd: '1', rateLocalPerUsd: '10',
      freightAmount: '0', contractReference: 'ICUL/FX/1',
      lines: [{ itemId: masters.item.id, quantity: '1000', unit: 'KG', unitPrice: '1.00', bagWeightKg: '60', lotNumber: 'FX-LOT' }],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  contractId = contract.id;
  const madBank = await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId, currency: 'MAD', accountType: 'BANK' } });
  madBankGl = madBank.glAccountId;
}, 300_000);

const owed = async () => (await getPayables({ companyId, vendorId, onlyOutstanding: false })).find((p) => p.contractId === contractId)!;
const drawers = async () =>
  Promise.all(
    (await prisma.cashBankAccount.findMany({ where: { companyId: { in: [ctx.morocco.id, ctx.dubai.id] } }, select: { id: true, name: true, companyId: true } })).map(
      async (d) => ({ ...d, balance: (await getCashBankBalance(prisma as never, d.companyId, d.id)).toFixed(2) }),
    ),
  );

describe('MAD bank → supplier in USD', () => {
  it('A. settles the order: payable down USD 200 at its booked rate, bank down MAD 2,100, the difference an exchange loss', async () => {
    const input = { ...base(), settles: { kind: 'DOCUMENT' as const, purchaseContractId: contractId } };
    const before = await drawers();
    const preview = await previewSupplierEntry(input, ctx.admin.id);
    // The preview wrote nothing.
    expect(await prisma.payment.count({ where: { companyId } })).toBe(0);
    expect(localDifference(preview).toFixed(2)).toBe('0.00');

    await postSupplierEntry(input, ctx.admin.id);
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId, sourceType: 'PAYMENT' },
      include: { lines: { include: { account: { select: { systemKey: true, name: true } } } } },
    });
    const by = (key: string) => entry.lines.filter((l) => l.account.systemKey === key);
    const ap = by('ACCOUNTS_PAYABLE');
    expect(ap).toHaveLength(1);
    expect(dec(ap[0].debit).toFixed(2)).toBe('200.00');
    expect(ap[0].currency).toBe('USD');
    // Cleared at the order's booked MAD 10.00.
    expect(dec(ap[0].debitLocal).toFixed(2)).toBe('2000.00');
    const bank = entry.lines.filter((l) => l.cashBankAccountId);
    expect(bank).toHaveLength(1);
    expect(bank[0].currency).toBe('MAD');
    expect(dec(bank[0].credit).toFixed(2)).toBe('2100.00');
    expect(dec(bank[0].creditLocal).toFixed(2)).toBe('2100.00');
    // MAD 100 more left than the debt was booked at: a realised loss.
    const fx = by('FX_GAIN_LOSS');
    expect(fx.reduce((t, l) => t.plus(l.debitLocal).minus(l.creditLocal), dec(0)).toFixed(2)).toBe('100.00');
    // Balanced in MAD, and the preview was the same entry.
    const dr = entry.lines.reduce((t, l) => t.plus(l.debitLocal), dec(0));
    const cr = entry.lines.reduce((t, l) => t.plus(l.creditLocal), dec(0));
    expect(dr.toFixed(2)).toBe(cr.toFixed(2));
    expect(preview.map((l) => `${l.direction}:${l.amountLocal}`).sort()).toEqual(
      entry.lines.map((l) => (dec(l.debitLocal).greaterThan(0) || dec(l.debit).greaterThan(0) ? `DEBIT:${dec(l.debitLocal).toFixed(2)}` : `CREDIT:${dec(l.creditLocal).toFixed(2)}`)).sort(),
    );

    // The order: USD 1,000 owed, now USD 800.
    expect((await owed()).outstandingAmount.toFixed(2)).toBe('800.00');
    // Only the MAD bank moved, by exactly 2,100; nothing in Dubai.
    const after = await drawers();
    for (const d of after) {
      const was = before.find((b) => b.id === d.id)!;
      const moved = dec(d.balance).minus(was.balance).toFixed(2);
      expect(moved, d.name).toBe(d.id === bank[0].cashBankAccountId ? '-2100.00' : '0.00');
    }
    const tb = await getTrialBalanceReport({ companyId, to: utcDate('2026-12-31') });
    expect(tb.totals.debitLocal.toFixed(2)).toBe(tb.totals.creditLocal.toFixed(2));
  }, 120_000);

  it('B. with no invoice it is an advance: supplier advances up USD 200 (MAD 2,100), the order untouched', async () => {
    const owedBefore = (await owed()).outstandingAmount.toFixed(2);
    await postSupplierEntry({ ...base(), description: 'Advance to supplier', settles: { kind: 'ADVANCE' } }, ctx.admin.id);
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId, sourceType: 'PAYMENT', description: { contains: '' } },
      orderBy: { createdAt: 'desc' },
      include: { lines: { include: { account: { select: { systemKey: true } } } } },
    });
    const adv = entry.lines.filter((l) => l.account.systemKey === 'SUPPLIER_ADVANCES');
    expect(adv).toHaveLength(1);
    expect(dec(adv[0].debitUsd).toFixed(2)).toBe('200.00');
    expect(dec(adv[0].debitLocal).toFixed(2)).toBe('2100.00');
    expect(entry.lines.some((l) => l.account.systemKey === 'ACCOUNTS_PAYABLE')).toBe(false);
    expect(entry.lines.some((l) => l.account.systemKey === 'FX_GAIN_LOSS')).toBe(false);
    expect((await owed()).outstandingAmount.toFixed(2)).toBe(owedBefore);
  }, 120_000);

  it('refuses a settlement in a currency the order is not owed in, and an order of another supplier', async () => {
    await expect(postSupplierEntry({ ...base(), supplierCurrency: 'MAD', supplierAmount: '2100', settles: { kind: 'DOCUMENT', purchaseContractId: contractId } }, ctx.admin.id)).rejects.toThrow(/owed in USD/);
    const other = await createMasters(companyId);
    await expect(postSupplierEntry({ ...base(), vendorId: other.vendor.id, settles: { kind: 'DOCUMENT', purchaseContractId: contractId } }, ctx.admin.id)).rejects.toThrow(/not open for this supplier/);
  }, 120_000);

  it('cannot pay a Moroccan supplier from a Dubai bank', async () => {
    const dubaiBank = await prisma.cashBankAccount.findFirstOrThrow({ where: { companyId: ctx.dubai.id, currency: 'USD' } });
    await expect(
      postSupplierEntry({ ...base(), bankAccountId: dubaiBank.glAccountId, bankCurrency: 'USD', bankAmount: '200', rateToUsd: '1', settles: { kind: 'ADVANCE' } }, ctx.admin.id),
    ).rejects.toThrow(/cash or bank account/);
  }, 120_000);
});
