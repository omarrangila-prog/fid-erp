import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, Repeat, SplitSquareHorizontal } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, VISIBLE_DOCUMENT_STATUSES } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatMoney, formatDate } from '@/lib/format';
import { dec, type Decimal } from '@/lib/money';
import { getWarehouseLabels } from '@/lib/services/stock';
import { listDueRecurring } from '@/lib/services/recurring-expense';
import { getExpenseSettlements, type ExpenseSettlement } from '@/lib/services/expense-settlement';
import { Callout } from '@/components/ui/feedback';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { EmptyAction } from '@/components/shared/empty-action';
import { ExpensesClient, type ExpenseRow } from '@/app/(app)/finance/expenses/expenses-client';

export const metadata: Metadata = { title: 'Expenses' };
export const dynamic = 'force-dynamic';

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { kind: kindParam } = await searchParams;
  // Shipment Expenses and General Expenses are this one list, filtered.
  const kind = kindParam === 'SHIPMENT' || kindParam === 'GENERAL' ? kindParam : undefined;
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_VIEW);
  const companyId = user.activeCompany.id;

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const [expenses, warehouses, dueRecurring] = await Promise.all([
    prisma.expense.findMany({
      where: { companyId, status: { in: [...VISIBLE_DOCUMENT_STATUSES] }, ...(kind ? { kind } : {}) },
      orderBy: [{ expenseDate: 'desc' }, { expenseNumber: 'desc' }],
      include: {
        expenseCategory: { select: { name: true } },
        shipment: {
          select: {
            id: true,
            jobNumber: true,
            purchaseContract: { select: { contractReference: true } },
          },
        },
        cashBankAccount: { select: { name: true } },
        vendor: { select: { vendorName: true, country: true } },
        payableToAgent: { select: { agentName: true } },
        agent: { select: { agentName: true } },
        createdBy: { select: { name: true } },
      },
    }),
    getWarehouseLabels(companyId),
    listDueRecurring(companyId, todayUtc),
  ]);

  /*
   * Paid, partly paid or unpaid — the same answer the shipment page and the
   * cost report give, from one calculation. Offering "Pay this cost" on a
   * cost already settled is how the same bill gets paid twice.
   */
  const settlements = await getExpenseSettlements(companyId, expenses);
  const local = user.activeCompany.localCurrency;

  const rows: ExpenseRow[] = expenses.map((e) => ({
    id: e.id,
    number: e.expenseNumber,
    date: formatDate(e.expenseDate),
    dateSort: e.expenseDate.getTime(),
    category: e.expenseCategory.name,
    description: e.description,
    job: e.shipment?.purchaseContract?.contractReference ?? null,
    jobId: e.shipment?.id ?? null,
    currency: e.currency,
    amount: formatMoney(e.amount, e.currency),
    amountSort: Number(e.amountUsd),
    amountUsd: formatMoney(e.amountUsd, 'USD'),
    ...paymentFields(settlements.get(e.id), e),
    // Owed to an agent is settled through the agent's account, not here.
    needsPayment: Boolean(
      settlements.get(e.id) && settlements.get(e.id)!.status !== 'PAID' && !e.payableToAgentId,
    ),
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
        title={kind === 'SHIPMENT' ? 'Shipment Expenses' : kind === 'GENERAL' ? 'General Expenses' : 'Expenses'}
        description={
          kind === 'SHIPMENT'
            ? 'Costs booked against a shipment. Direct costs are capitalised into the landed cost of its coffee.'
            : kind === 'GENERAL'
              ? 'Running costs of the business that belong to no shipment: rent, salaries, fuel, bank charges.'
              : 'Shipment and operating costs. Direct shipment costs are capitalised into the landed cost of the coffee.'
        }
        breadcrumbs={[
          { label: 'Finance' },
          kind ? { label: 'Expenses', href: '/finance/expenses' } : { label: 'Expenses' },
          ...(kind ? [{ label: kind === 'SHIPMENT' ? 'Shipment' : 'General' }] : []),
        ]}
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
        localCurrency={local}
        todayIso={todayUtc.toISOString().slice(0, 10)}
        defaultPeriod={kind === 'GENERAL' ? 'MONTH' : 'ALL'}
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
        canPost={can(user, PERMISSIONS.EXPENSES_POST)}
        canDelete={can(user, PERMISSIONS.EXPENSES_DELETE)}
      />
    </div>
  );
}

/**
 * The payment columns of one row: its status, where the money came from or
 * who it is owed to, and the three amounts in the company's currency at the
 * cost's own rate, so the totals above the list add up across currencies.
 */
function paymentFields(
  settlement: ExpenseSettlement | undefined,
  e: {
    currency: string;
    amountUsd: Decimal;
    taxAmountUsd: Decimal;
    vendor: { vendorName: string } | null;
    payableToAgent: { agentName: string } | null;
  },
): Pick<ExpenseRow, 'payment' | 'account' | 'outstandingLabel' | 'grossLocal' | 'paidLocal' | 'owedLocal' | 'grossUsd' | 'paidUsd' | 'owedUsd'> {
  if (!settlement) {
    return { payment: null, account: '—', outstandingLabel: '—', grossLocal: 0, paidLocal: 0, owedLocal: 0, grossUsd: 0, paidUsd: 0, owedUsd: 0 };
  }
  const usd = dec(e.amountUsd).plus(dec(e.taxAmountUsd));
  const share = (part: Decimal) => (settlement.gross.isZero() ? 0 : Number(usd.times(part).dividedBy(settlement.gross)));
  const owedTo = e.payableToAgent?.agentName ?? e.vendor?.vendorName ?? null;
  return {
    payment: settlement.status,
    account:
      settlement.status === 'PAID'
        ? (settlement.paidFrom ?? 'Paid')
        : settlement.paidFrom
          ? `${settlement.paidFrom} (part)`
          : owedTo
            ? `Owed to ${owedTo}`
            : 'Not paid yet',
    outstandingLabel: settlement.outstanding.isZero() ? '—' : formatMoney(settlement.outstanding, e.currency),
    grossLocal: Number(settlement.grossLocal),
    paidLocal: Number(settlement.paidLocal),
    owedLocal: Number(settlement.outstandingLocal),
    grossUsd: share(settlement.gross),
    paidUsd: share(settlement.paid),
    owedUsd: share(settlement.outstanding),
  };
}
