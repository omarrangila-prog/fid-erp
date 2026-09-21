import type { Metadata } from 'next';
import { DocumentJournal } from '@/components/shared/document-journal';
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
import { getWarehouseLabels } from '@/lib/services/stock';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const payment = await prisma.payment.findUnique({ where: { id }, select: { paymentNumber: true } });
  return { title: payment?.paymentNumber ?? 'Payment' };
}

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.PAYMENTS_VIEW);

  const payment = await prisma.payment.findFirst({
    where: { id, companyId: user.activeCompany.id },
    include: {
      vendor: true,
      cashBankAccount: true,
      createdBy: { select: { name: true } },
      cheque: true,
      allocations: {
        include: {
          purchaseContract: { select: { id: true, contractNumber: true, contractDate: true, currency: true } },
          expense: { select: { id: true, expenseNumber: true, expenseDate: true, currency: true } },
        },
      },
    },
  });

  if (!payment) notFound();

  const warehouses = await getWarehouseLabels(user.activeCompany.id);
  const applied = sum(payment.allocations.map((a) => dec(a.amountUsd)));
  const onAccount = dec(payment.amountUsd).minus(applied);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Paid to ${payment.vendor?.vendorName ?? 'accrued costs'}`}
        description={[formatDate(payment.paymentDate), payment.reference].filter(Boolean).join(' · ')}
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Payments', href: '/finance/payments' },
          { label: payment.vendor?.vendorName ?? 'Payment' },
        ]}
        meta={
          <>
            <StatusBadge status={payment.status} meta={TRANSACTION_STATUS_META} />
            <Badge tone="neutral">{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</Badge>
            {payment.cheque ? <StatusBadge status={payment.cheque.status} meta={CHEQUE_STATUS_META} /> : null}
          </>
        }
        actions={
          <VoucherActions
            kind="payment"
            id={payment.id}
            status={payment.status}
            canPost={can(user, PERMISSIONS.PAYMENTS_POST)}
            canDelete={can(user, PERMISSIONS.PAYMENTS_DELETE)}
          />
        }
      />

      {payment.status === 'REVERSED' ? (
        <Callout tone="danger" title="This payment was deleted">
          {payment.reversalReason} — deleted {formatDateTime(payment.reversedAt)}.
        </Callout>
      ) : null}

      <MetricGrid>
        <Metric label="Amount paid" value={formatMoney(payment.amount, payment.currency)} />
        <Metric label="USD equivalent" value={formatMoney(payment.amountUsd, 'USD')} />
        <Metric
          label={`In ${user.activeCompany.localCurrency}`}
          value={formatMoney(payment.amountLocal, user.activeCompany.localCurrency)}
          tone="muted"
        />
        <Metric
          label="Rate used"
          value={payment.currency === 'USD' ? '1.00000000' : formatRate(payment.rateToUsd)}
          hint={`${payment.currency} per 1 USD`}
        />
        <Metric label="Applied to contracts" value={formatMoney(applied, 'USD')} />
        <Metric label="Held on account" value={formatMoney(onAccount, 'USD')} tone={onAccount.greaterThan(0) ? 'muted' : 'default'} />
      </MetricGrid>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Applied to</CardTitle>
            <CardDescription>Which contracts and costs this payment settled.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {payment.allocations.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-subtle">Held on account.</p>
            ) : (
              payment.allocations.map((allocation) => {
                // A payment settles the coffee or a cost billed by the same
                // supplier; both are listed here, each linking to its own page.
                const target = allocation.purchaseContract
                  ? {
                      href: `/purchases/${allocation.purchaseContract.id}`,
                      number: allocation.purchaseContract.contractNumber,
                      date: allocation.purchaseContract.contractDate,
                      currency: allocation.purchaseContract.currency,
                    }
                  : {
                      href: `/finance/expenses/${allocation.expense!.id}`,
                      number: allocation.expense!.expenseNumber,
                      date: allocation.expense!.expenseDate,
                      currency: allocation.expense!.currency,
                    };
                return (
                  <Link
                    key={allocation.id}
                    href={target.href}
                    className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-forest-800">{target.number}</span>
                      <span className="block text-xs text-ink-subtle">{formatDate(target.date)}</span>
                      {(() => {
                        const label = allocation.purchaseContract
                          ? warehouses.byContract.get(allocation.purchaseContract.id)
                          : allocation.expense
                            ? warehouses.byExpense.get(allocation.expense.id)
                            : undefined;
                        return label ? (
                          <span className="block text-xs text-ink-subtle">{label}</span>
                        ) : null;
                      })()}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="tnum block text-sm font-semibold">
                        {formatMoney(allocation.amount, target.currency)}
                      </span>
                      <span className="tnum block text-xs text-ink-subtle">
                        {formatMoney(allocation.amountUsd, 'USD')}
                      </span>
                    </span>
                  </Link>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Voucher</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label="Supplier">
                {payment.vendor ? (
                  <Link href={`/ledgers/vendors/${payment.vendorId}`} className="text-gold-700 hover:underline">
                    {payment.vendor.vendorName}
                  </Link>
                ) : (
                  <span className="text-ink-muted">None — settles costs booked without a supplier</span>
                )}
              </DetailRow>
              <DetailRow label="Date">{formatDate(payment.paymentDate)}</DetailRow>
              <DetailRow label="Method">{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</DetailRow>
              <DetailRow label="Account">{payment.cashBankAccount?.name ?? 'Cheques issued'}</DetailRow>
              <DetailRow label="Reference">{payment.reference ?? '—'}</DetailRow>
              <DetailRow label="Warehouse">{warehouses.byPayment.get(payment.id) || '—'}</DetailRow>
              <DetailRow label={`Rate to ${user.activeCompany.localCurrency}`}>
                {formatRate(payment.rateLocalPerUsd)}
              </DetailRow>
              <DetailRow label="Created by">
                {payment.createdBy.name}
                <span className="block text-xs text-ink-subtle">{formatDateTime(payment.createdAt)}</span>
              </DetailRow>
              {payment.cheque ? (
                <>
                  <DetailRow label="Cheque">{payment.cheque.chequeNumber}</DetailRow>
                  <DetailRow label="Bank">{payment.cheque.bankName}</DetailRow>
                  <DetailRow label="Cheque status">
                    <StatusBadge status={payment.cheque.status} meta={CHEQUE_STATUS_META} />
                  </DetailRow>
                </>
              ) : null}
            </dl>
            {payment.description ? (
              <p className="mt-3 whitespace-pre-line border-t border-line pt-3 text-xs text-ink-muted">
                {payment.description}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <DocumentJournal
        localCurrency={user.activeCompany.localCurrency}
        companyId={user.activeCompany.id}
        sourceType="PAYMENT"
        sourceId={payment.id}
      />
    </div>
  );
}
