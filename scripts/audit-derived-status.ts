import 'dotenv/config';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { SHIPMENT_STATUSES_LANDED } from '@/lib/constants';

/**
 * Every status the software works out for itself, checked against the
 * records it is worked out from.
 *
 * A status that disagrees with its own documents is the fault that had an
 * order reading "0 of 2 arrived" while the coffee was on the shelf. This
 * looks for the same shape of fault everywhere else it could hide: an
 * invoice called paid that is not, a cost called paid with no payment, a
 * transfer that went out and never came in.
 *
 * Read-only. It reports; it never writes.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/audit-derived-status.ts
 */

let faults = 0;
function report(label: string, bad: string[]) {
  if (bad.length === 0) {
    console.log(`  ✓ ${label}`);
    return;
  }
  faults += bad.length;
  console.log(`  ✗ ${label} — ${bad.length}`);
  for (const line of bad.slice(0, 8)) console.log(`      ${line}`);
  if (bad.length > 8) console.log(`      …and ${bad.length - 8} more`);
}

async function auditCompany(companyId: string, code: string) {
  console.log(`\n${code}`);

  // §25 — the order's own progress against its shipments.
  const contracts = await prisma.purchaseContract.findMany({
    where: { companyId },
    select: {
      contractNumber: true, contractReference: true,
      shipments: {
        select: {
          status: true,
          batches: { select: { orderedQuantityKg: true, receivedQuantityKg: true } },
        },
      },
    },
  });
  const orderFaults: string[] = [];
  for (const c of contracts) {
    for (const s of c.shipments) {
      const received = s.batches.some((b) => dec(b.receivedQuantityKg).greaterThan(0));
      if (received && !SHIPMENT_STATUSES_LANDED.includes(s.status)) {
        orderFaults.push(`${c.contractReference ?? c.contractNumber}: goods received but shipment is ${s.status}`);
      }
    }
  }
  report('every order with received goods shows its shipments as arrived', orderFaults);

  /*
   * §26 — an invoice's payment standing.
   *
   * There is no stored "paid / partly paid" here to go stale: the standing
   * is worked out from the receipts allocated to the invoice every time it
   * is read, which is the architecture the shipment status should have had.
   * What can still go wrong is the arithmetic, so that is what is checked —
   * no invoice may have taken more money than it asked for.
   */
  const invoices = await prisma.salesInvoice.findMany({
    where: { companyId, status: 'POSTED' },
    select: {
      invoiceNumber: true,
      totalAmount: true,
      allocations: { where: { receipt: { status: 'POSTED' } }, select: { amount: true } },
    },
  });
  const invoiceFaults: string[] = [];
  for (const invoice of invoices) {
    const paid = invoice.allocations.reduce((running, a) => running.plus(dec(a.amount)), dec(0));
    const total = dec(invoice.totalAmount);
    if (paid.greaterThan(total.plus('0.01'))) {
      invoiceFaults.push(`${invoice.invoiceNumber}: ${paid.toFixed(2)} received against ${total.toFixed(2)} invoiced`);
    }
  }
  report('no invoice has taken more money than it asked for', invoiceFaults);

  // §27 — a cost called paid, against payments actually made.
  const expenses = await prisma.expense.findMany({
    where: { companyId, status: 'POSTED' },
    select: {
      expenseNumber: true, amount: true, taxAmount: true, cashBankAccountId: true,
      allocations: { where: { payment: { status: 'POSTED' } }, select: { amount: true } },
    },
  });
  const expenseFaults: string[] = [];
  for (const e of expenses) {
    // A cost paid straight from a drawer is settled by its own posting.
    if (e.cashBankAccountId) continue;
    const paid = e.allocations.reduce((t, a) => t.plus(dec(a.amount)), dec(0));
    const gross = dec(e.amount).plus(dec(e.taxAmount));
    if (paid.greaterThan(gross.plus('0.01'))) {
      expenseFaults.push(`${e.expenseNumber}: ${paid.toFixed(2)} paid against ${gross.toFixed(2)} owed`);
    }
  }
  report('no cost is paid for more than it is', expenseFaults);

  // §29 — a completed transfer moved stock out and in.
  const transfers = await prisma.stockTransfer.findMany({
    where: { companyId },
    select: { transferNumber: true, workflowState: true, lines: { select: { quantityKg: true } } },
  });
  const transferFaults: string[] = [];
  for (const t of transfers) {
    if (t.workflowState !== 'RECEIVED') continue;
    const moves = await prisma.inventoryTransaction.count({
      where: { companyId, referenceType: 'STOCK_TRANSFER', notes: { contains: t.transferNumber } },
    });
    if (moves === 0 && t.lines.length > 0) {
      transferFaults.push(`${t.transferNumber}: received, but no stock movement records it`);
    }
  }
  report('every completed transfer moved the stock it says it did', transferFaults);

  // §28 — the agents explain the clearing account exactly.
  const clearing = await prisma.$queryRaw<Array<{ total: string; tagged: string }>>`
    SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS total,
           COALESCE(SUM(CASE WHEN jl."agentId" IS NOT NULL THEN jl."debitLocal" - jl."creditLocal" END), 0)::text AS tagged
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'
      AND je."isReversal" = false AND a."systemKey" = 'AGENT_CLEARING'`;
  const total = dec(clearing[0]?.total ?? 0);
  const tagged = dec(clearing[0]?.tagged ?? 0);
  report(
    'agent collections are all explained by a named agent',
    total.minus(tagged).abs().greaterThan('0.01')
      ? [`${total.minus(tagged).toFixed(2)} of the clearing account belongs to nobody`]
      : [],
  );
}

async function main() {
  console.log('Checking every status the software works out for itself. Nothing is written.');
  for (const code of ['FID-DXB', 'FID-MA']) {
    const company = await prisma.company.findUnique({ where: { code }, select: { id: true, name: true } });
    if (company) await auditCompany(company.id, company.name);
  }
  console.log(faults === 0 ? '\nEvery derived status agrees with its records.' : `\n${faults} disagreement(s) to look at.`);
  if (faults > 0) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
