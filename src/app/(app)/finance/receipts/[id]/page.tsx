import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, TRANSACTION_STATUS_META, PAYMENT_METHOD_LABELS, CHEQUE_STATUS_META } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec, sum } from '@/lib/money';
import { formatMoney, formatDate, formatDateTime, formatRate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid, DetailRow } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Callout } from '@/components/ui/feedback';
import { VoucherActions } from '@/components/shared/voucher-actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const receipt = await prisma.receipt.findUnique({ where: { id }, select: { receiptNumber: true } });
  return { title: receipt?.receiptNumber ?? 'Receipt' };
}

export default async function ReceiptDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.RECEIPTS_VIEW);

  const receipt = await prisma.receipt.findFirst({
    where: { id, companyId: user.activeCompany.id },
    include: {
      customer: true,
      cashBankAccount: true,
      createdBy: { select: { name: true } },
      cheque: { include: { statusHistory: { orderBy: { changedAt: 'desc' }, include: { changedBy: { select: { name: true } } } } } },
      allocations: { include: { salesInvoice: { select: { id: true, invoiceNumber: true, invoiceDate: true, currency: true } } } },
    },
  });

  if (!receipt) notFound();

  const applied = sum(receipt.allocations.map((a) => dec(a.amountUsd)));
  const onAccount = dec(receipt.amountUsd).minus(applied);

  return (
    <div className="space-y-6">
      <PageHeader
        title={receipt.receiptNumber}
        description={`${receipt.customer.customerName}${receipt.reference ? ` · ${receipt.reference}` : ''}`}
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Receipts', href: '/finance/receipts' },
          { label: receipt.receiptNumber },
        ]}
        meta={
          <>
            <StatusBadge status={receipt.status} meta={TRANSACTION_STATUS_META} />
            <Badge tone="neutral">{PAYMENT_METHOD_LABELS[receipt.paymentMethod]}</Badge>
            {receipt.cheque ? <StatusBadge status={receipt.cheque.status} meta={CHEQUE_STATUS_META} /> : null}
          </>
        }
        actions={
          <VoucherActions
            kind="receipt"
            id={receipt.id}
            status={receipt.status}
            canPost={can(user, PERMISSIONS.RECEIPTS_POST)}
            canDelete={can(user, PERMISSIONS.RECEIPTS_DELETE)}
          />
        }
      />

      {receipt.status === 'REVERSED' ? (
        <Callout tone="danger" title="This receipt has been reversed">
          {receipt.reversalReason} — reversed {formatDateTime(receipt.reversedAt)}. Any invoices it settled are
          outstanding again.
        </Callout>
      ) : null}

      {receipt.paymentMethod === 'CHEQUE' && receipt.cheque && receipt.cheque.status !== 'CLEARED' ? (
        <Callout tone="warning" title="This is a cheque, not cash yet">
          The value sits in <strong>Cheques on Hand</strong>. It reaches the bank only when the cheque is marked
          cleared on the{' '}
          <Link href={`/finance/cheques`} className="underline">
            cheque register
          </Link>
          .
        </Callout>
      ) : null}

      <MetricGrid>
        <Metric label="Amount received" value={formatMoney(receipt.amount, receipt.currency)} />
        <Metric label="USD equivalent" value={formatMoney(receipt.amountUsd, 'USD')} />
        <Metric
          label={`In ${user.activeCompany.localCurrency}`}
          value={formatMoney(receipt.amountLocal, user.activeCompany.localCurrency)}
          tone="muted"
        />
        <Metric
          label="Rate used"
          value={receipt.currency === 'USD' ? '1.00000000' : formatRate(receipt.rateToUsd)}
          hint={`${receipt.currency} per 1 USD`}
        />
        <Metric label="Applied to invoices" value={formatMoney(applied, 'USD')} />
        <Metric
          label="Held on account"
          value={formatMoney(onAccount, 'USD')}
          tone={onAccount.greaterThan(0) ? 'muted' : 'default'}
        />
      </MetricGrid>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Applied to</CardTitle>
            <CardDescription>Which invoices this payment settled, and by how much.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {receipt.allocations.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-subtle">
                Held on account — not applied to any invoice.
              </p>
            ) : (
              receipt.allocations.map((allocation) => (
                <Link
                  key={allocation.id}
                  href={`/sales/${allocation.salesInvoice.id}`}
                  className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-navy-800">
                      {allocation.salesInvoice.invoiceNumber}
                    </span>
                    <span className="block text-xs text-ink-subtle">
                      {formatDate(allocation.salesInvoice.invoiceDate)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tnum block text-sm font-semibold">
                      {formatMoney(allocation.amount, allocation.salesInvoice.currency)}
                    </span>
                    <span className="tnum block text-xs text-ink-subtle">
                      {formatMoney(allocation.amountUsd, 'USD')}
                    </span>
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Voucher</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <DetailRow label="Customer">
                  <Link href={`/ledgers/customers/${receipt.customerId}`} className="text-teal-700 hover:underline">
                    {receipt.customer.customerName}
                  </Link>
                </DetailRow>
                <DetailRow label="Date">{formatDate(receipt.receiptDate)}</DetailRow>
                <DetailRow label="Method">{PAYMENT_METHOD_LABELS[receipt.paymentMethod]}</DetailRow>
                <DetailRow label="Account">{receipt.cashBankAccount?.name ?? 'Cheques on hand'}</DetailRow>
                <DetailRow label="Reference">{receipt.reference ?? '—'}</DetailRow>
                <DetailRow label={`Rate to ${user.activeCompany.localCurrency}`}>
                  {formatRate(receipt.rateLocalPerUsd)}
                </DetailRow>
                <DetailRow label="Created by">
                  {receipt.createdBy.name}
                  <span className="block text-xs text-ink-subtle">{formatDateTime(receipt.createdAt)}</span>
                </DetailRow>
                {receipt.postedAt ? (
                  <DetailRow label="Posted">{formatDateTime(receipt.postedAt)}</DetailRow>
                ) : null}
              </dl>
              {receipt.description ? (
                <p className="mt-3 whitespace-pre-line border-t border-line pt-3 text-xs text-ink-muted">
                  {receipt.description}
                </p>
              ) : null}
            </CardContent>
          </Card>

          {receipt.cheque ? (
            <Card>
              <CardHeader>
                <CardTitle>Cheque</CardTitle>
              </CardHeader>
              <CardContent>
                <dl>
                  <DetailRow label="Number">{receipt.cheque.chequeNumber}</DetailRow>
                  <DetailRow label="Bank">{receipt.cheque.bankName}</DetailRow>
                  <DetailRow label="Cheque date">{formatDate(receipt.cheque.chequeDate)}</DetailRow>
                  <DetailRow label="Status">
                    <StatusBadge status={receipt.cheque.status} meta={CHEQUE_STATUS_META} />
                  </DetailRow>
                  <DetailRow label="Deposited">{formatDate(receipt.cheque.depositDate)}</DetailRow>
                  <DetailRow label="Cleared">{formatDate(receipt.cheque.clearingDate)}</DetailRow>
                  {receipt.cheque.bounceReason ? (
                    <DetailRow label="Bounce reason">{receipt.cheque.bounceReason}</DetailRow>
                  ) : null}
                </dl>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
