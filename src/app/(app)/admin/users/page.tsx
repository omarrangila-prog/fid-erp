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
import { parseScope } from '@/lib/user-access';

export const metadata: Metadata = { title: 'Users' };
export const dynamic = 'force-dynamic';

const COLUMNS: SimpleColumnSpec[] = [
  { id: 'name', header: 'User', key: 'name', mobile: 'title' },
  { id: 'roles', header: 'Role', key: 'roles', kind: 'muted', mobile: 'meta' },
  { id: 'pin', header: 'PIN', key: 'pin', kind: 'badge', tones: { Set: 'success', 'Not set': 'warning' } },
  { id: 'scope', header: 'Sees', key: 'scope', kind: 'muted', hideable: true },
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

  const [users, roles, companies, agents, warehouses, scopes] = await Promise.all([
    prisma.user.findMany({
      orderBy: { name: 'asc' },
      include: {
        roles: { include: { role: { select: { id: true, name: true } } } },
        companies: { include: { company: { select: { id: true, name: true, code: true } } } },
      },
    }),
    prisma.role.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, description: true } }),
    prisma.company.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, code: true } }),
    prisma.agent.findMany({ where: { status: 'ACTIVE' }, orderBy: { agentName: 'asc' }, select: { id: true, agentName: true, company: { select: { code: true } } } }),
    prisma.warehouse.findMany({ where: { status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { id: true, name: true, company: { select: { code: true } } } }),
    prisma.applicationSetting.findMany({ where: { companyId: null, key: { startsWith: 'user_scope:' } }, select: { key: true, value: true } }),
  ]);
  const scopeOf = new Map(scopes.map((row) => [row.key.slice('user_scope:'.length), parseScope(row.value)]));
  const agentName = new Map(agents.map((a) => [a.id, a.agentName]));
  const warehouseName = new Map(warehouses.map((w) => [w.id, w.name]));

  const fields: FieldSpec[] = [
    { kind: 'section', title: 'Who', description: 'People sign in with their PIN alone — no email, no password.' },
    { kind: 'text', name: 'name', label: 'Full name', required: true, full: true },
    {
      kind: 'pin',
      name: 'pin',
      label: 'PIN',
      hint: 'Four digits, unique to this person. Blank on an existing user keeps their PIN.',
    },
    { kind: 'pin', name: 'confirmPin', label: 'Confirm PIN' },
    { kind: 'checkbox', name: 'isActive', label: 'Active', hint: 'A disabled account cannot sign in.' },

    { kind: 'section', title: 'Role', description: 'The role gives the default permissions; tick changes for this one person on their Permissions page.' },
    {
      kind: 'multicheck',
      name: 'roleIds',
      label: 'Role',
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

    {
      kind: 'section',
      title: 'Whose data',
      description: 'For an agent signing in for himself: link his agent record and he sees only his own ledger, customers, invoices and collections.',
    },
    {
      kind: 'select',
      name: 'agentId',
      label: 'Agent (own data only)',
      options: [{ value: '', label: 'Not an agent — sees what the role allows' }, ...agents.map((a) => ({ value: a.id, label: `${a.agentName} · ${a.company.code}` }))],
    },
    {
      kind: 'multicheck',
      name: 'warehouseIds',
      label: 'Assigned warehouses',
      hint: 'Leave all unticked for every warehouse.',
      options: warehouses.map((w) => ({ value: w.id, label: w.name, hint: w.company.code })),
      columns: 1,
    },
    {
      kind: 'checkbox',
      name: 'isSuperAdmin',
      label: 'Super Admin',
      hint: 'Bypasses every permission and company restriction. Grant sparingly.',
    },
  ];

  const rows: SimpleRow[] = users.map((u) => {
    const scope = scopeOf.get(u.id);
    const sees = [
      scope?.agentId ? `Own data of ${agentName.get(scope.agentId) ?? 'an agent'}` : null,
      scope?.warehouseIds.length ? scope.warehouseIds.map((id) => warehouseName.get(id) ?? 'a warehouse').join(', ') : null,
    ].filter(Boolean);
    return {
      id: u.id,
      title: u.name,
      searchText: `${u.name} ${u.roles.map((r) => r.role.name).join(' ')}`,
      data: {
        name: u.name,
        roles: u.isSuperAdmin ? 'Super Admin — all permissions' : u.roles.map((r) => r.role.name).join(', ') || 'No role',
        pin: u.pinHash ? 'Set' : 'Not set',
        scope: u.isSuperAdmin ? 'Everything' : sees.length ? sees.join(' · ') : 'What the role allows',
        companies: u.isSuperAdmin ? 'Every company' : u.companies.map((c) => c.company.code).join(', ') || 'None',
        lastLogin: u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never',
        status: !u.isActive ? 'Disabled' : u.isSuperAdmin ? 'Super Admin' : 'Active',
      },
      actions: [
        { label: 'Permissions', href: `/admin/users/${u.id}`, icon: 'view' as const },
        { label: 'Change PIN', href: `/admin/users/${u.id}#pin`, icon: 'edit' as const },
        { label: u.isActive ? 'Disable' : 'Enable', href: `/admin/users/${u.id}#status`, icon: 'edit' as const },
      ],
      formValues: {
        name: u.name,
        pin: '',
        confirmPin: '',
        isActive: u.isActive,
        isSuperAdmin: u.isSuperAdmin,
        roleIds: u.roles.map((r) => r.roleId).join(','),
        companyIds: u.companies.map((c) => c.companyId).join(','),
        defaultCompanyId: u.defaultCompanyId ?? '',
        agentId: scope?.agentId ?? '',
        warehouseIds: (scope?.warehouseIds ?? []).join(','),
      },
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & Roles"
        description="Everyone signs in with their own PIN — no email, no password. Every entry they make carries their name."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Users' }]}
      />

      <Callout tone="warning" title="Company access is a financial control">
        A user can only see and post into the companies assigned here, and the rule is enforced on the server, not just
        in the interface. Changing someone&rsquo;s access is recorded in the audit trail, and a new PIN signs that user
        out everywhere — the old PIN stops working at once.
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
