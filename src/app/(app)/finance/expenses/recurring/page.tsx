import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { listRecurring } from '@/lib/services/recurring-expense';
import { formatDate, formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { RecurringClient, type RecurringRow } from '@/app/(app)/finance/expenses/recurring/recurring-client';

export const metadata: Metadata = { title: 'Recurring Expenses' };
export const dynamic = 'force-dynamic';

const FREQUENCY_LABELS: Record<string, string> = {
  WEEKLY: 'week',
  MONTHLY: 'month',
  QUARTERLY: 'quarter',
  YEARLY: 'year',
};

export default async function RecurringExpensesPage() {
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_VIEW);
  const companyId = user.activeCompany.id;

  const templates = await listRecurring(companyId);
  const categoryIds = [...new Set(templates.map((t) => (t.template as { expenseCategoryId?: string }).expenseCategoryId).filter(Boolean))] as string[];
  const categories = await prisma.expenseCategory.findMany({
    where: { id: { in: categoryIds } },
    select: { id: true, name: true },
  });
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const rows: RecurringRow[] = templates.map((t) => {
    const body = t.template as { expenseCategoryId?: string; amount?: string; currency?: string };
    return {
      id: t.id,
      name: t.name,
      frequency: t.frequency,
      frequencyLabel: FREQUENCY_LABELS[t.frequency] ?? t.frequency.toLowerCase(),
      nextDate: formatDate(t.nextDate),
      nextDateSort: t.nextDate.getTime(),
      endDate: t.endDate ? formatDate(t.endDate) : null,
      amount: formatMoney(body.amount ?? '0', body.currency ?? user.activeCompany.localCurrency),
      category: categoryName.get(body.expenseCategoryId ?? '') ?? '—',
      status: t.status,
      due: t.status === 'ACTIVE' && t.nextDate <= todayUtc,
      lastCreatedId: t.lastCreatedId,
    };
  });

  const due = rows.filter((r) => r.due).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recurring Expenses"
        description="Costs that come round on a rhythm. On each due date a draft is prepared for you to check and post — nothing posts on its own."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Expenses', href: '/finance/expenses' }, { label: 'Recurring' }]}
      />

      {due > 0 ? (
        <Callout tone="warning" title={due === 1 ? 'One expense is due' : `${due} expenses are due`}>
          Choose <strong>Create draft now</strong> on each to prepare it, then check and post the draft.
        </Callout>
      ) : null}

      <RecurringClient rows={rows} />
    </div>
  );
}
