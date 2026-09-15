import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatMoney, formatDate } from '@/lib/format';
import { getWarehouseLabels } from '@/lib/services/stock';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { EmptyAction } from '@/components/shared/empty-action';
import { ExpensesClient, type ExpenseRow } from '@/app/(app)/finance/expenses/expenses-client';

export const metadata: Metadata = { title: 'Expenses' };
export const dynamic = 'force-dynamic';

export default async function ExpensesPage() {
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_VIEW);
  const companyId = user.activeCompany.id;

  const [expenses, warehouses] = await Promise.all([
    prisma.expense.findMany({
      where: { companyId },
      orderBy: [{ expenseDate: 'desc' }, { expenseNumber: 'desc' }],
      include: {
        expenseCategory: { select: { name: true } },
        shipment: { select: { id: true, jobNumber: true } },
        cashBankAccount: { select: { name: true } },
        vendor: { select: { vendorName: true } },
        agent: { select: { agentName: true } },
        createdBy: { select: { name: true } },
      },
    }),
    getWarehouseLabels(companyId),
  ]);

  const rows: ExpenseRow[] = expenses.map((e) => ({
    id: e.id,
    number: e.expenseNumber,
    date: formatDate(e.expenseDate),
    dateSort: e.expenseDate.getTime(),
    category: e.expenseCategory.name,
    job: e.shipment?.jobNumber ?? null,
    jobId: e.shipment?.id ?? null,
    currency: e.currency,
    amount: formatMoney(e.amount, e.currency),
    amountSort: Number(e.amountUsd),
    amountUsd: formatMoney(e.amountUsd, 'USD'),
    account: e.cashBankAccount?.name ?? 'On credit',
    capitalise: e.capitaliseToLandedCost,
    kind: e.kind,
    payee: e.vendor?.vendorName ?? e.agent?.agentName ?? null,
    enteredBy: e.createdBy.name,
    reference: e.reference,
    status: e.status,
    warehouseNames: warehouses.byExpense.get(e.id) ?? '',
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        description="Shipment and operating costs. Direct shipment costs are capitalised into the landed cost of the coffee."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Expenses' }]}
        actions={
          can(user, PERMISSIONS.EXPENSES_CREATE) ? (
            <Button asChild>
              <Link href="/finance/expenses/new">
                <Plus />
                <span className="hidden sm:inline">New expense</span>
                <span className="sm:hidden">New</span>
              </Link>
            </Button>
          ) : undefined
        }
      />
      <ExpensesClient
        emptyAction={
          can(user, PERMISSIONS.EXPENSES_CREATE) ? (
            <EmptyAction href="/finance/expenses/new" label="Record an expense" />
          ) : undefined
        }
        rows={rows}
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
      />
    </div>
  );
}
