import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { prisma, transaction } from '@/lib/db';
import { ensureExpenseCategories } from '@/lib/services/chart-of-accounts';
import { PageHeader } from '@/components/shared/page-header';
import { ExpenseForm, type CategoryOption } from '@/app/(app)/finance/expenses/expense-form';

export const metadata: Metadata = { title: 'New Expense' };
export const dynamic = 'force-dynamic';

export default async function NewExpensePage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const { job } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_CREATE);
  const companyId = user.activeCompany.id;

  await transaction((tx) => ensureExpenseCategories(tx, companyId));

  const [categories, shipments, agents, accounts, containers, batches] = await Promise.all([
    prisma.expenseCategory.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, capitaliseByDefault: true, kind: true },
    }),
    prisma.shipment.findMany({
      where: { companyId, purchaseContract: { status: 'POSTED' } },
      orderBy: { shipmentNumber: 'desc' },
      select: {
        id: true,
        jobNumber: true,
        shipmentNumber: true,
        item: { select: { itemName: true } },
        vendor: { select: { vendorName: true } },
        purchaseContract: { select: { contractReference: true, contractNumber: true } },
      },
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
    prisma.container.findMany({
      where: { companyId, shipmentId: { not: null }, status: 'ACTIVE' },
      orderBy: { containerNumber: 'asc' },
      select: { id: true, containerNumber: true, shipmentId: true },
    }),
    prisma.batch.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { batchNumber: 'asc' },
      select: { id: true, batchNumber: true, shipmentId: true, containerId: true },
    }),
  ]);

  const categoryOptions: CategoryOption[] = categories.map((c) => ({
    value: c.id,
    label: c.name,
    hint: c.capitaliseByDefault ? 'Landed cost' : 'Period cost',
    keywords: c.code,
    capitaliseByDefault: c.capitaliseByDefault,
    kind: c.kind,
  }));

  const rates = await getRateDefaults(user.activeCompany.id);

  const traceByShipment: Record<string, { containers: Array<{ value: string; label: string }>; batches: Array<{ value: string; label: string; containerId: string | null }> }> = {};
  for (const container of containers) {
    if (!container.shipmentId) continue;
    const entry = (traceByShipment[container.shipmentId] ??= { containers: [], batches: [] });
    entry.containers.push({ value: container.id, label: container.containerNumber });
  }
  for (const batch of batches) {
    const entry = (traceByShipment[batch.shipmentId] ??= { containers: [], batches: [] });
    entry.batches.push({
      value: batch.id,
      label: batch.batchNumber,
      containerId: batch.containerId,
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Expense"
        description="Record a shipment or operating cost. Unpaid books the cost now; pay from cash or bank later."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Expenses', href: '/finance/expenses' }, { label: 'New' }]}
      />
      <ExpenseForm
        categories={categoryOptions}
        shipments={shipments.map((s) => ({
          value: s.id,
          label: `${s.purchaseContract.contractReference} · ${s.jobNumber}`,
          hint: `${s.vendor.vendorName} · ${s.shipmentNumber} · ${s.item.itemName}`,
          keywords: `${s.purchaseContract.contractReference} ${s.purchaseContract.contractNumber} ${s.jobNumber} ${s.shipmentNumber} ${s.vendor.vendorName} ${s.item.itemName}`,
        }))}
        agents={agents.map((a) => ({ value: a.id, label: a.agentName }))}
        accounts={accounts.map((a) => ({
          value: a.id,
          label: a.name,
          hint: `${a.code} · ${a.currency} · ${a.accountType.replaceAll('_', ' ').toLowerCase()}`,
          keywords: `${a.code} ${a.currency}`,
          currency: a.currency,
          accountType: a.accountType,
        }))}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={rates.local}
        ratesByCurrency={rates.byCurrency}
        defaultShipmentId={job}
        canPost={can(user, PERMISSIONS.EXPENSES_POST)}
        traceByShipment={traceByShipment}
      />
    </div>
  );
}
