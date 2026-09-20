import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, transaction, utcDate } from '../helpers';
import { ensureChartOfAccounts } from '@/lib/services/chart-of-accounts';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { getBalanceSheet } from '@/lib/services/reports';

/**
 * §6 of the client's checklist: the balance sheet must be able to carry
 * every head it names — deposits, prepayments, fixed assets, other
 * liabilities, share capital, owner's current account, reserves — grouped
 * as current or fixed, current or long-term, and still balance.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;

const REQUIRED = [
  ['Prepayments', 'ASSET', 'Current assets'],
  ['Deposits Paid', 'ASSET', 'Current assets'],
  ['Other Receivables & Advances', 'ASSET', 'Current assets'],
  ['Advances to Suppliers', 'ASSET', 'Current assets'],
  ['Fixed Assets — Cost', 'ASSET', 'Fixed assets'],
  ['Accumulated Depreciation', 'ASSET', 'Fixed assets'],
  ['Other Assets', 'ASSET', 'Fixed assets'],
  ['Accounts Payable', 'LIABILITY', 'Current liabilities'],
  ['Accrued Expenses', 'LIABILITY', 'Current liabilities'],
  ['Other Payables', 'LIABILITY', 'Current liabilities'],
  ['Related Party Balances', 'LIABILITY', 'Current liabilities'],
  ['Customer Advances', 'LIABILITY', 'Current liabilities'],
  ['VAT Payable (Output Tax)', 'LIABILITY', 'Current liabilities'],
  ['Long-Term Loans', 'LIABILITY', 'Long-term liabilities'],
  ['Share Capital', 'EQUITY', 'Equity'],
  ["Owner's Current Account", 'EQUITY', 'Equity'],
  ['Retained Earnings', 'EQUITY', 'Equity'],
  ['Other Reserves', 'EQUITY', 'Equity'],
] as const;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  // The chart provisioning is idempotent: running it again on a company that
  // already has one adds only what is missing.
  await transaction((tx) => ensureChartOfAccounts(tx, companyId));
}, 300_000);

describe('§6 — the balance sheet heads', () => {
  it('carries every head the requirements name, in the right group', async () => {
    const accounts = await prisma.account.findMany({ where: { companyId }, select: { id: true, name: true, type: true } });
    const missing = REQUIRED.filter(([name]) => !accounts.some((a) => a.name === name)).map(([name]) => name);
    expect(missing, `missing balance sheet heads: ${missing.join(', ')}`).toEqual([]);
  }, 300_000);

  it('groups each head where an accountant expects it, and still balances', async () => {
    // A balanced opening on every head, so each one appears on the statement.
    const accounts = await prisma.account.findMany({ where: { companyId }, select: { id: true, name: true, type: true } });
    const byName = new Map(accounts.map((a) => [a.name, a]));
    // Accumulated depreciation is an asset account with a credit balance, so
    // it goes on the credit side with the liabilities and equity.
    const debits = REQUIRED.filter(([name, type]) => type === 'ASSET' && name !== 'Accumulated Depreciation');
    const credits = REQUIRED.filter(([name, type]) => type !== 'ASSET' || name === 'Accumulated Depreciation');
    const debitEach = 3000;

    await transaction(async (tx) => {
      const company = await getCompanyContext(tx, companyId);
      return postJournalEntry(tx, {
        companyId,
        entryDate: utcDate('2026-01-01'),
        description: 'Opening position across every head',
        sourceType: 'MANUAL',
        sourceId: `JV-HEADS-${Date.now()}`,
        createdById: ctx.admin.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: '10',
        lines: [
          ...debits.map(([name]) => ({
            accountId: byName.get(name)!.id,
            direction: 'DEBIT' as const,
            currency: 'MAD',
            amount: String(debitEach),
            rateToUsd: '10',
          })),
          ...credits.map(([name], index) => ({
            accountId: byName.get(name)!.id,
            direction: 'CREDIT' as const,
            currency: 'MAD',
            // The last credit carries the balancing difference.
            amount: index === credits.length - 1 ? String(debits.length * debitEach - (credits.length - 1) * 1000) : '1000',
            rateToUsd: '10',
          })),
        ],
      });
    });

    const sheet = await getBalanceSheet({ companyId, asOf: utcDate('2026-12-31') });
    const lines = [...sheet.assets.lines, ...sheet.liabilities.lines, ...sheet.equity.lines];
    for (const [name, , group] of REQUIRED) {
      const line = lines.find((l) => l.name === name);
      expect(line, `${name} is not on the balance sheet`).toBeTruthy();
      expect(line!.group, `${name} is grouped as ${line!.group}`).toBe(group);
    }
    expect(sheet.balancesUsd).toBe(true);
    expect(Number(sheet.differenceUsd)).toBeCloseTo(0, 2);
  }, 300_000);
});
