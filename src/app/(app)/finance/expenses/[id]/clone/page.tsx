import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { todayInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { ExpenseForm } from '@/app/(app)/finance/expenses/expense-form';
import { loadExpenseFormOptions } from '@/app/(app)/finance/expenses/load-expense-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const expense = await prisma.expense.findUnique({ where: { id }, select: { expenseNumber: true } });
  return { title: 'Clone Expense' };
}

/**
 * A new voucher that starts out looking like an old one.
 *
 * The monthly warehouse charge, the same clearing agent's fee on the next
 * container: most of the fields are the same as last time and only the date
 * and the amount change. Cloning fills the form from the earlier voucher and
 * then behaves exactly as a new one — its own number, its own journal, no
 * link back to the original beyond the values it borrowed. Nothing about the
 * source is touched, and a posted source stays posted.
 */
export default async function CloneExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_CREATE);
  const expense = await prisma.expense.findFirst({
    where: { id, companyId: user.activeCompany.id },
  });
  if (!expense) notFound();

  const options = await loadExpenseFormOptions(user.activeCompany.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="New expense, copied from an earlier one"
        description="Pre-filled from the earlier voucher. This is a new expense with its own number; the original is not changed."
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Expenses', href: '/finance/expenses' },
          { label: expense.expenseNumber, href: `/finance/expenses/${expense.id}` },
          { label: 'Clone' },
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
        canCreateCashBank={can(user, PERMISSIONS.CASHBANK_MANAGE)}
        traceByShipment={options.traceByShipment}
        taxEnabled={options.taxEnabled}
        taxLabel={options.taxLabel}
        taxCodes={options.taxCodes}
        initial={{
          // No id: this saves as a new voucher. Today's date, not the old one —
          // a clone dated last month would be a back-dated posting nobody asked for.
          expenseDate: todayInputValue(),
          kind: expense.kind,
          expenseCategoryId: expense.expenseCategoryId,
          shipmentId: expense.shipmentId,
          containerId: expense.containerId,
          batchId: expense.batchId,
          agentId: expense.agentId,
          vendorId: expense.vendorId,
          payableToAgentId: expense.payableToAgentId,
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
          reference: '',
          description: expense.description ?? '',
          capitaliseToLandedCost: expense.capitaliseToLandedCost,
        }}
      />
    </div>
  );
}
