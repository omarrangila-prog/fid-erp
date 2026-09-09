import type { Metadata } from 'next';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DetailRow } from '@/components/shared/stat-card';
import { ChangePasswordCard } from '@/app/(app)/account/account-client';

export const metadata: Metadata = { title: 'My Account' };
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await requireUser();

  const [record, sessionCount] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { lastLoginAt: true, createdAt: true },
    }),
    prisma.session.count({ where: { userId: user.id, expiresAt: { gt: new Date() } } }),
  ]);

  const permissionCount = user.isSuperAdmin ? 'Every permission' : `${user.permissions.size} permissions`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Account"
        description="Your profile, access and password."
        breadcrumbs={[{ label: 'Account' }]}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>Managed by your administrator.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label="Name">{user.name}</DetailRow>
              <DetailRow label="Email">{user.email}</DetailRow>
              <DetailRow label="Roles">
                {user.isSuperAdmin ? (
                  <Badge tone="info">Super Admin</Badge>
                ) : user.roleNames.length > 0 ? (
                  <span className="flex flex-wrap justify-end gap-1">
                    {user.roleNames.map((role) => (
                      <Badge key={role} tone="neutral">
                        {role}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  'No role assigned'
                )}
              </DetailRow>
              <DetailRow label="Permissions">{permissionCount}</DetailRow>
              <DetailRow label="Last sign-in">
                {record.lastLoginAt ? formatDateTime(record.lastLoginAt) : 'This is your first session'}
              </DetailRow>
              <DetailRow label="Active sessions">{sessionCount}</DetailRow>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Company access</CardTitle>
            <CardDescription>The books you are allowed to open.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl>
              {user.companies.map((company) => (
                <DetailRow key={company.id} label={company.name}>
                  <span className="flex items-center justify-end gap-2">
                    <span className="text-xs text-ink-subtle">{company.localCurrency}</span>
                    {company.id === user.activeCompany.id ? <Badge tone="success">Current</Badge> : null}
                  </span>
                </DetailRow>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>

      <ChangePasswordCard />
    </div>
  );
}
