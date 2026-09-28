import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS, ALL_PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { RoleGrid } from '@/app/(app)/admin/roles/[id]/role-grid';
import { saveRolePermissionsAction } from '@/server/actions/admin-actions';
import { RoleMenu } from '@/app/(app)/admin/roles/[id]/role-menu';
import { getRoleMenu } from '@/lib/services/role-menu';

export const metadata: Metadata = { title: 'Role permissions' };
export const dynamic = 'force-dynamic';

/** One role's permissions as a grid: pages down, View / Create / Edit / Delete across. */
export default async function RolePermissionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageAccess(PERMISSIONS.ROLES_MANAGE);
  const role = await prisma.role.findUnique({
    where: { id },
    include: { permissions: { select: { permission: { select: { code: true } } } }, _count: { select: { users: true } } },
  });
  if (!role) notFound();
  const menu = await getRoleMenu(role.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${role.name} — permissions`}
        description={`${role._count.users} ${role._count.users === 1 ? 'user has' : 'users have'} this role. Tick what it may do; every page and action is checked on the server, so an unticked Delete is refused even from a direct link.`}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Roles', href: '/admin/roles' }, { label: role.name }]}
      />
      <RoleGrid
        save={saveRolePermissionsAction.bind(null, role.id)}
        granted={role.permissions.map((p) => p.permission.code)}
        permissions={ALL_PERMISSIONS.map((code) => ({ code, description: PERMISSION_DESCRIPTIONS[code]?.description ?? code }))}
      />
      <RoleMenu roleId={role.id} initial={menu} />
    </div>
  );
}
