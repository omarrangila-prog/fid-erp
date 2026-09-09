import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, TRANSACTION_STATUS_META, PAYMENT_METHOD_LABELS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatMoney, formatDate, formatRate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { VoucherTable, type VoucherRow } from '@/components/shared/voucher-table';
import { EmptyAction } from '@/components/shared/empty-action';

export const metadata: Metadata = { title: 'Receipts' };
export const dynamic = 'force-dynamic';

export default async function ReceiptsPage() {
  const user = await requirePageAccess(PERMISSIONS.RECEIPTS_VIEW);

  const receipts = await prisma.receipt.findMany({
    where: { companyId: user.activeCompany.id },
    orderBy: [{ receiptDate: 'desc' }, { receiptNumber: 'desc' }],
    include: {
      customer: { select: { customerName: true } },
      cashBankAccount: { select: { name: true } },
      allocations: { select: { id: true } },
    },
  });

  const rows: VoucherRow[] = receipts.map((r) => ({
    id: r.id,
    number: r.receiptNumber,
    date: formatDate(r.receiptDate),
    dateSort: r.receiptDate.getTime(),
    party: r.customer.customerName,
    account: r.cashBankAccount?.name ?? 'Cheques on hand',
    method: PAYMENT_METHOD_LABELS[r.paymentMethod] ?? r.paymentMethod,
    currency: r.currency,
    amount: formatMoney(r.amount, r.currency),
    amountSort: Number(r.amountUsd),
    amountUsd: formatMoney(r.amountUsd, 'USD'),
    rate: r.currency === 'USD' ? '—' : formatRate(r.rateToUsd),
    reference: r.reference,
    allocationCount: r.allocations.length,
    status: r.status,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Receipts"
        description="Money in from customers. Each voucher keeps the exchange rate it was agreed at, permanently."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Receipts' }]}
        actions={
          can(user, PERMISSIONS.RECEIPTS_CREATE) ? (
            <Button asChild>
              <Link href="/finance/receipts/new">
                <Plus />
                <span className="hidden sm:inline">New receipt</span>
                <span className="sm:hidden">New</span>
              </Link>
            </Button>
          ) : undefined
        }
      />
      <VoucherTable
        emptyAction={
          can(user, PERMISSIONS.RECEIPTS_CREATE) ? (
            <EmptyAction href="/finance/receipts/new" label="Record a receipt" />
          ) : undefined
        }
        rows={rows}
        basePath="/finance/receipts"
        partyLabel="Customer"
        statusMeta={TRANSACTION_STATUS_META}
        emptyTitle="No receipts yet"
        emptyDescription="Record a customer payment to reduce their outstanding balance."
      />
    </div>
  );
}
