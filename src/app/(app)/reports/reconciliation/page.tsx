import type { Metadata } from 'next';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { reconcile } from '@/lib/services/reconciliation';
import { companyFlag } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Callout } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Reconciliation' };
export const dynamic = 'force-dynamic';

export default async function ReconciliationPage() {
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const result = await reconcile(user.activeCompany.id);

  const groups = ['Accounting', 'Sub-ledgers', 'Inventory'] as const;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconciliation"
        description="Does the ledger agree with the operational records? Each check compares two figures produced by different code paths."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Reconciliation' }]}
        meta={
          <>
            <Badge tone="neutral">
              {companyFlag(user.activeCompany.country)} {user.activeCompany.name}
            </Badge>
            <Badge tone={result.healthy ? 'success' : 'danger'}>
              {result.passed} of {result.checks.length} passing
            </Badge>
          </>
        }
      />

      {result.healthy ? (
        <Callout tone="info" title="The books agree with themselves">
          Every control account matches its sub-ledger and every kilogram in a warehouse is explained by the movement
          ledger. These checks are recomputed each time this page loads — they are not cached.
        </Callout>
      ) : (
        <Callout tone="danger" title={`${result.failed} check${result.failed === 1 ? '' : 's'} failed`}>
          A failure here means two parts of the system disagree. Do not adjust a figure to make it match — find the
          transaction that caused the difference, because the same fault will keep producing wrong statements.
        </Callout>
      )}

      {groups.map((group) => {
        const checks = result.checks.filter((c) => c.group === group);
        if (checks.length === 0) return null;
        return (
          <Card key={group}>
            <CardHeader>
              <CardTitle>{group}</CardTitle>
              <CardDescription>
                {group === 'Accounting'
                  ? 'The double entry itself.'
                  : group === 'Sub-ledgers'
                    ? 'Control accounts against the detail behind them.'
                    : 'Stock records against the movement ledger.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {checks.map((check) => (
                <div
                  key={check.id}
                  className={cn(
                    'rounded-lg border p-4',
                    check.passed ? 'border-line bg-paper' : 'border-red-200 bg-red-50/50',
                  )}
                >
                  <div className="flex items-start gap-3">
                    {check.passed ? (
                      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-600" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink">{check.label}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{check.explanation}</p>

                      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div>
                          <dt className="text-[11px] text-ink-subtle">{check.left.label}</dt>
                          <dd className="tnum text-sm font-medium text-ink">{check.left.value}</dd>
                        </div>
                        <div>
                          <dt className="text-[11px] text-ink-subtle">{check.right.label}</dt>
                          <dd className="tnum text-sm font-medium text-ink">{check.right.value}</dd>
                        </div>
                        <div>
                          <dt className="text-[11px] text-ink-subtle">Difference</dt>
                          <dd
                            className={cn(
                              'tnum text-sm font-semibold',
                              check.passed ? 'text-emerald-700' : 'text-red-600',
                            )}
                          >
                            {check.differenceUsd}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
