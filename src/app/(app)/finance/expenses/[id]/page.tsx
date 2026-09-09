import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, TRANSACTION_STATUS_META, PAYMENT_METHOD_LABELS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatMoney, formatDate, formatDateTime, formatRate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid, DetailRow } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Callout } from '@/components/ui/feedback';
import { VoucherActions } from '@/components/shared/voucher-actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const expense = await prisma.expense.findUnique({ where: { id }, select: { expenseNumber: true } });
  return { title: expense?.expenseNumber ?? 'Expense' };
}

export default async function ExpenseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_VIEW);

  const expense = await prisma.expense.findFirst({
    where: { id, companyId: user.activeCompany.id },
    include: {
      expenseCategory: true,
      shipment: { select: { id: true, jobNumber: true, shipmentNumber: true } },
      vendor: { select: { id: true, vendorName: true } },
      agent: { select: { agentName: true } },
      cashBankAccount: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  });

  if (!expense) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        title={expense.expenseNumber}
        description={expense.expenseCategory.name}
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Expenses', href: '/finance/expenses' },
          { label: expense.expenseNumber },
        ]}
        meta={
          <>
            <StatusBadge status={expense.status} meta={TRANSACTION_STATUS_META} />
            <Badge tone={expense.capitaliseToLandedCost ? 'info' : 'neutral'}>
              {expense.capitaliseToLandedCost ? 'Landed cost' : 'Period cost'}
            </Badge>
            {expense.shipment ? (
              <Link href={`/shipments/${expense.shipment.id}`}>
                <Badge tone="info">Job {expense.shipment.jobNumber}</Badge>
              </Link>
            ) : null}
          </>
        }
        actions={
          <VoucherActions
            kind="expense"
            id={expense.id}
            status={expense.status}
            canPost={can(user, PERMISSIONS.EXPENSES_POST)}
            canDelete={can(user, PERMISSIONS.EXPENSES_DELETE)}
          />
        }
      />

      {expense.status === 'REVERSED' ? (
        <Callout tone="danger" title="This expense has been reversed">
          {expense.reversalReason} — reversed {formatDateTime(expense.reversedAt)}.
          {expense.capitaliseToLandedCost ? ' The landed cost it added was unwound from the batches.' : ''}
        </Callout>
      ) : null}

      {expense.status === 'POSTED' && expense.capitaliseToLandedCost ? (
        <Callout tone="info" title="Capitalised into landed cost">
          This cost was spread across the job&rsquo;s batches. Coffee still in stock is carried at the higher value,
          and the share belonging to coffee already sold was moved straight into cost of goods sold — so the ledger
          continues to agree with the profitability report.
        </Callout>
      ) : null}

      <MetricGrid>
        <Metric label="Amount" value={formatMoney(expense.amount, expense.currency)} />
        <Metric label="USD equivalent" value={formatMoney(expense.amountUsd, 'USD')} />
        <Metric
          label={`In ${user.activeCompany.localCurrency}`}
          value={formatMoney(expense.amountLocal, user.activeCompany.localCurrency)}
          tone="muted"
        />
        <Metric
          label="Rate used"
          value={expense.currency === 'USD' ? '1.00000000' : formatRate(expense.rateToUsd)}
        />
      </MetricGrid>

      <Card>
        <CardHeader>
          <CardTitle>Voucher</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="sm:grid sm:grid-cols-2 sm:gap-x-8">
            <DetailRow label="Category">{expense.expenseCategory.name}</DetailRow>
            <DetailRow label="Date">{formatDate(expense.expenseDate)}</DetailRow>
            <DetailRow label="Job">
              {expense.shipment ? (
                <Link href={`/shipments/${expense.shipment.id}`} className="text-teal-700 hover:underline">
                  {expense.shipment.jobNumber}
                </Link>
              ) : (
                '—'
              )}
            </DetailRow>
            <DetailRow label="Method">{PAYMENT_METHOD_LABELS[expense.paymentMethod]}</DetailRow>
            <DetailRow label="Paid from">{expense.cashBankAccount?.name ?? 'On credit'}</DetailRow>
            <DetailRow label="Supplier">
              {expense.vendor ? (
                <Link href={`/vendors/${expense.vendor.id}`} className="text-teal-700 hover:underline">
                  {expense.vendor.vendorName}
                </Link>
              ) : (
                '—'
              )}
            </DetailRow>
            <DetailRow label="Agent">{expense.agent?.agentName ?? '—'}</DetailRow>
            <DetailRow label="Reference">{expense.reference ?? '—'}</DetailRow>
            <DetailRow label="Created by">
              {expense.createdBy.name}
              <span className="block text-xs text-ink-subtle">{formatDateTime(expense.createdAt)}</span>
            </DetailRow>
            {expense.postedAt ? <DetailRow label="Posted">{formatDateTime(expense.postedAt)}</DetailRow> : null}
          </dl>
          {expense.description ? (
            <p className="mt-3 whitespace-pre-line border-t border-line pt-3 text-xs text-ink-muted">
              {expense.description}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
