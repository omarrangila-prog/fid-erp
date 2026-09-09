import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { SimpleMasterTable, type SimpleRow, type SimpleColumnSpec } from '@/components/shared/simple-master';
import { STATUS_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { saveExpenseCategoryAction } from '@/server/actions/master-actions';

export const metadata: Metadata = { title: 'Expense Categories' };
export const dynamic = 'force-dynamic';

const FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'code', label: 'Code', required: true, placeholder: 'CLEARING' },
  { kind: 'text', name: 'name', label: 'Category name', required: true, placeholder: 'Clearing Charges' },
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
  { kind: 'textarea', name: 'description', label: 'Description', full: true },
  {
    kind: 'checkbox',
    name: 'capitaliseByDefault',
    label: 'Capitalise into landed cost',
    hint: 'Direct shipment costs raise the cost of the coffee. Period costs go straight to the profit and loss.',
    full: true,
  },
];

const COLUMNS: SimpleColumnSpec[] = [
  { id: 'name', header: 'Category', key: 'name', mobile: 'title' },
  { id: 'code', header: 'Code', key: 'code', mobile: 'meta' },
  { id: 'account', header: 'GL account', key: 'account', kind: 'muted', mobile: 'meta' },
  {
    id: 'treatment',
    header: 'Treatment',
    key: 'treatment',
    kind: 'badge',
    mobile: 'badge',
    tones: { 'Landed cost': 'info', 'Period cost': 'neutral' },
  },
  { id: 'used', header: 'Expenses', key: 'used', kind: 'number', hideable: true },
  {
    id: 'status',
    header: 'Status',
    key: 'status',
    kind: 'badge',
    tones: { Active: 'success', Inactive: 'neutral' },
  },
];

export default async function ExpenseCategoriesPage() {
  const user = await requirePageAccess(PERMISSIONS.EXPENSE_CATEGORIES_VIEW);
  const categories = await prisma.expenseCategory.findMany({
    where: { companyId: user.activeCompany.id },
    orderBy: [{ capitaliseByDefault: 'desc' }, { name: 'asc' }],
    include: { glAccount: { select: { code: true, name: true } }, _count: { select: { expenses: true } } },
  });

  const rows: SimpleRow[] = categories.map((c) => ({
    id: c.id,
    title: c.name,
    searchText: `${c.name} ${c.code}`,
    data: {
      name: c.name,
      code: c.code,
      account: c.glAccount ? `${c.glAccount.code} · ${c.glAccount.name}` : null,
      treatment: c.capitaliseByDefault ? 'Landed cost' : 'Period cost',
      used: c._count.expenses,
      status: c.status === 'ACTIVE' ? 'Active' : 'Inactive',
    },
    formValues: {
      code: c.code,
      name: c.name,
      description: c.description,
      capitaliseByDefault: c.capitaliseByDefault,
      status: c.status,
    },
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expense Categories"
        description="Each category posts to its own general ledger account and decides whether a cost lands in stock or in the profit and loss."
        breadcrumbs={[{ label: 'Masters' }, { label: 'Expense Categories' }]}
      />

      <Callout tone="info" title="Landed cost or period cost?">
        Ocean freight, insurance, customs, clearing, port charges, inland transport, documentation, labour and
        inspection are direct costs of getting coffee to the warehouse, so they are <strong>capitalised</strong> into
        its landed cost and reach profit through cost of goods sold. Bank charges, agent commission and storage are{' '}
        <strong>period costs</strong> and are expensed as incurred. Getting this wrong distorts both stock valuation
        and gross margin.
      </Callout>

      <SimpleMasterTable
        rows={rows}
        columns={COLUMNS}
        fields={FIELDS}
        createDefaults={{ status: 'ACTIVE', capitaliseByDefault: true }}
        action={saveExpenseCategoryAction}
        entityLabel="Expense category"
        canCreate={can(user, PERMISSIONS.EXPENSE_CATEGORIES_MANAGE)}
        canEdit={can(user, PERMISSIONS.EXPENSE_CATEGORIES_MANAGE)}
        emptyDescription="Categories are created automatically when a company is set up."
        searchPlaceholder="Search categories…"
      />
    </div>
  );
}
