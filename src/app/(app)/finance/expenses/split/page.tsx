import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { PageHeader } from '@/components/shared/page-header';
import { SplitExpenseForm } from '@/app/(app)/finance/expenses/split/split-form';
import { loadExpenseFormOptions } from '@/app/(app)/finance/expenses/load-expense-form';

export const metadata: Metadata = { title: 'Split Expense' };
export const dynamic = 'force-dynamic';

export default async function SplitExpensePage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const { job } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_POST);
  const options = await loadExpenseFormOptions(user.activeCompany.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Split one payment"
        description="One amount handed over, several things it paid for. Each line becomes its own expense and they post together."
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Expenses', href: '/finance/expenses' },
          { label: 'Split' },
        ]}
      />
      <SplitExpenseForm
        categories={options.categories}
        shipments={options.shipments}
        accounts={options.accounts}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={options.rates.local}
        ratesByCurrency={options.rates.byCurrency}
        traceByShipment={options.traceByShipment}
        defaultShipmentId={job}
        canCreateCashBank={can(user, PERMISSIONS.CASHBANK_MANAGE)}
      />
    </div>
  );
}
