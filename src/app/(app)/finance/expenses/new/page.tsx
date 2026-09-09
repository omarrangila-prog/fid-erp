import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { PrerequisiteGate, anyMissing, type Prerequisite } from '@/components/shared/prerequisite-gate';
import { ExpenseForm, type CategoryOption } from '@/app/(app)/finance/expenses/expense-form';

export const metadata: Metadata = { title: 'New Expense' };
export const dynamic = 'force-dynamic';

export default async function NewExpensePage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const { job } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_CREATE);
  const companyId = user.activeCompany.id;

  const [categories, shipments, vendors, agents, accounts] = await Promise.all([
    prisma.expenseCategory.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, capitaliseByDefault: true, kind: true },
    }),
    prisma.shipment.findMany({
      where: { companyId, purchaseContract: { status: 'POSTED' }, status: { not: 'CLOSED' } },
      orderBy: { shipmentNumber: 'desc' },
      select: { id: true, jobNumber: true, shipmentNumber: true, item: { select: { itemName: true } } },
    }),
    prisma.vendor.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { vendorName: 'asc' },
      select: { id: true, vendorName: true },
    }),
    prisma.agent.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { agentName: 'asc' },
      select: { id: true, agentName: true },
    }),
    prisma.cashBankAccount.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, currency: true, accountType: true },
    }),
  ]);

  const prerequisites: Prerequisite[] = [
    {
      met: categories.length > 0,
      label: 'An expense category',
      description: 'The category decides whether a cost raises the landed cost of the coffee or is charged to the period.',
      href: '/expense-categories',
      actionLabel: 'Open categories',
    },
    {
      met: accounts.length > 0,
      label: 'A cash or bank account',
      description: 'Every expense is paid from somewhere.',
      href: '/finance/cash-bank',
      actionLabel: 'Open cash & bank',
    },
  ];

  if (anyMissing(prerequisites)) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="New Expense"
          breadcrumbs={[{ label: 'Finance' }, { label: 'Expenses', href: '/finance/expenses' }, { label: 'New' }]}
        />
        <PrerequisiteGate
          title="Before you can record an expense"
          description="An expense needs a category to classify it and an account to pay it from."
          prerequisites={prerequisites}
        />
      </div>
    );
  }

  const categoryOptions: CategoryOption[] = categories.map((c) => ({
    value: c.id,
    label: c.name,
    hint: c.capitaliseByDefault ? 'Landed cost' : 'Period cost',
    keywords: c.code,
    capitaliseByDefault: c.capitaliseByDefault,
    kind: c.kind,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Expense"
        description="Record a shipment or operating cost."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Expenses', href: '/finance/expenses' }, { label: 'New' }]}
      />
      <ExpenseForm
        categories={categoryOptions}
        shipments={shipments.map((s) => ({
          value: s.id,
          label: `${s.jobNumber} · ${s.item.itemName}`,
          hint: s.shipmentNumber,
          keywords: s.shipmentNumber,
        }))}
        vendors={vendors.map((v) => ({ value: v.id, label: v.vendorName }))}
        agents={agents.map((a) => ({ value: a.id, label: a.agentName }))}
        accounts={accounts.map((a) => ({
          value: a.id,
          label: a.name,
          hint: `${a.code} · ${a.currency} · ${a.accountType.replaceAll('_', ' ').toLowerCase()}`,
          keywords: `${a.code} ${a.currency}`,
          currency: a.currency,
        }))}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={user.activeCompany.localCurrency === 'AED' ? '3.6725' : '9.85'}
        defaultShipmentId={job}
      />
    </div>
  );
}
