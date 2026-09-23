import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, createMasters, getCashAccount, utcDate } from '../helpers';
import { deletePostedEntry } from '@/lib/services/document-lifecycle';
import { postLoan } from '@/lib/services/loan';
import { postCashBankTransfer } from '@/lib/services/cash-transfer';
import { postJournalEntry, getCashBankBalance } from '@/lib/services/accounting';
import { recordAgentHandover } from '@/lib/services/agent-ledger';
import { getAgentLedger } from '@/lib/services/agent-account';
import { getCashBook, getGeneralLedger } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';
import { getCompanyContext } from '@/lib/services/company';
import { transaction } from '@/lib/db';
import { dec } from '@/lib/money';

/**
 * Anything that has been posted can be taken back out, from wherever it is
 * read.
 *
 * A loan, money moved between the company's own accounts, a hand-raised
 * voucher and an agent's settlement had no way to be deleted at all: the
 * screens that wrote them offered no way to unwrite them. Each of those is
 * now deletable, and "deleted" means the same thing every time — the entry
 * is mirrored, it disappears from every ledger and total, and both it and
 * its reversal stay in the journal so the correction can be read.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let cashId: string;
let bankId: string;
let agentId: string;

async function cash(id = cashId) {
  return dec(await transaction((tx) => getCashBankBalance(tx, companyId, id)));
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({
    data: { companyId, quoteCurrency: 'MAD', rate: '9.6', effectiveDate: utcDate('2026-01-01') },
  });
  cashId = (await getCashAccount(companyId, 'MAD')).id;
  bankId = (await getCashAccount(companyId, 'USD')).id;
  agentId = (
    await prisma.agent.create({
      data: { companyId, agentCode: 'AGT-0001', agentName: 'RADOUAN MOHAMMED', commissionPct: '0' },
    })
  ).id;
}, 300_000);

describe('a loan somebody made the company', () => {
  it('can be deleted, and the cash goes back', async () => {
    const before = await cash();
    const loan = await postLoan({
      companyId, userId: ctx.admin.id, loanDate: utcDate('2026-08-12'), direction: 'RECEIVED',
      agentId, cashBankAccountId: cashId, currency: 'MAD', amount: '27000',
      description: 'Loan received from RADOUAN MOHAMMED',
    });
    expect(Number((await cash()).minus(before))).toBeCloseTo(27000, 2);

    await deletePostedEntry({
      companyId, userId: ctx.admin.id, entryId: loan.entry.id,
      reason: 'Entered against the wrong person',
    });

    expect(Number((await cash()).minus(before))).toBeCloseTo(0, 2);

    // Gone from his ledger, and from the cash book.
    const { rows, summary } = await getAgentLedger({ companyId, agentId });
    expect(rows.filter((r) => r.accountKind === 'Loan from agent')).toHaveLength(0);
    expect(Number(summary.loanFromAgentLocal)).toBeCloseTo(0, 2);

    const book = await getCashBook({ companyId, cashBankAccountId: cashId });
    expect(book.rows.some((r) => /loan received/i.test(r.memo ?? ''))).toBe(false);
  }, 300_000);

  it('leaves the entry and its reversal in the journal, where they can be read', async () => {
    const entries = await prisma.journalEntry.findMany({
      where: { companyId, sourceType: 'MANUAL' },
      select: { isReversal: true, description: true },
    });
    expect(entries.some((e) => /loan received from radouan/i.test(e.description))).toBe(true);
    expect(entries.some((e) => e.isReversal && /wrong person/i.test(e.description))).toBe(true);
  }, 300_000);

  it('refuses to be deleted twice', async () => {
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId, isReversal: false, reversedBy: { isNot: null } },
      select: { id: true },
    });
    await expect(
      deletePostedEntry({ companyId, userId: ctx.admin.id, entryId: entry.id, reason: 'Again' }),
    ).rejects.toThrow(/already been deleted/i);
  }, 300_000);

  it('refuses to delete a reversal, which would put back what it took out', async () => {
    const reversal = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId, isReversal: true },
      select: { id: true },
    });
    await expect(
      deletePostedEntry({ companyId, userId: ctx.admin.id, entryId: reversal.id, reason: 'Undo the undo' }),
    ).rejects.toThrow(/itself the reversal/i);
  }, 300_000);

  it('asks why', async () => {
    const loan = await postLoan({
      companyId, userId: ctx.admin.id, loanDate: utcDate('2026-08-20'), direction: 'RECEIVED',
      agentId, cashBankAccountId: cashId, currency: 'MAD', amount: '1000',
      description: 'Another loan',
    });
    await expect(
      deletePostedEntry({ companyId, userId: ctx.admin.id, entryId: loan.entry.id, reason: '  ' }),
    ).rejects.toThrow(/say why/i);
    await deletePostedEntry({ companyId, userId: ctx.admin.id, entryId: loan.entry.id, reason: 'Tidying up' });
  }, 300_000);
});

describe('money moved between the company’s own accounts', () => {
  it('can be deleted, and both accounts go back', async () => {
    const cashBefore = await cash();
    const bankBefore = await cash(bankId);

    const transfer = await postCashBankTransfer({
      companyId, userId: ctx.admin.id, transferDate: utcDate('2026-08-15'),
      fromAccountId: bankId, toAccountId: cashId, amount: '1000', receivedAmount: '9600',
      description: 'Cash drawn for the office',
    });

    expect(Number((await cash(bankId)).minus(bankBefore))).toBeCloseTo(-1000, 2);

    await deletePostedEntry({
      companyId, userId: ctx.admin.id, entryId: transfer.id, reason: 'Never happened',
    });

    expect(Number((await cash(bankId)).minus(bankBefore))).toBeCloseTo(0, 2);
    expect(Number((await cash()).minus(cashBefore))).toBeCloseTo(0, 2);
  }, 300_000);
});

describe('a hand-raised journal voucher', () => {
  it('can be deleted from the journal, and leaves the account it touched', async () => {
    const company = await transaction((tx) => getCompanyContext(tx, companyId));
    const expense = await prisma.account.findFirstOrThrow({
      where: { companyId, type: 'EXPENSE' },
      select: { id: true },
    });

    const entry = await transaction((tx) =>
      postJournalEntry(tx, {
        companyId,
        entryDate: utcDate('2026-08-18'),
        description: 'Office sundries, paid in cash',
        sourceType: 'MANUAL',
        sourceId: `jv-test-${Date.now()}`,
        createdById: ctx.admin.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: '9.6',
        lines: [
          { accountId: expense.id, direction: 'DEBIT', currency: 'MAD', amount: '500', rateToUsd: '9.6' },
          { cashBankAccountId: cashId, direction: 'CREDIT', currency: 'MAD', amount: '500', rateToUsd: '9.6' },
        ],
      }),
    );

    const withIt = await getGeneralLedger({ companyId, accountId: expense.id });
    expect(withIt.rows.some((r) => /sundries/i.test(r.description))).toBe(true);

    await deletePostedEntry({ companyId, userId: ctx.admin.id, entryId: entry.id, reason: 'Posted twice' });

    const without = await getGeneralLedger({ companyId, accountId: expense.id });
    expect(without.rows.some((r) => /sundries/i.test(r.description))).toBe(false);
  }, 300_000);
});

describe('an agent settlement', () => {
  it('can be deleted, and he is holding the money again', async () => {
    // He is holding nothing yet, so this hand-over is all his own money.
    const handover = await recordAgentHandover({
      companyId, userId: ctx.admin.id, agentId, settlementDate: utcDate('2026-09-05'),
      cashBankAccountId: cashId, currency: 'MAD', amount: '5000',
      rateToUsd: '9.6', rateLocalPerUsd: '9.6', excess: 'LOAN',
      notes: 'His own money, lent to the company',
    });
    expect(handover.loanEntryId).toBeTruthy();

    const before = await getAgentLedger({ companyId, agentId });
    expect(Number(before.summary.loanFromAgentLocal)).toBeCloseTo(5000, 2);

    await deletePostedEntry({
      companyId, userId: ctx.admin.id, entryId: handover.loanEntryId!, reason: 'He took it back',
    });

    const after = await getAgentLedger({ companyId, agentId });
    expect(Number(after.summary.loanFromAgentLocal)).toBeCloseTo(0, 2);
  }, 300_000);

  it('leaves the books whole after everything that was deleted', async () => {
    const check = await reconcile(companyId);
    expect(check.checks.filter((c) => !c.passed)).toEqual([]);
  }, 300_000);
});
