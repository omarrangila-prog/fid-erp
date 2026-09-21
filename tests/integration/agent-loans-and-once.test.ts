import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext, getCashAccount, createMasters, utcDate } from '../helpers';
import { transaction } from '@/lib/db';
import { postLoan } from '@/lib/services/loan';
import { getCashBankBalance } from '@/lib/services/accounting';
import { getProfitAndLoss, getTrialBalanceReport, getBalanceSheet } from '@/lib/services/reports';
import { reconcile } from '@/lib/services/reconciliation';
import { getAgentLedger } from '@/lib/services/agent-account';
import { onceForKey } from '@/lib/services/idempotency';
import { createReceipt } from '@/lib/services/receipt';
import { dec } from '@/lib/money';

/**
 * An agent lends to the company and borrows from it, and every movement lands
 * once on the agent's ledger and once on the balance sheet — never in income.
 *
 *   A  RADOUAN lends FID          MAD 100,000   Dr Cash / Cr Loan from RADOUAN
 *   B  FID repays him             MAD  40,000   Dr Loan from / Cr Cash
 *   C  FID lends him              MAD  20,000   Dr Loan to RADOUAN / Cr Cash
 *   D  he repays FID              MAD  10,000   Dr Cash / Cr Loan to
 *
 * Then: a form submitted twice with the same key creates one receipt.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;
let companyId: string;
let cashId: string;
let agentId: string;
let masters: Awaited<ReturnType<typeof createMasters>>;

async function cash() {
  return dec(await transaction((tx) => getCashBankBalance(tx, companyId, cashId)));
}

async function loan(direction: 'RECEIVED' | 'REPAID' | 'GIVEN' | 'RECOVERED', amount: string, day: string) {
  return postLoan({
    companyId,
    userId: ctx.admin.id,
    loanDate: utcDate(day),
    direction,
    agentId,
    cashBankAccountId: cashId,
    currency: 'MAD',
    amount,
    description: `${direction} ${amount}`,
  });
}

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
  companyId = ctx.morocco.id;
  masters = await createMasters(companyId, { currency: 'MAD' });
  await prisma.exchangeRate.create({ data: { companyId, quoteCurrency: 'MAD', rate: '9.6', effectiveDate: utcDate('2026-01-01') } });
  cashId = (await getCashAccount(companyId, 'MAD')).id;
  agentId = (await prisma.agent.create({ data: { companyId, agentCode: 'AGT-0001', agentName: 'RADOUAN MOHAMMED', commissionPct: '0' } })).id;
}, 240_000);

describe('agent loans, both ways', () => {
  it('A–D post to the agent’s own two loan accounts and move cash by the net', async () => {
    const before = await cash();
    const netIncomeBefore = (await getProfitAndLoss({ companyId, from: utcDate('2026-01-01'), to: utcDate('2026-12-31') })).totals.netProfitUsd;

    const a = await loan('RECEIVED', '100000', '2026-09-01');
    const b = await loan('REPAID', '40000', '2026-09-05');
    const c = await loan('GIVEN', '20000', '2026-09-08');
    const d = await loan('RECOVERED', '10000', '2026-09-12');

    expect(a.account.name).toBe('Loan from RADOUAN MOHAMMED');
    expect(a.account.type).toBe('LIABILITY');
    expect(b.account.id).toBe(a.account.id);
    expect(c.account.name).toBe('Loan to RADOUAN MOHAMMED');
    expect(c.account.type).toBe('ASSET');
    expect(d.account.id).toBe(c.account.id);

    // +100,000 − 40,000 − 20,000 + 10,000
    expect((await cash()).minus(before).toString()).toBe('50000');
    // Principal is never income or a cost.
    expect((await getProfitAndLoss({ companyId, from: utcDate('2026-01-01'), to: utcDate('2026-12-31') })).totals.netProfitUsd.toString()).toBe(netIncomeBefore.toString());
  }, 240_000);

  it('the agent ledger shows each loan once, and who owes whom', async () => {
    const { rows, summary } = await getAgentLedger({ companyId, agentId });
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.typeLabel)).toEqual([
      'Loan Received from Agent',
      'Loan Repaid to Agent',
      'Loan Given to Agent',
      'Loan Repaid by Agent',
    ]);
    expect(rows.every((r) => r.currency === 'MAD')).toBe(true);
    expect(summary.loanFromAgentLocal.toString()).toBe('60000');
    expect(summary.loanToAgentLocal.toString()).toBe('10000');
    // The company owes the agent 60,000 and is owed 10,000: net 50,000 to the agent.
    expect(summary.netLocal.toString()).toBe('-50000');
    // Only the loan lines carry the agent; the cash side is the company's own.
    expect(await prisma.journalLine.count({ where: { agentId } })).toBe(4);
  }, 240_000);

  it('the trial balance and balance sheet agree, with both loans shown separately', async () => {
    const tb = await getTrialBalanceReport({ companyId });
    const from = tb.rows.find((r) => r.name === 'Loan from RADOUAN MOHAMMED')!;
    const to = tb.rows.find((r) => r.name === 'Loan to RADOUAN MOHAMMED')!;
    expect(from.creditLocal.toString()).toBe('60000');
    expect(to.debitLocal.toString()).toBe('10000');
    const debits = tb.rows.reduce((t, r) => t.plus(r.debitUsd), dec(0));
    const credits = tb.rows.reduce((t, r) => t.plus(r.creditUsd), dec(0));
    expect(Number(debits.minus(credits).abs())).toBeLessThan(0.01);

    const bs = await getBalanceSheet({ companyId, asOf: utcDate('2026-12-31') });
    expect(bs.balancesUsd).toBe(true);
    expect(bs.liabilities.lines.some((l) => l.name === 'Loan from RADOUAN MOHAMMED')).toBe(true);
    expect(bs.assets.lines.some((l) => l.name === 'Loan to RADOUAN MOHAMMED')).toBe(true);

    const check = await reconcile(companyId);
    expect(check.checks.filter((x) => !x.passed).map((x) => x.label)).toEqual([]);
  }, 240_000);
});

describe('one submission, one document', () => {
  it('the same key twice — even at the same moment — creates one receipt', async () => {
    const input = {
      companyId, receiptDate: utcDate('2026-09-15'), customerId: masters.customer.id, currency: 'MAD',
      amount: '5000', rateToUsd: '9.6', rateLocalPerUsd: '9.6', paymentMethod: 'CASH' as const, cashBankAccountId: cashId,
      keepRemainderAsAdvance: true,
    };
    const key = 'double-click-0001';
    const submit = () =>
      onceForKey({ companyId, userId: ctx.admin.id, scope: 'RECEIPT', key }, () => createReceipt(input, ctx.admin.id));

    const [first, second] = await Promise.all([submit(), submit()]);
    const third = await submit();

    expect(new Set([first.id, second.id, third.id]).size).toBe(1);
    expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
    expect(third.replayed).toBe(true);
    expect(await prisma.receipt.count({ where: { companyId, customerId: masters.customer.id } })).toBe(1);
  }, 240_000);

  it('a different key is a different receipt', async () => {
    const created = await onceForKey(
      { companyId, userId: ctx.admin.id, scope: 'RECEIPT', key: 'second-form-0002' },
      () =>
        createReceipt(
          {
            companyId, receiptDate: utcDate('2026-09-16'), customerId: masters.customer.id, currency: 'MAD',
            amount: '5000', rateToUsd: '9.6', rateLocalPerUsd: '9.6', paymentMethod: 'CASH', cashBankAccountId: cashId,
            keepRemainderAsAdvance: true,
          },
          ctx.admin.id,
        ),
    );
    expect(created.replayed).toBe(false);
    expect(await prisma.receipt.count({ where: { companyId, customerId: masters.customer.id } })).toBe(2);
  }, 240_000);
});
