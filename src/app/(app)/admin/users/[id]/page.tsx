import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS, ALL_PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatDateTime } from '@/lib/format';
import { applyOverrides } from '@/lib/user-access';
import { getUserAccess } from '@/lib/services/user-access';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { RoleGrid } from '@/app/(app)/admin/roles/[id]/role-grid';
import { saveUserPermissionsAction } from '@/server/actions/admin-actions';
import { UserPinForm, UserStatusButton } from '@/app/(app)/admin/users/[id]/user-controls';

export const metadata: Metadata = { title: 'User access' };
export const dynamic = 'force-dynamic';

/**
 * One person: their PIN, whether they can sign in, and what they may do —
 * their role's permissions, with anything ticked differently for them alone.
 */
export default async function UserAccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = await requirePageAccess(PERMISSIONS.USERS_MANAGE);
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      roles: { include: { role: { include: { permissions: { select: { permission: { select: { code: true } } } } } } } },
      companies: { include: { company: { select: { code: true } } } },
    },
  });
  if (!user) notFound();

  const { overrides, scope } = await getUserAccess(user.id);
  const role = [...new Set(user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.code)))];
  const effective = [...applyOverrides(role, overrides, new Set<string>(ALL_PERMISSIONS))];
  const [agent, warehouses] = await Promise.all([
    scope.agentId ? prisma.agent.findUnique({ where: { id: scope.agentId }, select: { agentName: true } }) : null,
    scope.warehouseIds.length ? prisma.warehouse.findMany({ where: { id: { in: scope.warehouseIds } }, select: { name: true } }) : [],
  ]);
  const roleNames = user.roles.map((r) => r.role.name).join(', ') || 'No role';

  return (
    <div className="space-y-6">
      <PageHeader
        title={user.name}
        description={`${user.isSuperAdmin ? 'Super Admin' : roleNames} · ${user.isSuperAdmin ? 'every company' : user.companies.map((c) => c.company.code).join(', ')} · last signed in ${user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'never'}`}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Users', href: '/admin/users' }, { label: user.name }]}
        meta={
          <>
            <Badge tone={user.isActive ? 'success' : 'danger'} data-testid="user-status">
              {user.isActive ? 'Active' : 'Disabled'}
            </Badge>
            <Badge tone={user.pinHash ? 'success' : 'warning'}>{user.pinHash ? 'PIN set' : 'No PIN'}</Badge>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card id="pin">
          <CardHeader>
            <CardTitle>Change PIN</CardTitle>
            <CardDescription>
              The old PIN stops working the moment this is saved, and {user.name.split(/\s+/)[0]} is signed out everywhere.
              Nobody — not even here — can see a PIN once it is set.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UserPinForm userId={user.id} />
          </CardContent>
        </Card>
        <Card id="status">
          <CardHeader>
            <CardTitle>Access</CardTitle>
            <CardDescription>
              {user.isActive ? 'Can sign in.' : 'Disabled: the PIN does nothing until the account is enabled again.'}
              {agent ? ` Sees only his own data as ${agent.agentName}.` : ''}
              {warehouses.length ? ` Warehouses: ${warehouses.map((w) => w.name).join(', ')}.` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {user.id === admin.id ? (
              <p className="text-sm text-ink-muted">This is your own account; it cannot be disabled from here.</p>
            ) : (
              <UserStatusButton userId={user.id} active={user.isActive} />
            )}
          </CardContent>
        </Card>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Permissions</h2>
        {user.isSuperAdmin ? (
          <Callout tone="info" title="Super Admin">
            A Super Admin has every permission in every company; there is nothing to tick.
          </Callout>
        ) : (
          <>
            <p className="text-xs text-ink-muted">
              Ticked from the role ({roleNames}). Change any box for {user.name.split(/\s+/)[0]} alone — a gold dot marks a
              box that differs from the role. It takes effect on their next page; the PIN stays the same. Every page and
              action is checked on the server, so an unticked Delete is refused even from a direct link.
            </p>
            <RoleGrid
              save={saveUserPermissionsAction.bind(null, user.id)}
              granted={effective}
              baseline={role}
              permissions={ALL_PERMISSIONS.map((code) => ({ code, description: PERMISSION_DESCRIPTIONS[code]?.description ?? code }))}
            />
          </>
        )}
      </section>
    </div>
  );
}
