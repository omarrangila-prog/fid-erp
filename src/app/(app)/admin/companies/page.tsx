import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { SimpleMasterTable, type SimpleRow, type SimpleColumnSpec } from '@/components/shared/simple-master';
import { STATUS_OPTIONS, CURRENCY_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { saveCompanyAction } from '@/server/actions/admin-actions';

export const metadata: Metadata = { title: 'Companies' };
export const dynamic = 'force-dynamic';

const FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'code', label: 'Company code', required: true, placeholder: 'FID-DXB' },
  { kind: 'text', name: 'name', label: 'Trading name', required: true, placeholder: 'FID Trading L.L.C.' },
  { kind: 'text', name: 'legalName', label: 'Legal name', full: true },
  { kind: 'text', name: 'country', label: 'Country', required: true },
  {
    kind: 'select',
    name: 'localCurrency',
    label: 'Local currency',
    required: true,
    options: CURRENCY_OPTIONS,
    hint: 'Cash, bank and local expenses are kept in this currency. USD stays the group currency.',
  },
  { kind: 'text', name: 'timezone', label: 'Timezone', required: true, placeholder: 'Asia/Dubai' },
  {
    kind: 'text',
    name: 'docPrefix',
    label: 'Document prefix',
    required: true,
    placeholder: 'FID-DXB',
    hint: 'Every document number starts with this — FID-DXB-PO-000001.',
  },
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
  { kind: 'textarea', name: 'address', label: 'Address', full: true },
];

const COLUMNS: SimpleColumnSpec[] = [
  { id: 'name', header: 'Company', key: 'name', mobile: 'title' },
  { id: 'code', header: 'Code', key: 'code', mobile: 'meta' },
  { id: 'country', header: 'Country', key: 'country', mobile: 'meta' },
  { id: 'currency', header: 'Local currency', key: 'currency', kind: 'badge', mobile: 'meta', tone: 'neutral' },
  { id: 'prefix', header: 'Doc prefix', key: 'prefix', kind: 'muted', hideable: true },
  { id: 'users', header: 'Users', key: 'users', kind: 'number', hideable: true },
  { id: 'warehouses', header: 'Warehouses', key: 'warehouses', kind: 'number', hideable: true },
  {
    id: 'status',
    header: 'Status',
    key: 'status',
    kind: 'badge',
    mobile: 'badge',
    tones: { Active: 'success', Inactive: 'neutral' },
  },
];

export default async function CompaniesPage() {
  await requirePageAccess(PERMISSIONS.COMPANIES_MANAGE);

  const companies = await prisma.company.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { users: true, warehouses: true, customers: true } } },
  });

  const rows: SimpleRow[] = companies.map((c) => ({
    id: c.id,
    title: c.name,
    searchText: `${c.name} ${c.code} ${c.country}`,
    data: {
      name: c.name,
      code: c.code,
      country: c.country,
      currency: c.localCurrency,
      prefix: c.docPrefix,
      users: c._count.users,
      warehouses: c._count.warehouses,
      status: c.status === 'ACTIVE' ? 'Active' : 'Inactive',
    },
    formValues: {
      code: c.code,
      name: c.name,
      legalName: c.legalName,
      country: c.country,
      localCurrency: c.localCurrency,
      timezone: c.timezone,
      docPrefix: c.docPrefix,
      address: c.address,
      status: c.status,
    },
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Companies"
        description="Each company is a separate set of books. Data never crosses between them."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Companies' }]}
      />

      <Callout tone="warning" title="Creating a company provisions its books">
        A new company automatically gets its own chart of accounts and the standard expense categories. Its local
        currency drives local reporting and cannot sensibly be changed once transactions exist.
      </Callout>

      <SimpleMasterTable
        rows={rows}
        columns={COLUMNS}
        fields={FIELDS}
        createDefaults={{ status: 'ACTIVE', localCurrency: 'AED', timezone: 'Asia/Dubai' }}
        action={saveCompanyAction}
        entityLabel="Company"
        canCreate
        canEdit
        emptyDescription="Companies are seeded on installation."
        searchPlaceholder="Search companies…"
      />
    </div>
  );
}
