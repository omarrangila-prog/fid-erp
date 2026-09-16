import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { PageHeader } from '@/components/shared/page-header';
import { ExpenseForm } from '@/app/(app)/finance/expenses/expense-form';
import { loadExpenseFormOptions } from '@/app/(app)/finance/expenses/load-expense-form';

export const metadata: Metadata = { title: 'New Expense' };
export const dynamic = 'force-dynamic';

export default async function NewExpensePage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const { job } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_CREATE);
  const options = await loadExpenseFormOptions(user.activeCompany.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Expense"
        description="Record a shipment or operating cost. Unpaid books the cost now; pay from cash or bank later."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Expenses', href: '/finance/expenses' }, { label: 'New' }]}
      />
      <ExpenseForm
        categories={options.categories}
        shipments={options.shipments}
        agents={options.agents}
        accounts={options.accounts}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={options.rates.local}
        ratesByCurrency={options.rates.byCurrency}
        defaultShipmentId={job}
        canPost={can(user, PERMISSIONS.EXPENSES_POST)}
        traceByShipment={options.traceByShipment}
        taxEnabled={options.taxEnabled}
        taxLabel={options.taxLabel}
        taxCodes={options.taxCodes}
      />
    </div>
  );
}
