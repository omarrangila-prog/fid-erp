import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getBusinessOverview } from '@/lib/services/business-overview';
import { companyFlag } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Business Overview' };
export const dynamic = 'force-dynamic';

const TONE = {
  default: 'text-ink',
  positive: 'text-emerald-700',
  negative: 'text-red-600',
  warning: 'text-amber-700',
} as const;

export default async function BusinessOverviewPage() {
  const user = await requirePageAccess(PERMISSIONS.REPORTS_VIEW);

  const overview = await getBusinessOverview({
    companyId: user.activeCompany.id,
    localCurrency: user.activeCompany.localCurrency,
    showCost: can(user, PERMISSIONS.PURCHASE_COST_VIEW),
    showProfit: can(user, PERMISSIONS.PROFITS_VIEW),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Business Overview"
        description="The whole position on one screen. Every figure links to the report it comes from."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Business Overview' }]}
        meta={
          <>
            <Badge tone="neutral">
              {companyFlag(user.activeCompany.country)} {user.activeCompany.name}
            </Badge>
            <Badge tone="info">Local {user.activeCompany.localCurrency} · Group USD</Badge>
          </>
        }
      />

      {overview.sections.map((section) => (
        <Card key={section.title}>
          <CardHeader>
            <CardTitle>{section.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {section.figures.map((figure) => {
                const body = (
                  <>
                    <dt className="text-xs font-medium text-ink-muted">{figure.label}</dt>
                    <dd className={cn('tnum mt-1 text-lg font-semibold tracking-tight', TONE[figure.tone ?? 'default'])}>
                      {figure.currency && figure.currency !== 'KG' ? (
                        <span className="mr-1 text-xs font-medium text-ink-subtle">{figure.currency}</span>
                      ) : null}
                      {Number(figure.value).toLocaleString('en-US', {
                        minimumFractionDigits: figure.currency === 'KG' ? 0 : 2,
                        maximumFractionDigits: figure.currency === 'KG' ? 0 : 2,
                      })}
                      {figure.currency === 'KG' ? <span className="ml-1 text-xs text-ink-subtle">KG</span> : null}
                    </dd>
                    {figure.hint ? <p className="mt-0.5 text-[11px] text-ink-subtle">{figure.hint}</p> : null}
                  </>
                );

                return figure.href ? (
                  <Link
                    key={figure.label}
                    href={figure.href}
                    className="rounded-lg border border-line bg-paper p-3 transition-colors hover:border-forest-300 hover:bg-forest-50/40"
                  >
                    {body}
                  </Link>
                ) : (
                  <div key={figure.label} className="rounded-lg border border-line bg-paper p-3">
                    {body}
                  </div>
                );
              })}
            </dl>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
