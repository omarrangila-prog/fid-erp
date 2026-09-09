import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS, ALL_PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { SimpleMasterTable, type SimpleRow, type SimpleColumnSpec } from '@/components/shared/simple-master';
import type { FieldSpec } from '@/components/shared/master-form';
import { saveRoleAction } from '@/server/actions/admin-actions';

export const metadata: Metadata = { title: 'Roles & Permissions' };
export const dynamic = 'force-dynamic';

const COLUMNS: SimpleColumnSpec[] = [
  { id: 'name', header: 'Role', key: 'name', mobile: 'title' },
  { id: 'code', header: 'Code', key: 'code', mobile: 'meta' },
  { id: 'description', header: 'Description', key: 'description', kind: 'muted' },
  { id: 'permissions', header: 'Permissions', key: 'permissions', kind: 'number', mobile: 'meta' },
  { id: 'users', header: 'Users', key: 'users', kind: 'number', mobile: 'meta' },
  {
    id: 'kind',
    header: 'Type',
    key: 'kind',
    kind: 'badge',
    mobile: 'badge',
    tones: { System: 'info', Custom: 'neutral' },
  },
];

export default async function RolesPage() {
  await requirePageAccess(PERMISSIONS.ROLES_MANAGE);

  const roles = await prisma.role.findMany({
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    include: {
      permissions: { select: { permissionId: true, permission: { select: { code: true } } } },
      _count: { select: { users: true } },
    },
  });

  const permissions = await prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }] });

  const fields: FieldSpec[] = [
    { kind: 'text', name: 'code', label: 'Role code', required: true, hint: 'Uppercase, no spaces. e.g. SALES_MANAGER' },
    { kind: 'text', name: 'name', label: 'Role name', required: true },
    { kind: 'textarea', name: 'description', label: 'Description', full: true },
    {
      kind: 'multicheck',
      name: 'permissions',
      label: 'Permissions',
      hint: 'Permissions are checked on the server for every request, not just used to hide buttons.',
      options: permissions.map((p) => ({
        value: p.code,
        label: p.description,
        hint: p.code,
        group: p.module,
      })),
    },
  ];

  const rows: SimpleRow[] = roles.map((r) => ({
    id: r.id,
    title: r.name,
    searchText: `${r.name} ${r.code} ${r.description ?? ''}`,
    data: {
      name: r.name,
      code: r.code,
      description: r.description,
      permissions: r.permissions.length,
      users: r._count.users,
      kind: r.isSystem ? 'System' : 'Custom',
    },
    formValues: {
      code: r.code,
      name: r.name,
      description: r.description,
      permissions: r.permissions.map((p) => p.permission.code).join(','),
    },
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roles & Permissions"
        description={`${ALL_PERMISSIONS.length} permissions across ${new Set(Object.values(PERMISSION_DESCRIPTIONS).map((p) => p.module)).size} modules.`}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Roles' }]}
      />

      <Callout tone="info" title="What the sensitive permissions gate">
        <strong>Purchase cost</strong> hides unit and landed cost wherever it appears, so a sales user cannot see what
        the coffee cost. <strong>Profit</strong> hides margin, net profit and shipment profitability.{' '}
        <strong>Approve</strong> is what posts a document to the ledgers. Editing a system role is allowed, but its code
        cannot be changed.
      </Callout>

      <SimpleMasterTable
        rows={rows}
        columns={COLUMNS}
        fields={fields}
        createDefaults={{}}
        action={saveRoleAction}
        entityLabel="Role"
        canCreate
        canEdit
        emptyDescription="Roles are seeded automatically. Create a custom one if the standard set does not fit."
        searchPlaceholder="Search roles…"
      />
    </div>
  );
}
