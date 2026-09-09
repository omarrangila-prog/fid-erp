import 'dotenv/config';
import { prisma } from '../src/lib/db';

/**
 * Empties the business data out of an installation.
 *
 * What goes: every transaction and every trading master record — purchase
 * contracts, goods receipts, shipments, stock, sales, receipts, payments,
 * expenses, cheques, journals, customers, suppliers, coffee items, agents,
 * shipping lines, notifications, the audit trail and the document numbering.
 *
 * What stays: the installation itself — companies, chart of accounts, cash and
 * bank accounts, warehouses, expense categories, application settings,
 * exchange rates, permissions, roles and the administrator.
 *
 *   npm run db:clear -- --confirm              company data only
 *   npm run db:clear -- --confirm --with-users also remove every user except
 *                                              INITIAL_ADMIN_EMAIL
 *
 * Deleting is irreversible. The flag is required for exactly that reason.
 */

type Deleter = { label: string; run: () => Promise<{ count: number }> };

const DELETIONS: Deleter[] = [
  { label: 'audit log', run: () => prisma.auditLog.deleteMany({}) },
  { label: 'notifications', run: () => prisma.notification.deleteMany({}) },
  { label: 'attachments', run: () => prisma.attachment.deleteMany({}) },
  { label: 'journal entries', run: () => prisma.journalEntry.deleteMany({}) },
  { label: 'cheques', run: () => prisma.cheque.deleteMany({}) },
  { label: 'receipts', run: () => prisma.receipt.deleteMany({}) },
  { label: 'payments', run: () => prisma.payment.deleteMany({}) },
  { label: 'expenses', run: () => prisma.expense.deleteMany({}) },
  { label: 'sales invoices', run: () => prisma.salesInvoice.deleteMany({}) },
  { label: 'stock transfers', run: () => prisma.stockTransfer.deleteMany({}) },
  { label: 'goods receipts', run: () => prisma.goodsReceipt.deleteMany({}) },
  { label: 'stock movements', run: () => prisma.inventoryTransaction.deleteMany({}) },
  { label: 'stock balances', run: () => prisma.inventoryBalance.deleteMany({}) },
  { label: 'batches', run: () => prisma.batch.deleteMany({}) },
  { label: 'containers', run: () => prisma.container.deleteMany({}) },
  { label: 'shipments', run: () => prisma.shipment.deleteMany({}) },
  { label: 'lots', run: () => prisma.lot.deleteMany({}) },
  { label: 'purchase contracts', run: () => prisma.purchaseContract.deleteMany({}) },
  { label: 'customers', run: () => prisma.customer.deleteMany({}) },
  { label: 'suppliers', run: () => prisma.vendor.deleteMany({}) },
  { label: 'coffee items', run: () => prisma.coffeeItem.deleteMany({}) },
  { label: 'agents', run: () => prisma.agent.deleteMany({}) },
  { label: 'shipping lines', run: () => prisma.shippingLine.deleteMany({}) },
  { label: 'document numbering', run: () => prisma.numberSequence.deleteMany({}) },
];

/**
 * Foreign keys make the order matter, and the order is not obvious from the
 * schema alone. Rather than encode it, keep sweeping the list until a pass
 * clears nothing new — anything still blocked then is a genuine problem.
 */
async function sweep(): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  let remaining = [...DELETIONS];

  while (remaining.length > 0) {
    const blocked: Deleter[] = [];
    let progressed = false;

    for (const deletion of remaining) {
      try {
        const { count } = await deletion.run();
        totals.set(deletion.label, (totals.get(deletion.label) ?? 0) + count);
        progressed = true;
      } catch {
        blocked.push(deletion);
      }
    }

    if (!progressed) {
      throw new Error(
        `Could not delete: ${blocked.map((d) => d.label).join(', ')}. Nothing was left half-done — rerun after resolving the constraint.`,
      );
    }
    remaining = blocked;
  }

  return totals;
}

async function main() {
  if (!process.argv.includes('--confirm')) {
    console.error(
      'Refusing to run without --confirm.\n\n' +
        'This permanently deletes every transaction and trading record in the\n' +
        'database named by DATABASE_URL. Companies, the chart of accounts, cash\n' +
        'and bank accounts, warehouses, users and roles are kept.\n\n' +
        '  npm run db:clear -- --confirm\n',
    );
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL ?? '';
  console.log(`→ Clearing business data from ${url.replace(/:\/\/[^@]*@/, '://***@')}`);

  const totals = await sweep();
  for (const [label, count] of totals) {
    if (count > 0) console.log(`  ${label.padEnd(22)} ${count}`);
  }

  if (process.argv.includes('--with-users')) {
    const adminEmail = process.env.INITIAL_ADMIN_EMAIL;
    if (!adminEmail) {
      throw new Error('INITIAL_ADMIN_EMAIL must be set before --with-users, or you would lock yourself out.');
    }
    const { count } = await prisma.user.deleteMany({ where: { email: { not: adminEmail } } });
    console.log(`  ${'users removed'.padEnd(22)} ${count} (kept ${adminEmail})`);
  }

  console.log('\n✓ Cleared. Sign in and the dashboard will show the setup checklist.');
}

main()
  .catch((error) => {
    console.error('\n✗ Clear failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
