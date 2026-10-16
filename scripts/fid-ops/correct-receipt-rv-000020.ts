import 'dotenv/config';
import fs from 'node:fs';
import { prisma, transaction } from '@/lib/db';
import { createReceiptIn, postReceiptIn, reverseReceiptIn, getInvoiceOutstanding } from '@/lib/services/receipt';
import { getCustomerLedger } from '@/lib/services/ledger';
import { reconcile } from '@/lib/services/reconciliation';
import { writeAudit } from '@/lib/services/audit';

/**
 * Invoice 15 (BANI, MAD 126,000): receipt FID-MA-RV-000020 was saved with MAD
 * 126,000 received but only MAD 80,000 applied, and the other MAD 46,000 was
 * booked as a customer advance nobody paid — Cash in Hand overstated by MAD
 * 46,000 and the customer's ledger reading zero.
 *
 * The receipt is reversed the way the application reverses any receipt (it
 * stays on file as reversed, with its journal and a reversal entry), and the
 * MAD 80,000 actually received is recorded again: same date, same rate, same
 * cash account, same reference, applied to Invoice 15.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/correct-receipt-rv-000020.ts          # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/correct-receipt-rv-000020.ts --apply  # does it
 */

const RECEIPT = 'FID-MA-RV-000020';
const APPLY = process.argv.includes('--apply');

async function main() {
  const receipt = await prisma.receipt.findFirstOrThrow({
    where: { receiptNumber: RECEIPT },
    include: { allocations: true, customer: { select: { customerName: true, primaryCurrency: true } } },
  });
  if (receipt.status !== 'POSTED') throw new Error(`${RECEIPT} is ${receipt.status}; nothing to correct.`);
  if (receipt.allocations.length !== 1) throw new Error(`${RECEIPT} has ${receipt.allocations.length} allocations; expected one.`);
  const allocation = receipt.allocations[0];
  const applied = allocation.amount;
  if (Number(receipt.amount) - Number(applied) < 0.005) throw new Error(`${RECEIPT} has no unapplied remainder; nothing to correct.`);

  const company = await prisma.company.findUniqueOrThrow({ where: { id: receipt.companyId }, select: { localCurrency: true } });
  const admin = await prisma.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });

  const state = async () => {
    const outstanding = await transaction((tx) => getInvoiceOutstanding(tx, allocation.salesInvoiceId));
    const ledger = await getCustomerLedger({
      companyId: receipt.companyId, customerId: receipt.customerId, view: 'TRANSACTION',
      localCurrency: company.localCurrency, partyCurrency: receipt.customer.primaryCurrency,
    });
    const rec = await reconcile(receipt.companyId);
    return {
      invoiceOutstanding: outstanding.amount.toString(),
      customerLedgerBalance: ledger.closingBalance.toString(),
      reconciliation: `${rec.checks.filter((c) => c.passed).length}/${rec.checks.length}`,
    };
  };

  console.log(`${RECEIPT} — ${receipt.customer.customerName}: received ${receipt.currency} ${receipt.amount}, applied ${applied}, advance ${Number(receipt.amount) - Number(applied)}`);
  const before = await state();
  console.log('Now:', before);

  const correct = async (dry: boolean) =>
    transaction(async (tx) => {
      const reason = `Recorded as ${receipt.currency} ${receipt.amount} received; only ${applied} was received. The other ${Number(receipt.amount) - Number(applied)} was never paid.`;
      await reverseReceiptIn(tx, { id: receipt.id, companyId: receipt.companyId, userId: admin.id, reason });
      const replacement = await createReceiptIn(
        tx,
        {
          companyId: receipt.companyId,
          receiptDate: receipt.receiptDate,
          customerId: receipt.customerId,
          currency: receipt.currency,
          amount: applied.toString(),
          rateToUsd: receipt.rateToUsd.toString(),
          rateLocalPerUsd: receipt.rateLocalPerUsd.toString(),
          paymentMethod: receipt.paymentMethod,
          cashBankAccountId: receipt.cashBankAccountId,
          agentId: receipt.agentId,
          reference: receipt.reference,
          description: receipt.description,
          allocations: [{ salesInvoiceId: allocation.salesInvoiceId, amount: applied.toString() }],
        },
        admin.id,
      );
      await postReceiptIn(tx, { id: replacement.id, companyId: receipt.companyId, userId: admin.id });
      await writeAudit(tx, {
        companyId: receipt.companyId,
        userId: admin.id,
        action: 'RECEIPT_CORRECTED',
        entityType: 'Receipt',
        entityId: receipt.id,
        before: { receipt: RECEIPT, amount: receipt.amount.toString(), applied: applied.toString() },
        after: { receipt: replacement.receiptNumber, amount: applied.toString(), reason },
      });
      if (dry) throw Object.assign(new Error('__dry_run__'), { replacement: replacement.receiptNumber });
      return replacement.receiptNumber;
    });

  if (!APPLY) {
    try {
      await correct(true);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== '__dry_run__') throw error;
      console.log(`Would reverse ${RECEIPT} and record ${receipt.currency} ${applied} received as ${(error as Error & { replacement: string }).replacement}.`);
    }
    console.log('Dry run only. Nothing was written. Run again with --apply.');
    return;
  }

  fs.mkdirSync('backups', { recursive: true });
  const journal = await prisma.journalEntry.findMany({ where: { sourceType: 'RECEIPT', sourceId: receipt.id }, include: { lines: true } });
  const file = `backups/correct-${RECEIPT}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ receipt, journal, before }, null, 2));
  console.log('Backup written to', file);

  const replacement = await correct(false);
  console.log(`Reversed ${RECEIPT}; ${receipt.currency} ${applied} recorded as ${replacement}.`);
  console.log('After:', await state());
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
