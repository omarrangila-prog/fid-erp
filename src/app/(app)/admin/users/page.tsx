import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { SimpleMasterTable, type SimpleRow, type SimpleColumnSpec } from '@/components/shared/simple-master';
import type { FieldSpec } from '@/components/shared/master-form';
import { saveUserAction } from '@/server/actions/admin-actions';

export const metadata: Metadata = { title: 'Users' };
export const dynamic = 'force-dynamic';

const COLUMNS: SimpleColumnSpec[] = [
  { id: 'name', header: 'User', key: 'name', mobile: 'title' },
  { id: 'email', header: 'Email', key: 'email', mobile: 'meta' },
  { id: 'roles', header: 'Roles', key: 'roles', kind: 'muted', mobile: 'meta' },
  { id: 'companies', header: 'Company access', key: 'companies', kind: 'muted' },
  { id: 'lastLogin', header: 'Last sign-in', key: 'lastLogin', kind: 'muted', hideable: true },
  {
    id: 'status',
    header: 'Status',
    key: 'status',
    kind: 'badge',
    mobile: 'badge',
    tones: { Active: 'success', Disabled: 'danger', 'Super Admin': 'info' },
  },
];

export default async function UsersPage() {
  const admin = await requirePageAccess(PERMISSIONS.USERS_MANAGE);

  const [users, roles, companies] = await Promise.all([
    prisma.user.findMany({
      orderBy: { name: 'asc' },
      include: {
        roles: { include: { role: { select: { id: true, name: true } } } },
        companies: { include: { company: { select: { id: true, name: true, code: true } } } },
      },
    }),
    prisma.role.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, description: true } }),
    prisma.company.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, code: true } }),
  ]);

  const fields: FieldSpec[] = [
    { kind: 'section', title: 'Account' },
    { kind: 'text', name: 'name', label: 'Full name', required: true },
    { kind: 'email', name: 'email', label: 'Email address', required: true },
    {
      kind: 'text',
      name: 'password',
      label: 'Password',
      hint: 'Leave blank to keep the current password. Minimum 10 characters with upper case, lower case and a digit.',
      full: true,
    },

    { kind: 'section', title: 'Access', description: 'Roles grant permissions; company access decides which books they can open.' },
    {
      kind: 'multicheck',
      name: 'roleIds',
      label: 'Roles',
      options: roles.map((r) => ({ value: r.id, label: r.name, hint: r.description ?? undefined })),
    },
    {
      kind: 'multicheck',
      name: 'companyIds',
      label: 'Company access',
      hint: 'Staff should be assigned exactly one company. Only administrators need both.',
      options: companies.map((c) => ({ value: c.id, label: c.name, hint: c.code })),
      columns: 1,
    },
    {
      kind: 'select',
      name: 'defaultCompanyId',
      label: 'Opens by default in',
      options: [{ value: '', label: 'First available company' }, ...companies.map((c) => ({ value: c.id, label: c.name }))],
    },
    { kind: 'checkbox', name: 'isActive', label: 'Account is active', hint: 'A disabled account cannot sign in.' },
    {
      kind: 'checkbox',
      name: 'isSuperAdmin',
      label: 'Super Admin',
      hint: 'Bypasses every permission and company restriction. Grant sparingly.',
    },
  ];

  const rows: SimpleRow[] = users.map((u) => ({
    id: u.id,
    title: u.name,
    searchText: `${u.name} ${u.email} ${u.roles.map((r) => r.role.name).join(' ')}`,
    data: {
      name: u.name,
      email: u.email,
      roles: u.isSuperAdmin ? 'All permissions' : u.roles.map((r) => r.role.name).join(', ') || 'No role',
      companies: u.isSuperAdmin ? 'Every company' : u.companies.map((c) => c.company.code).join(', ') || 'None',
      lastLogin: u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never',
      status: !u.isActive ? 'Disabled' : u.isSuperAdmin ? 'Super Admin' : 'Active',
    },
    formValues: {
      name: u.name,
      email: u.email,
      password: '',
      isActive: u.isActive,
      isSuperAdmin: u.isSuperAdmin,
      roleIds: u.roles.map((r) => r.roleId).join(','),
      companyIds: u.companies.map((c) => c.companyId).join(','),
      defaultCompanyId: u.defaultCompanyId ?? '',
    },
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Individual accounts. There are no shared logins — every financial action is attributed to a person."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Users' }]}
      />

      <Callout tone="warning" title="Company access is a financial control">
        A user can only see and post into the companies assigned here, and the rule is enforced on the server, not just
        in the interface. Changing someone&rsquo;s access is recorded in the audit trail, and changing a password signs
        that user out everywhere.
      </Callout>

      <SimpleMasterTable
        rows={rows}
        columns={COLUMNS}
        fields={fields}
        createDefaults={{ isActive: true, isSuperAdmin: false, companyIds: admin.activeCompany.id }}
        action={saveUserAction}
        entityLabel="User"
        canCreate
        canEdit
        emptyDescription="Create accounts for your staff and assign them a role and a company."
        searchPlaceholder="Search users…"
      />
    </div>
  );
}
