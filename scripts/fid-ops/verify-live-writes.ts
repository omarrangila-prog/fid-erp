import { prisma, transaction } from '@/lib/db';
import { reconcile } from '@/lib/services/reconciliation';
import { getCashBankBalance } from '@/lib/services/accounting';
import { getCashBook, getTrialBalanceReport, getProfitAndLoss, getBalanceSheet } from '@/lib/services/reports';
import { dec } from '@/lib/money';

/**
 * Does the live database still take writes, and roll them back, after the
 * connection change?
 *
 * Every write here happens inside a transaction that is deliberately aborted,
 * so the client's books are read but never altered. What is being proved is
 * that the transaction pooler supports the whole shape of this application:
 * interactive transactions, writes inside them, rollback, raw SQL and reads
 * under concurrency.
 */
class Rollback extends Error {}

async function attempt(label: string, fn: (tx: Parameters<Parameters<typeof transaction>[0]>[0]) => Promise<string>) {
  try {
    await transaction(async (tx) => {
      const detail = await fn(tx);
      throw new Rollback(detail);
    });
    console.log(`✗ ${label} — the transaction did not roll back`);
  } catch (error) {
    if (error instanceof Rollback) {
      console.log(`✓ ${label} — ${error.message} (rolled back)`);
      return;
    }
    console.log(`✗ ${label} — ${error instanceof Error ? error.message.split('\n')[0] : error}`);
    process.exitCode = 1;
  }
}

async function main() {
  const morocco = await prisma.company.findUniqueOrThrow({ where: { code: 'FID-MA' } });
  const admin = await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true } });
  const companyId = morocco.id;

  console.log('WRITES (each one rolled back, so the books are untouched)\n');

  await attempt('Customer save', async (tx) => {
    const created = await tx.customer.create({
      data: {
        companyId,
        customerCode: `ZZ-PROBE-${Date.now()}`,
        customerName: 'Connection probe — not a real customer',
        primaryCurrency: 'MAD',
        paymentTermDays: 30,
      },
    });
    return `created ${created.customerName}`;
  });

  await attempt('Supplier save', async (tx) => {
    const created = await tx.vendor.create({
      data: {
        companyId,
        vendorCode: `ZZ-PROBE-${Date.now()}`,
        vendorName: 'Connection probe — not a real supplier',
        primaryCurrency: 'USD',
        paymentTermDays: 30,
      },
    });
    return `created ${created.vendorName}`;
  });

  await attempt('Update an existing record', async (tx) => {
    const customer = await tx.customer.findFirstOrThrow({ where: { companyId } });
    const before = customer.customerName;
    await tx.customer.update({ where: { id: customer.id }, data: { customerName: `${before} (probe)` } });
    const after = await tx.customer.findUniqueOrThrow({ where: { id: customer.id } });
    if (!after.customerName.endsWith('(probe)')) throw new Error('the update did not take');
    return `renamed ${before} and read it back`;
  });

  await attempt('Journal posting with a USD → MAD conversion', async (tx) => {
    const { postJournalEntry } = await import('@/lib/services/accounting');
    const bank = await tx.cashBankAccount.findFirstOrThrow({
      where: { companyId, currency: 'MAD', status: 'ACTIVE' },
    });
    const loan = await tx.account.findFirstOrThrow({
      where: { companyId, systemKey: 'INTERCOMPANY_LOAN_PAYABLE' },
    });
    const entry = await postJournalEntry(tx, {
      companyId,
      entryDate: new Date(),
      description: 'Connection probe — rolled back',
      sourceType: 'MANUAL',
      sourceId: `PROBE-${Date.now()}`,
      createdById: admin.id,
      localCurrency: 'MAD',
      rateLocalPerUsd: '9.22',
      lines: [
        {
          cashBankAccountId: bank.id,
          direction: 'DEBIT',
          currency: 'MAD',
          amount: '9220',
          rateToUsd: '9.22',
          description: 'USD 1,000 at 9.22',
        },
        {
          accountId: loan.id,
          direction: 'CREDIT',
          currency: 'USD',
          amount: '1000',
          rateToUsd: '1',
          description: 'USD 1,000 owed',
        },
      ],
    });
    return `${entry.entryNumber}: MAD 9,220 in, USD 1,000 owed — balanced in both`;
  });

  await attempt('A failure inside a transaction undoes the whole thing', async (tx) => {
    const created = await tx.customer.create({
      data: {
        companyId,
        customerCode: `ZZ-ATOMIC-${Date.now()}`,
        customerName: 'Atomicity probe',
        primaryCurrency: 'MAD',
        paymentTermDays: 30,
      },
    });
    const seen = await tx.customer.findUnique({ where: { id: created.id } });
    if (!seen) throw new Error('the write was not visible inside its own transaction');
    return 'a write is visible inside its transaction and gone after';
  });

  // Nothing above may have survived.
  const strays = await prisma.customer.count({ where: { customerCode: { startsWith: 'ZZ-' } } });
  const strayVendors = await prisma.vendor.count({ where: { vendorCode: { startsWith: 'ZZ-' } } });
  const probeEntries = await prisma.journalEntry.count({ where: { sourceId: { startsWith: 'PROBE-' } } });
  console.log(`\n  nothing left behind: ${strays} customers, ${strayVendors} suppliers, ${probeEntries} entries\n`);
  if (strays + strayVendors + probeEntries > 0) process.exitCode = 1;

  console.log('READS\n');
  const accounts = await prisma.cashBankAccount.findMany({ where: { companyId, status: 'ACTIVE' } });
  for (const account of accounts) {
    const book = await getCashBook({ companyId, cashBankAccountId: account.id });
    const ledger = await transaction((tx) => getCashBankBalance(tx, companyId, account.id));
    const agree = book.closingBalance.toString() === dec(ledger).toString();
    console.log(`${agree ? '✓' : '✗'} ${account.name}: cash book ${book.closingBalance} = ledger ${dec(ledger)}`);
    if (!agree) process.exitCode = 1;
  }

  const tb = await getTrialBalanceReport({ companyId });
  console.log(`${tb.isBalanced ? '✓' : '✗'} Trial balance: ${tb.totals.debitUsd} = ${tb.totals.creditUsd}`);
  const pnl = await getProfitAndLoss({ companyId, from: new Date('2026-01-01'), to: new Date('2026-12-31') });
  console.log(`✓ Profit & loss: net USD ${pnl.totals.netProfitUsd}`);
  const bs = await getBalanceSheet({ companyId, asOf: new Date('2026-12-31') });
  console.log(
    `${bs.balancesUsd ? '✓' : '✗'} Balance sheet: assets ${bs.assets.totalUsd} = liabilities ${bs.liabilities.totalUsd}` +
      ` + equity ${bs.equity.totalUsd} (difference ${bs.differenceUsd})`,
  );
  if (!bs.balancesUsd) process.exitCode = 1;

  console.log('');
  for (const code of ['FID-DXB', 'FID-MA']) {
    const co = await prisma.company.findUniqueOrThrow({ where: { code } });
    const h = await reconcile(co.id);
    console.log(`${h.healthy ? '✓' : '✗'} ${code}: ${h.passed}/${h.checks.length}`);
    if (!h.healthy) process.exitCode = 1;
  }

  console.log('\nCONCURRENCY\n');
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => transaction(async (tx) => tx.journalEntry.count())),
  );
  console.log(`✓ 20 transactions at once: ${new Set(results).size === 1 ? 'all agree' : 'DISAGREE'} on ${results[0]} entries (${Date.now() - started}ms)`);
}

main()
  .catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
