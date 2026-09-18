import type { Metadata } from 'next';
import { MakeRecurringButton } from '@/app/(app)/finance/expenses/[id]/make-recurring';
import { DocumentJournal } from '@/components/shared/document-journal';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banknote, HandCoins, Copy } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, TRANSACTION_STATUS_META, PAYMENT_METHOD_LABELS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
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
      shipment: {
        select: {
          id: true,
          jobNumber: true,
          shipmentNumber: true,
          purchaseContract: { select: { contractReference: true } },
        },
      },
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
  /*
   * Still owed, rather than merely booked as owed. A cost paid from cash or
   * bank needs nothing more; one booked on credit is settled by a payment,
   * and once payments cover it there is nothing left to pay. Offering to pay
   * it again is how the same bill gets paid twice.
   */
  const paidAgainst = await prisma.paymentAllocation.aggregate({
    where: { expenseId: expense.id, payment: { status: 'POSTED' } },
    _sum: { amount: true },
  });
  const owed = dec(expense.amount).plus(expense.taxAmount).minus(paidAgainst._sum.amount ?? 0);
  const unpaid = expense.status === 'POSTED' && !expense.cashBankAccountId && owed.greaterThan(0);
  const recordPayment = unpaid && !expense.payableToAgent && can(user, PERMISSIONS.PAYMENTS_CREATE);
  const payAgentCommission =
    unpaid && expense.payableToAgent && can(user, PERMISSIONS.AGENTS_VIEW);

  return (
    <div className="space-y-6">
      <PageHeader
        title={expense.expenseCategory.name}
        description={expense.description ?? formatDate(expense.expenseDate)}
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Expenses', href: '/finance/expenses' },
          { label: expense.expenseCategory.name },
        ]}
        meta={
          <>
            <StatusBadge status={expense.status} meta={TRANSACTION_STATUS_META} />
            <Badge tone={expense.capitaliseToLandedCost ? 'info' : 'neutral'}>
              {expense.capitaliseToLandedCost ? 'Landed cost' : 'Period cost'}
            </Badge>
            {expense.shipment ? (
              <Link href={`/shipments/${expense.shipment.id}`}>
                <Badge tone="info">{expense.shipment.purchaseContract?.contractReference ?? 'Shipment'}</Badge>
              </Link>
            ) : null}
          </>
        }
        actions={
          <>
            {expense.status !== 'REVERSED' && expense.status !== 'CANCELLED' && can(user, PERMISSIONS.EXPENSES_CREATE) ? (
              <Button asChild variant="outline">
                <Link href={`/finance/expenses/${expense.id}/edit`}>Edit</Link>
              </Button>
            ) : null}
            {can(user, PERMISSIONS.EXPENSES_CREATE) ? (
              <Button asChild variant="outline">
                <Link href={`/finance/expenses/${expense.id}/clone`}>
                  <Copy />
                  Clone
                </Link>
              </Button>
            ) : null}
            {can(user, PERMISSIONS.EXPENSES_CREATE) && expense.status !== 'CANCELLED' ? (
              <MakeRecurringButton
                expenseId={expense.id}
                suggestedName={expense.description ?? expense.expenseCategory.name}
              />
            ) : null}
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
        <Callout tone="danger" title="This expense was deleted">
          {expense.reversalReason} — deleted {formatDateTime(expense.reversedAt)}.
          {expense.capitaliseToLandedCost ? ' The landed cost it added was taken back off the batches.' : ''}
        </Callout>
      ) : null}

      {expense.status === 'POSTED' && expense.taxAmount.greaterThan(0) ? (
        <Callout tone="info" title="This voucher carries tax">
          {formatMoney(expense.amount, expense.currency)} net plus {formatMoney(expense.taxAmount, expense.currency)}{' '}
          tax left the account — {formatMoney(expense.amount.plus(expense.taxAmount), expense.currency)} in all. If no
          tax was meant, delete this voucher and enter it again without a tax code.
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
        <Metric label="Amount entered" value={formatMoney(expense.amount, expense.currency)} />
        {Number(expense.taxAmount) > 0 ? (
          <Metric
            label="Tax"
            value={formatMoney(expense.taxAmount, expense.currency)}
            hint={`${Number(expense.taxRatePct)}%`}
          />
        ) : null}
        {Number(expense.taxAmount) > 0 ? (
          <Metric
            label={expense.cashBankAccountId ? 'Cash / bank moved' : 'Gross payable'}
            value={formatMoney(expense.amount.plus(expense.taxAmount), expense.currency)}
          />
        ) : null}
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
                  {expense.shipment.purchaseContract?.contractReference ?? 'Shipment'}
                </Link>
              ) : (
                '—'
              )}
            </DetailRow>
            <DetailRow label="Container">
              {'container' in expense ? (expense.container?.containerNumber ?? 'Whole shipment') : 'Whole shipment'}
            </DetailRow>
            <DetailRow label="Batch">
              {'batch' in expense ? (expense.batch?.batchNumber ?? 'Every batch') : 'Every batch'}
            </DetailRow>
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

      <DocumentJournal
        companyId={user.activeCompany.id}
        sourceType="EXPENSE"
        sourceId={expense.id}
      />
    </div>
  );
}
