import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banknote, HandCoins } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, TRANSACTION_STATUS_META, PAYMENT_METHOD_LABELS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatMoney, formatDate, formatDateTime, formatRate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid, DetailRow } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/feedback';
import { VoucherActions } from '@/components/shared/voucher-actions';
import { getWarehouseLabels } from '@/lib/services/stock';

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
      container: { select: { containerNumber: true } },
      batch: { select: { batchNumber: true } },
      vendor: { select: { id: true, vendorName: true } },
      agent: { select: { agentName: true } },
      payableToAgent: { select: { id: true, agentName: true } },
      cashBankAccount: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  });

  if (!expense) notFound();

  const warehouses = await getWarehouseLabels(user.activeCompany.id);
  const unpaid = expense.status === 'POSTED' && !expense.cashBankAccountId;
  const recordPayment = unpaid && !expense.payableToAgent && can(user, PERMISSIONS.PAYMENTS_CREATE);
  const payAgentCommission =
    unpaid && expense.payableToAgent && can(user, PERMISSIONS.AGENTS_VIEW);

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
          <>
            {recordPayment ? (
              <Button asChild>
                <Link href={`/finance/payments/new?expense=${expense.id}`}>
                  <Banknote />
                  Record payment
                </Link>
              </Button>
            ) : null}
            {payAgentCommission && expense.payableToAgent ? (
              <Button asChild>
                <Link href={`/agents/${expense.payableToAgent.id}`}>
                  <HandCoins />
                  Pay commission
                </Link>
              </Button>
            ) : null}
            <VoucherActions
              kind="expense"
              id={expense.id}
              status={expense.status}
              canPost={can(user, PERMISSIONS.EXPENSES_POST)}
              canDelete={can(user, PERMISSIONS.EXPENSES_DELETE)}
            />
          </>
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
                <Link href={`/shipments/${expense.shipment.id}`} className="text-gold-700 hover:underline">
                  {expense.shipment.jobNumber}
                </Link>
              ) : (
                '—'
              )}
            </DetailRow>
            <DetailRow label="Container">{expense.container?.containerNumber ?? 'Whole shipment'}</DetailRow>
            <DetailRow label="Batch">{expense.batch?.batchNumber ?? 'Every batch'}</DetailRow>
            <DetailRow label="Warehouse">{warehouses.byExpense.get(expense.id) || '—'}</DetailRow>
            {unpaid ? (
              <DetailRow label="Settlement">
                {expense.payableToAgent
                  ? `Unpaid · owed to ${expense.payableToAgent.agentName}`
                  : expense.vendor
                    ? `Unpaid · owed to ${expense.vendor.vendorName}`
                    : 'Unpaid'}
              </DetailRow>
            ) : (
              <>
                <DetailRow label="Method">{PAYMENT_METHOD_LABELS[expense.paymentMethod]}</DetailRow>
                <DetailRow label="Paid from">{expense.cashBankAccount?.name ?? 'On credit'}</DetailRow>
              </>
            )}
            {expense.vendor ? (
              <DetailRow label="Supplier">
                <Link href={`/vendors/${expense.vendor.id}`} className="text-gold-700 hover:underline">
                  {expense.vendor.vendorName}
                </Link>
              </DetailRow>
            ) : null}
            {expense.payableToAgent || expense.agent ? (
              <DetailRow label="Agent">
                {expense.payableToAgent ? (
                  <Link href={`/agents/${expense.payableToAgent.id}`} className="text-gold-700 hover:underline">
                    {expense.payableToAgent.agentName}
                  </Link>
                ) : (
                  expense.agent?.agentName ?? '—'
                )}
              </DetailRow>
            ) : null}
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
