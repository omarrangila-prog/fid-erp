import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { ExpenseForm } from '@/app/(app)/finance/expenses/expense-form';
import { loadExpenseFormOptions } from '@/app/(app)/finance/expenses/load-expense-form';
import { EXPENSE_TRACE_OMIT, expensesHaveTraceColumns } from '@/lib/services/expense-columns';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const expense = await prisma.expense.findUnique({ where: { id }, select: { expenseNumber: true } });
  return { title: expense ? `Edit ${expense.expenseNumber}` : 'Edit Expense' };
}

export default async function EditExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_CREATE);
  const hasTrace = await expensesHaveTraceColumns();
  const expense = await prisma.expense.findFirst({
    where: { id, companyId: user.activeCompany.id },
    ...(hasTrace ? {} : { omit: EXPENSE_TRACE_OMIT }),
  });
  if (!expense) notFound();
  if (expense.status !== 'DRAFT') redirect(`/finance/expenses/${expense.id}`);

  const options = await loadExpenseFormOptions(user.activeCompany.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Edit ${expense.expenseNumber}`}
        description="Drafts have no ledger impact. Saving replaces the voucher; posting writes the journal once."
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Expenses', href: '/finance/expenses' },
          { label: expense.expenseNumber, href: `/finance/expenses/${expense.id}` },
          { label: 'Edit' },
        ]}
      />
      <ExpenseForm
        categories={options.categories}
        shipments={options.shipments}
        agents={options.agents}
        accounts={options.accounts}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={options.rates.local}
        ratesByCurrency={options.rates.byCurrency}
        canPost={can(user, PERMISSIONS.EXPENSES_POST)}
        traceByShipment={options.traceByShipment}
        taxEnabled={options.taxEnabled}
        taxLabel={options.taxLabel}
        taxCodes={options.taxCodes}
        initial={{
          id: expense.id,
          expenseDate: toDateInputValue(expense.expenseDate),
          kind: expense.kind,
          expenseCategoryId: expense.expenseCategoryId,
          shipmentId: expense.shipmentId,
          containerId: hasTrace && 'containerId' in expense ? (expense.containerId as string | null) : null,
          batchId: hasTrace && 'batchId' in expense ? (expense.batchId as string | null) : null,
          agentId: expense.agentId,
          currency: expense.currency,
          amount: expense.amount.toString(),
          rateToUsd: expense.rateToUsd.toString(),
          rateLocalPerUsd: expense.rateLocalPerUsd.toString(),
          paymentMethod:
            expense.paymentMethod === 'CASH' || expense.paymentMethod === 'CHEQUE'
              ? expense.paymentMethod
              : 'BANK_TRANSFER',
          cashBankAccountId: expense.cashBankAccountId,
          taxCodeId: expense.taxCodeId,
          reference: expense.reference ?? '',
          description: expense.description ?? '',
          capitaliseToLandedCost: expense.capitaliseToLandedCost,
        }}
      />
    </div>
  );
}
