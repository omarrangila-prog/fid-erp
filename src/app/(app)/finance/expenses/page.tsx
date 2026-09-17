import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, Repeat, SplitSquareHorizontal } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, VISIBLE_DOCUMENT_STATUSES } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatMoney, formatDate } from '@/lib/format';
import { dec } from '@/lib/money';
import { getWarehouseLabels } from '@/lib/services/stock';
import { listDueRecurring } from '@/lib/services/recurring-expense';
import { Callout } from '@/components/ui/feedback';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { EmptyAction } from '@/components/shared/empty-action';
import { ExpensesClient, type ExpenseRow } from '@/app/(app)/finance/expenses/expenses-client';

export const metadata: Metadata = { title: 'Expenses' };
export const dynamic = 'force-dynamic';

export default async function ExpensesPage() {
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_VIEW);
  const companyId = user.activeCompany.id;

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const [expenses, warehouses, dueRecurring, settled] = await Promise.all([
    prisma.expense.findMany({
      where: { companyId, status: { in: [...VISIBLE_DOCUMENT_STATUSES] } },
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
    listDueRecurring(companyId, todayUtc),
    /*
     * What has already been paid against each cost, in one query rather than
     * one per row. A cost paid straight from cash or bank needs nothing more;
     * a cost booked as owed is settled by a payment, and once that payment
     * covers it there is nothing left to pay. Offering "Pay this cost" on
     * either of those is how the same bill gets paid twice.
     */
    prisma.$queryRaw<Array<{ expenseId: string; paid: string }>>`
      SELECT pa."expenseId", COALESCE(SUM(pa."amount"), 0)::text AS paid
      FROM payment_allocations pa
      JOIN payments p ON p."id" = pa."paymentId"
      WHERE p."companyId" = ${companyId} AND p."status" = 'POSTED' AND pa."expenseId" IS NOT NULL
      GROUP BY pa."expenseId"`,
  ]);

  const paidByExpense = new Map(settled.map((row) => [row.expenseId, dec(row.paid)]));

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
    // Paid on the spot, owed to an agent, or already settled by a payment —
    // in none of those is there anything left to pay.
    needsPayment:
      e.status === 'POSTED' &&
      !e.cashBankAccountId &&
      !e.payableToAgentId &&
      dec(e.amount).plus(e.taxAmount).greaterThan(paidByExpense.get(e.id) ?? 0),
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
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link href="/finance/expenses/recurring">
                  <Repeat />
                  <span className="hidden sm:inline">Recurring</span>
                </Link>
              </Button>
              {can(user, PERMISSIONS.EXPENSES_POST) ? (
                <Button asChild variant="outline">
                  <Link href="/finance/expenses/split">
                    <SplitSquareHorizontal />
                    <span className="hidden sm:inline">Split one payment</span>
                    <span className="sm:hidden">Split</span>
                  </Link>
                </Button>
              ) : null}
              <Button asChild>
                <Link href="/finance/expenses/new">
                  <Plus />
                  <span className="hidden sm:inline">New expense</span>
                  <span className="sm:hidden">New</span>
                </Link>
              </Button>
            </div>
          ) : undefined
        }
      />
      {dueRecurring.length > 0 ? (
        <Callout
          tone="warning"
          title={dueRecurring.length === 1 ? 'A recurring expense is due' : `${dueRecurring.length} recurring expenses are due`}
        >
          {dueRecurring.map((t) => t.name).join(', ')}.{' '}
          <Link href="/finance/expenses/recurring" className="font-medium underline underline-offset-2">
            Prepare the drafts
          </Link>
          , then check and post them.
        </Callout>
      ) : null}

      <ExpensesClient
        emptyAction={
          can(user, PERMISSIONS.EXPENSES_CREATE) ? (
            <EmptyAction href="/finance/expenses/new" label="Record an expense" />
          ) : undefined
        }
        rows={rows}
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
        canPost={can(user, PERMISSIONS.EXPENSES_POST)}
        canDelete={can(user, PERMISSIONS.EXPENSES_DELETE)}
      />
    </div>
  );
}
