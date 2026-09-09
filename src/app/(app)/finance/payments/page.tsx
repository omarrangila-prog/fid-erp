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

export const metadata: Metadata = { title: 'Payments' };
export const dynamic = 'force-dynamic';

export default async function PaymentsPage() {
  const user = await requirePageAccess(PERMISSIONS.PAYMENTS_VIEW);

  const payments = await prisma.payment.findMany({
    where: { companyId: user.activeCompany.id },
    orderBy: [{ paymentDate: 'desc' }, { paymentNumber: 'desc' }],
    include: {
      vendor: { select: { vendorName: true } },
      cashBankAccount: { select: { name: true } },
      allocations: { select: { id: true } },
    },
  });

  const rows: VoucherRow[] = payments.map((p) => ({
    id: p.id,
    number: p.paymentNumber,
    date: formatDate(p.paymentDate),
    dateSort: p.paymentDate.getTime(),
    party: p.vendor.vendorName,
    account: p.cashBankAccount?.name ?? 'Cheques issued',
    method: PAYMENT_METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod,
    currency: p.currency,
    amount: formatMoney(p.amount, p.currency),
    amountSort: Number(p.amountUsd),
    amountUsd: formatMoney(p.amountUsd, 'USD'),
    rate: p.currency === 'USD' ? '—' : formatRate(p.rateToUsd),
    reference: p.reference,
    allocationCount: p.allocations.length,
    status: p.status,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="Money out to suppliers, allocated against purchase contracts."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Payments' }]}
        actions={
          can(user, PERMISSIONS.PAYMENTS_CREATE) ? (
            <Button asChild>
              <Link href="/finance/payments/new">
                <Plus />
                <span className="hidden sm:inline">New payment</span>
                <span className="sm:hidden">New</span>
              </Link>
            </Button>
          ) : undefined
        }
      />
      <VoucherTable
        emptyAction={
          can(user, PERMISSIONS.PAYMENTS_CREATE) ? (
            <EmptyAction href="/finance/payments/new" label="Record a payment" />
          ) : undefined
        }
        rows={rows}
        basePath="/finance/payments"
        partyLabel="Supplier"
        statusMeta={TRANSACTION_STATUS_META}
        emptyTitle="No payments yet"
        emptyDescription="Record a supplier payment to reduce what the company owes."
      />
    </div>
  );
}
