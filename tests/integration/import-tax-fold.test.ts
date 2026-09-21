import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, utcDate } from '../helpers';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { enableTax } from '@/lib/services/tax';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { foldImportTaxCorrectionIntoOrder } from '@/lib/services/import-tax-correction';
import { getTrialBalanceReport, getBalanceSheet, getJournalReport } from '@/lib/services/reports';
import { getPayables } from '@/lib/services/receivables';
import { reconcile } from '@/lib/services/reconciliation';
import { transaction } from '@/lib/db';
import { sum } from '@/lib/money';

/**
 * The client asked for FID-MA-JV-000019 — "Remove import tax from supplier
 * Ideal commodities uganda on FID-MA-PO-000001" — to go, and nothing else to
 * change. This rebuilds that situation exactly: an order posted with 20% TVA
 * on a supplier later recognised as foreign, then the manual entry taking the
 * TVA back off. Folding it must leave every figure as it was, the entry gone
 * from the journal, and the order's own posting without TVA.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let contractId: string;
let vendorId: string;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  const masters = await createMasters(companyId, { currency: 'MAD' });
  vendorId = masters.vendor.id;
  await enableTax({ companyId, userId: ctx.admin.id, registrationNumber: 'MA-TEST-TVA' });

  // Posted as if the supplier billed Moroccan TVA, the way the first order was.
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { country: true } });
  await prisma.vendor.update({ where: { id: vendorId }, data: { country: company.country } });
  const std = await prisma.taxCode.findFirstOrThrow({ where: { companyId, code: 'STD' } });
  const contract = await createPurchaseContract(
    {
      companyId,
      vendorId,
      contractDate: utcDate('2026-05-21'),
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      freightAmount: '0',
      contractReference: 'ICUL/FID/002/SCR15-12/6',
      lines: [
        { itemId: masters.item.id, quantity: '20040', unit: 'KG', unitPrice: '4.108', bagWeightKg: '60', taxCodeId: std.id },
        { itemId: masters.item.id, quantity: '21000', unit: 'KG', unitPrice: '3.998', bagWeightKg: '60', taxCodeId: std.id },
      ],
    },
    ctx.admin.id,
  );
  await postPurchaseContract({ id: contract.id, companyId, userId: ctx.admin.id });
  contractId = contract.id;

  // Then the supplier is recognised as foreign, and the TVA is taken back off — as the correction script did.
  await prisma.vendor.update({ where: { id: vendorId }, data: { country: 'uganda' } });
  const posted = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contractId } });
  await transaction(async (tx) => {
    const c = await getCompanyContext(tx, companyId);
    await postJournalEntry(tx, {
      companyId,
      entryDate: posted.contractDate,
      description: `Remove import tax from supplier Fazenda Test Exportadora on ${posted.contractNumber}`,
      sourceType: 'MANUAL',
      sourceId: `ap-import-tax-correction:${contractId}`,
      createdById: ctx.admin.id,
      localCurrency: c.localCurrency,
      rateLocalPerUsd: posted.rateLocalPerUsd,
      lines: [
        { accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE, direction: 'DEBIT', currency: 'USD', amount: posted.taxAmount, rateToUsd: '1', vendorId, purchaseContractId: contractId },
        { accountKey: ACCOUNT_KEYS.VAT_INPUT, direction: 'CREDIT', currency: 'USD', amount: posted.taxAmount, rateToUsd: '1', purchaseContractId: contractId },
      ],
    });
    await tx.purchaseContract.update({ where: { id: contractId }, data: { taxAmount: 0, taxAmountUsd: 0 } });
    await tx.purchaseContractLine.updateMany({ where: { purchaseContractId: contractId }, data: { taxAmount: 0, taxAmountUsd: 0, taxRatePct: 0, taxCodeId: null } });
  });
}, 300_000);

describe('removing the separate import-tax entry', () => {
  it('replicates the live books: 33,256.464 of TVA posted, then taken back', async () => {
    const posted = await prisma.journalEntry.findFirstOrThrow({ where: { companyId, sourceType: 'PURCHASE_CONTRACT', sourceId: contractId }, include: { lines: true } });
    expect(Number(sum(posted.lines.map((l) => l.creditUsd)))).toBeCloseTo(199538.784, 3);
    const payables = await getPayables({ companyId, onlyOutstanding: true });
    expect(Number(payables.find((p) => p.vendorId === vendorId)!.outstandingAmountUsd)).toBeCloseTo(166282.32, 2);
  }, 300_000);

  it('takes the entry off every screen and moves no figure anywhere', async () => {
    const snapshot = async () => ({
      tb: (await getTrialBalanceReport({ companyId })).totals.debitUsd.toString(),
      bs: (await getBalanceSheet({ companyId, asOf: utcDate('2026-12-31') })).assets.totalUsd.toString(),
      bsMay: (await getBalanceSheet({ companyId, asOf: utcDate('2026-05-31') })).liabilities.totalUsd.toString(),
      payable: (await getPayables({ companyId, onlyOutstanding: true })).find((p) => p.vendorId === vendorId)!.outstandingAmountUsd.toString(),
    });
    const before = await snapshot();

    const result = await transaction((tx) =>
      foldImportTaxCorrectionIntoOrder(tx, { companyId, contractId, userId: ctx.admin.id, reason: 'Removed at the client\'s request', today: utcDate('2026-09-22') }),
    );
    expect(Number(result.vat)).toBeCloseTo(33256.464, 3);

    expect(await snapshot()).toEqual(before);

    // Gone from the journal, and the order's own posting carries no TVA.
    const journal = await getJournalReport({ companyId, from: utcDate('2026-01-01'), to: utcDate('2026-12-31') });
    expect(journal.some((e) => /Remove import tax/i.test(e.description))).toBe(false);
    const live = journal.filter((e) => e.sourceType === 'PURCHASE_CONTRACT' && e.sourceId === contractId);
    expect(live).toHaveLength(1);
    const vat = await prisma.account.findFirstOrThrow({ where: { companyId, systemKey: ACCOUNT_KEYS.VAT_INPUT } });
    expect(live[0].lines.some((l) => l.accountId === vat.id)).toBe(false);
    expect(live[0].entryDate.toISOString().slice(0, 10)).toBe('2026-05-21');

    // Nothing is destroyed: both originals are still in the database, each with its reversal.
    const reversals = await prisma.journalEntry.count({ where: { companyId, isReversal: true } });
    expect(reversals).toBe(2);

    const check = await reconcile(companyId);
    expect(check.checks.filter((c) => !c.passed).map((c) => c.label)).toEqual([]);
  }, 300_000);

  it('cannot be run twice', async () => {
    await expect(
      transaction((tx) => foldImportTaxCorrectionIntoOrder(tx, { companyId, contractId, userId: ctx.admin.id, reason: 'again', today: utcDate('2026-09-22') })),
    ).rejects.toThrow();
  }, 300_000);
});
