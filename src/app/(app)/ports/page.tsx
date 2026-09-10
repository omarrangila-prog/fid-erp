import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { SimpleMasterTable, type SimpleRow, type SimpleColumnSpec } from '@/components/shared/simple-master';
import { STATUS_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { savePortAction } from '@/server/actions/master-actions';

export const metadata: Metadata = { title: 'Ports' };
export const dynamic = 'force-dynamic';

const FIELDS: FieldSpec[] = [
  {
    kind: 'text',
    name: 'code',
    label: 'Code',
    required: true,
    placeholder: 'AEJEA',
    hint: 'UN/LOCODE where there is one.',
  },
  { kind: 'text', name: 'name', label: 'Port', required: true, placeholder: 'Jebel Ali' },
  { kind: 'text', name: 'country', label: 'Country', placeholder: 'United Arab Emirates' },
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
  { kind: 'textarea', name: 'notes', label: 'Notes', full: true },
];

const COLUMNS: SimpleColumnSpec[] = [
  { id: 'name', header: 'Port', key: 'name', mobile: 'title' },
  { id: 'code', header: 'Code', key: 'code', mobile: 'meta' },
  { id: 'country', header: 'Country', key: 'country', mobile: 'meta' },
  { id: 'notes', header: 'Notes', key: 'notes', kind: 'muted', hideable: true },
  {
    id: 'status',
    header: 'Status',
    key: 'status',
    kind: 'badge',
    mobile: 'badge',
    tones: { Active: 'success', Inactive: 'neutral' },
  },
];

export default async function PortsPage() {
  const user = await requirePageAccess(PERMISSIONS.PORTS_VIEW);

  const ports = await prisma.port.findMany({
    where: { companyId: user.activeCompany.id },
    orderBy: [{ country: 'asc' }, { name: 'asc' }],
  });

  const rows: SimpleRow[] = ports.map((port) => ({
    id: port.id,
    title: port.name,
    searchText: `${port.name} ${port.code} ${port.country ?? ''}`,
    data: {
      name: port.name,
      code: port.code,
      country: port.country,
      notes: port.notes,
      status: port.status === 'ACTIVE' ? 'Active' : 'Inactive',
    },
    formValues: {
      code: port.code,
      name: port.name,
      country: port.country,
      notes: port.notes,
      status: port.status,
    },
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ports"
        description="The ports this company loads at and discharges into."
        breadcrumbs={[{ label: 'Contacts' }, { label: 'Ports' }]}
      />

      <Callout tone="info" title="A list, not a constraint">
        A shipment still records the port exactly as the bill of lading states it — a document has to say what the
        paperwork says. This list is what the entry forms offer, so the same port does not end up spelled four ways
        and quietly split the shipment register into four groups.
      </Callout>

      <SimpleMasterTable
        rows={rows}
        columns={COLUMNS}
        fields={FIELDS}
        createDefaults={{ status: 'ACTIVE' }}
        action={savePortAction}
        entityLabel="Port"
        canCreate={can(user, PERMISSIONS.PORTS_MANAGE)}
        canEdit={can(user, PERMISSIONS.PORTS_MANAGE)}
        emptyDescription="Add the ports you load at and discharge into."
        searchPlaceholder="Search ports…"
      />
    </div>
  );
}
