import type { Metadata } from 'next';
import Link from 'next/link';
import { ShieldAlert, ArrowLeft } from 'lucide-react';
import { requireUser } from '@/lib/auth/session';
import { PERMISSION_DESCRIPTIONS, type PermissionCode } from '@/lib/constants';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export const metadata: Metadata = { title: 'Not authorised' };
export const dynamic = 'force-dynamic';

export default async function UnauthorizedPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>;
}) {
  const { permission } = await searchParams;
  const user = await requireUser();
  const detail = permission ? PERMISSION_DESCRIPTIONS[permission as PermissionCode] : undefined;

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center">
      <div className="grid size-12 place-items-center rounded-xl border border-amber-200 bg-amber-50 text-amber-700">
        <ShieldAlert className="size-6" />
      </div>

      <h1 className="mt-5 text-xl font-semibold tracking-tight text-ink">You do not have access to this page</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
        Your account does not hold the permission this page requires. If you need it, ask an administrator to add it
        to your role.
      </p>

      {detail ? (
        <Card className="mt-6 w-full max-w-md text-left">
          <CardContent className="space-y-3 pt-5">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">Permission required</p>
              <p className="mt-1 text-sm font-medium text-ink">{detail.description}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{detail.module}</Badge>
                <code className="rounded bg-forest-50 px-1.5 py-0.5 text-[11px] text-ink-muted">{permission}</code>
              </div>
            </div>

            <div className="border-t border-line pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">Signed in as</p>
              <p className="mt-1 text-sm text-ink">{user.name}</p>
              <p className="text-xs text-ink-subtle">
                {user.isSuperAdmin ? 'Super Admin' : user.roleNames.join(', ') || 'No role assigned'} ·{' '}
                {user.activeCompany.name}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button variant="outline" asChild>
          <Link href="/dashboard">
            <ArrowLeft />
            Back to the dashboard
          </Link>
        </Button>
      </div>
    </div>
  );
}
