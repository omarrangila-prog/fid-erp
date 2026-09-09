import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { SimpleMasterTable, type SimpleRow, type SimpleColumnSpec } from '@/components/shared/simple-master';
import { STATUS_OPTIONS, type FieldSpec } from '@/components/shared/master-form';
import { saveShippingLineAction } from '@/server/actions/master-actions';

export const metadata: Metadata = { title: 'Shipping Lines' };
export const dynamic = 'force-dynamic';

const FIELDS: FieldSpec[] = [
  { kind: 'text', name: 'code', label: 'Code', required: true, placeholder: 'MSC' },
  { kind: 'text', name: 'name', label: 'Shipping line', required: true, placeholder: 'Mediterranean Shipping Company' },
  { kind: 'select', name: 'status', label: 'Status', options: STATUS_OPTIONS },
  { kind: 'textarea', name: 'contactInformation', label: 'Contact information', full: true },
  { kind: 'textarea', name: 'notes', label: 'Notes', full: true },
];

const COLUMNS: SimpleColumnSpec[] = [
  { id: 'name', header: 'Shipping line', key: 'name', mobile: 'title' },
  { id: 'code', header: 'Code', key: 'code', mobile: 'meta' },
  { id: 'shipments', header: 'Shipments', key: 'shipments', kind: 'number', mobile: 'meta' },
  { id: 'contact', header: 'Contact', key: 'contact', kind: 'muted', hideable: true },
  {
    id: 'status',
    header: 'Status',
    key: 'status',
    kind: 'badge',
    mobile: 'badge',
    tones: { Active: 'success', Inactive: 'neutral' },
  },
];

export default async function ShippingLinesPage() {
  const user = await requirePageAccess(PERMISSIONS.SHIPPING_LINES_VIEW);
  const lines = await prisma.shippingLine.findMany({
    where: { companyId: user.activeCompany.id },
    orderBy: { name: 'asc' },
    include: { _count: { select: { shipments: true } } },
  });

  const rows: SimpleRow[] = lines.map((l) => ({
    id: l.id,
    title: l.name,
    searchText: `${l.name} ${l.code}`,
    data: {
      name: l.name,
      code: l.code,
      shipments: l._count.shipments,
      contact: l.contactInformation,
      status: l.status === 'ACTIVE' ? 'Active' : 'Inactive',
    },
    formValues: {
      code: l.code,
      name: l.name,
      contactInformation: l.contactInformation,
      notes: l.notes,
      status: l.status,
    },
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shipping Lines"
        description="Carriers used for bookings. A shipment cannot be marked loaded without one."
        breadcrumbs={[{ label: 'Masters' }, { label: 'Shipping Lines' }]}
      />
      <SimpleMasterTable
        rows={rows}
        columns={COLUMNS}
        fields={FIELDS}
        createDefaults={{ status: 'ACTIVE' }}
        action={saveShippingLineAction}
        entityLabel="Shipping line"
        canCreate={can(user, PERMISSIONS.SHIPPING_LINES_MANAGE)}
        canEdit={can(user, PERMISSIONS.SHIPPING_LINES_MANAGE)}
        emptyDescription="Add the carriers you book containers with."
        searchPlaceholder="Search shipping lines…"
      />
    </div>
  );
}
