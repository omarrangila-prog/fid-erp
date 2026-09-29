import type { Metadata } from 'next';
import { MakeRecurringButton } from '@/app/(app)/finance/expenses/[id]/make-recurring';
import { DocumentJournal } from '@/components/shared/document-journal';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banknote, HandCoins, Copy } from 'lucide-react';
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
import { settledThrough } from '@/lib/ledger-target';
import { getExpenseSettlements, EXPENSE_PAYMENT_LABEL } from '@/lib/services/expense-settlement';
import { RecordHistory } from '@/components/shared/record-history';

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
      vendor: { select: { id: true, vendorName: true, country: true } },
      agent: { select: { id: true, agentName: true } },
      payableToAgent: { select: { id: true, agentName: true } },
      cashBankAccount: { select: { name: true } },
      ledgerAccount: { select: { name: true } },
      ledgerAgent: { select: { agentName: true } },
      createdBy: { select: { name: true } },
    },
  });

  if (!expense) notFound();

  const warehouses = await getWarehouseLabels(user.activeCompany.id);
  /*
   * Still owed, rather than merely booked as owed — from the one calculation
   * every screen uses: payments allocated to it, commission settled to the
   * agent, journal vouchers on the account it is held in. Offering to pay a
   * settled cost again is how the same bill gets paid twice.
   */
  const settlement =
    expense.status === 'POSTED' ? (await getExpenseSettlements(user.activeCompany.id, [expense])).get(expense.id) : undefined;
  const paidOnTheSpot = Boolean(expense.cashBankAccountId || expense.ledgerAccountId || expense.ledgerAgentId);
  const unpaid = expense.status === 'POSTED' && !paidOnTheSpot && settlement !== undefined && settlement.status !== 'PAID';
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
            {settlement ? (
              <Badge
                tone={settlement.status === 'PAID' ? 'success' : settlement.status === 'PARTIAL' ? 'warning' : 'danger'}
                data-testid="expense-payment-badge"
              >
                {EXPENSE_PAYMENT_LABEL[settlement.status]}
              </Badge>
            ) : null}
            <Badge tone={expense.capitaliseToLandedCost ? 'info' : 'neutral'}>
              {expense.capitaliseToLandedCost ? 'Landed cost' : 'Period cost'}
            </Badge>
            {expense.capitaliseToLandedCost && !expense.batchId ? (
              <Badge tone="neutral">
                {expense.allocationMethod === 'BY_WEIGHT'
                  ? 'Shared by weight'
                  : expense.allocationMethod === 'BY_VALUE'
                    ? 'Shared by value'
                    : 'Shared equally per coffee'}
              </Badge>
            ) : null}
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
            {unpaid && can(user, PERMISSIONS.PAYMENTS_POST) ? (
              // Cash, bank, cheque or a set-off — settled from the cost itself, so it is never booked twice.
              <Button asChild>
                <Link href={`/finance/unpaid-expenses?settle=${expense.id}`}>
                  <Banknote />
                  Settle Expense
                </Link>
              </Button>
            ) : recordPayment ? (
              <Button asChild>
                <Link href={`/finance/payments/new?expense=${expense.id}`}>
                  <Banknote />
                  Settle Expense
                </Link>
              </Button>
            ) : payAgentCommission && expense.payableToAgent ? (
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
      <RecordHistory entityType="Expense" entityId={expense.id} />

      {expense.status === 'REVERSED' ? (
        <Callout tone="danger" title="This expense was deleted">
          {expense.reversalReason} — deleted {formatDateTime(expense.reversedAt)}.
          {expense.capitaliseToLandedCost ? ' The landed cost it added was taken back off the batches.' : ''}
        </Callout>
      ) : null}

      {expense.status === 'POSTED' && expense.taxAmount.greaterThan(0) ? (
        <Callout tone="info" title="This expense carries tax">
          {formatMoney(expense.amount, expense.currency)} net plus {formatMoney(expense.taxAmount, expense.currency)}{' '}
          tax left the account — {formatMoney(expense.amount.plus(expense.taxAmount), expense.currency)} in all. If no
          tax was meant, delete this expense and enter it again without a tax code.
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
            label={expense.cashBankAccountId ? 'Cash / bank moved' : paidOnTheSpot ? 'Settled ledger to ledger' : 'Gross payable'}
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
          <CardTitle>Details</CardTitle>
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
            {paidOnTheSpot ? (
              <>
                <DetailRow label="Method">{PAYMENT_METHOD_LABELS[expense.paymentMethod]}</DetailRow>
                <DetailRow label="Paid from">{settledThrough(expense, 'On credit')}</DetailRow>
              </>
            ) : settlement ? (
              <>
                <DetailRow label="Payment status">
                  <span data-testid="expense-payment-status">
                    {EXPENSE_PAYMENT_LABEL[settlement.status]}
                    {settlement.status !== 'PAID'
                      ? ` · payable to ${expense.payableToAgent?.agentName ?? expense.vendor?.vendorName ?? 'nobody named yet (Unpaid Expenses)'}`
                      : ''}
                  </span>
                </DetailRow>
                <DetailRow label="Paid">
                  <span data-testid="expense-paid">{formatMoney(settlement.paid, expense.currency)}</span>
                  {settlement.paidFrom ? <span className="text-ink-muted"> · {settlement.paidFrom}</span> : null}
                </DetailRow>
                <DetailRow label="Outstanding">
                  <span data-testid="expense-outstanding">{formatMoney(settlement.outstanding, expense.currency)}</span>
                </DetailRow>
                {settlement.transferredLocal.greaterThan('0.005') ? (
                  <DetailRow label="Moved by journal entry">
                    <span data-testid="expense-transferred">
                      {formatMoney(settlement.transferredLocal, user.activeCompany.localCurrency)} to{' '}
                      {settlement.transferredTo.join(', ') || 'another account'} — still unpaid, owed there
                    </span>
                  </DetailRow>
                ) : null}
              </>
            ) : (
              <DetailRow label="Settlement">Not posted</DetailRow>
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
                ) : expense.agent ? (
                  <Link href={`/agents/${expense.agent.id}`} className="text-gold-700 hover:underline">
                    {expense.agent.agentName}
                  </Link>
                ) : (
                  '—'
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
        localCurrency={user.activeCompany.localCurrency}
        companyId={user.activeCompany.id}
        sourceType="EXPENSE"
        sourceId={expense.id}
      />
    </div>
  );
}
