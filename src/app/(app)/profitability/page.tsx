import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS, SHIPMENT_STATUS_META } from '@/lib/constants';
import {
  getShipmentProfitability,
  getCustomerProfitability,
  getProductProfitability,
  getBatchProfitability,
  getContainerProfitability,
  getMonthlyProfitability,
  getCompanyProfitSummary,
} from '@/lib/services/profitability';
import { dec } from '@/lib/money';
import { formatMoney, formatQuantityKg, formatPercent } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Callout } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Profitability' };
export const dynamic = 'force-dynamic';

const VIEWS = [
  { key: 'shipment', label: 'By job' },
  { key: 'customer', label: 'By customer' },
  { key: 'product', label: 'By coffee' },
  { key: 'batch', label: 'By batch' },
  { key: 'container', label: 'By container' },
  { key: 'month', label: 'By month' },
] as const;

export default async function ProfitabilityPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.PROFITS_VIEW);
  const companyId = user.activeCompany.id;
  const active = VIEWS.find((v) => v.key === view)?.key ?? 'shipment';

  const summary = await getCompanyProfitSummary({ companyId });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Profitability"
        description="Margin measured only on coffee that has actually sold. Unsold stock stays on the balance sheet."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Profitability' }]}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Sales revenue" value={formatMoney(summary.revenueUsd, 'USD')} />
        <StatCard label="Cost of goods sold" value={formatMoney(summary.cogsUsd, 'USD')} />
        <StatCard
          label="Gross profit"
          value={formatMoney(summary.grossProfitUsd, 'USD')}
          sublabel={`${formatPercent(summary.grossMarginPct)} margin`}
          tone={summary.grossProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
        />
        <StatCard
          label="Net profit"
          value={formatMoney(summary.netProfitUsd, 'USD')}
          sublabel={`${formatPercent(summary.netMarginPct)} margin`}
          tone={summary.netProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
        />
        <StatCard
          label="Profit per KG"
          value={formatMoney(summary.profitPerKgUsd, 'USD')}
          sublabel={`on ${formatQuantityKg(summary.soldKg)} sold`}
        />
      </div>

      <Callout tone="info" title="How these figures are built">
        Freight and direct shipment costs are already inside each batch&rsquo;s landed cost, so they reach profit
        through cost of goods sold and are never deducted twice. Only genuine period costs — bank charges, agent
        commission, storage — appear separately as other costs.
      </Callout>

      <div className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong p-0.5">
        {VIEWS.map((option) => (
          <Link
            key={option.key}
            href={`/profitability?view=${option.key}`}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              active === option.key ? 'bg-navy-800 text-white' : 'text-ink-muted hover:text-ink',
            )}
          >
            {option.label}
          </Link>
        ))}
      </div>

      {active === 'shipment' ? <ShipmentTable companyId={companyId} /> : null}
      {active === 'month' ? <MonthlyTable companyId={companyId} /> : null}
      {active !== 'shipment' && active !== 'month' ? <BreakdownTable companyId={companyId} kind={active} /> : null}
    </div>
  );
}

async function ShipmentTable({ companyId }: { companyId: string }) {
  const rows = await getShipmentProfitability({ companyId });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Job profitability</CardTitle>
        <CardDescription>Each job is a purchase contract, its containers and everything sold from it.</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <TableWrap className="rounded-none border-0 border-t">
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Job</TH>
                <TH>Coffee</TH>
                <TH>Status</TH>
                <TH numeric>Sold</TH>
                <TH numeric>Remaining</TH>
                <TH numeric>Revenue</TH>
                <TH numeric>Landed cost</TH>
                <TH numeric>Gross profit</TH>
                <TH numeric>Other costs</TH>
                <TH numeric>Net profit</TH>
                <TH numeric>Per KG</TH>
                <TH numeric>Margin</TH>
              </TR>
            </THead>
            <TBody>
              {rows.length === 0 ? (
                <TR>
                  <TD colSpan={12} className="py-8 text-center text-xs text-ink-subtle">
                    No approved jobs yet.
                  </TD>
                </TR>
              ) : (
                rows.map((row) => (
                  <TR key={row.shipmentId}>
                    <TD>
                      <Link href={`/shipments/${row.shipmentId}`} className="font-medium text-navy-800 hover:text-teal-700">
                        <span className="block">{row.shipmentNumber}</span>
                        <span className="block text-xs font-normal text-ink-subtle">{row.jobNumber}</span>
                      </Link>
                    </TD>
                    <TD>{row.itemName}</TD>
                    <TD>
                      <StatusBadge status={row.status} meta={SHIPMENT_STATUS_META} />
                    </TD>
                    <TD numeric>{formatQuantityKg(row.soldQuantityKg)}</TD>
                    <TD numeric className="text-ink-muted">{formatQuantityKg(row.remainingQuantityKg)}</TD>
                    <TD numeric>{formatMoney(row.salesRevenueUsd, 'USD')}</TD>
                    <TD numeric className="text-ink-muted">{formatMoney(row.allocatedLandedCostUsd, 'USD')}</TD>
                    <TD numeric className={row.grossProfitUsd.greaterThanOrEqualTo(0) ? 'text-teal-700' : 'text-red-600'}>
                      {formatMoney(row.grossProfitUsd, 'USD')}
                    </TD>
                    <TD numeric className="text-ink-muted">{formatMoney(row.otherCostsUsd, 'USD')}</TD>
                    <TD
                      numeric
                      className={cn('font-semibold', row.netProfitUsd.greaterThanOrEqualTo(0) ? 'text-teal-700' : 'text-red-600')}
                    >
                      {formatMoney(row.netProfitUsd, 'USD')}
                    </TD>
                    <TD numeric>{formatMoney(row.profitPerKgUsd, 'USD')}</TD>
                    <TD numeric>{formatPercent(row.netMarginPct)}</TD>
                  </TR>
                ))
              )}
            </TBody>
            <TFoot>
              <tr>
                <TD colSpan={5}>Total</TD>
                <TD numeric>{formatMoney(rows.reduce((a, r) => a.plus(r.salesRevenueUsd), dec(0)), 'USD')}</TD>
                <TD numeric>{formatMoney(rows.reduce((a, r) => a.plus(r.allocatedLandedCostUsd), dec(0)), 'USD')}</TD>
                <TD numeric>{formatMoney(rows.reduce((a, r) => a.plus(r.grossProfitUsd), dec(0)), 'USD')}</TD>
                <TD numeric>{formatMoney(rows.reduce((a, r) => a.plus(r.otherCostsUsd), dec(0)), 'USD')}</TD>
                <TD numeric>{formatMoney(rows.reduce((a, r) => a.plus(r.netProfitUsd), dec(0)), 'USD')}</TD>
                <TD colSpan={2} />
              </tr>
            </TFoot>
          </Table>
        </TableWrap>
      </CardContent>
    </Card>
  );
}

async function BreakdownTable({
  companyId,
  kind,
}: {
  companyId: string;
  kind: 'customer' | 'product' | 'batch' | 'container';
}) {
  const rows =
    kind === 'customer'
      ? await getCustomerProfitability({ companyId })
      : kind === 'product'
        ? await getProductProfitability({ companyId })
        : kind === 'batch'
          ? await getBatchProfitability({ companyId })
          : await getContainerProfitability({ companyId });

  const labels = { customer: 'Customer', product: 'Coffee', batch: 'Batch', container: 'Container' } as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Margin by {labels[kind].toLowerCase()}</CardTitle>
        <CardDescription>Based on cost of goods frozen on each invoice line at the moment it was posted.</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <TableWrap className="rounded-none border-0 border-t">
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>{labels[kind]}</TH>
                <TH numeric>Quantity</TH>
                <TH numeric>Revenue</TH>
                <TH numeric>Cost</TH>
                <TH numeric>Gross profit</TH>
                <TH numeric>Per KG</TH>
                <TH numeric>Margin</TH>
              </TR>
            </THead>
            <TBody>
              {rows.length === 0 ? (
                <TR>
                  <TD colSpan={7} className="py-8 text-center text-xs text-ink-subtle">
                    Nothing sold yet.
                  </TD>
                </TR>
              ) : (
                rows.map((row) => (
                  <TR key={row.key}>
                    <TD>
                      <span className="block font-medium">{row.label}</span>
                      {row.sublabel ? <span className="block text-xs text-ink-subtle">{row.sublabel}</span> : null}
                    </TD>
                    <TD numeric>{formatQuantityKg(row.quantityKg)}</TD>
                    <TD numeric>{formatMoney(row.revenueUsd, 'USD')}</TD>
                    <TD numeric className="text-ink-muted">{formatMoney(row.cogsUsd, 'USD')}</TD>
                    <TD
                      numeric
                      className={cn('font-semibold', row.grossProfitUsd.greaterThanOrEqualTo(0) ? 'text-teal-700' : 'text-red-600')}
                    >
                      {formatMoney(row.grossProfitUsd, 'USD')}
                    </TD>
                    <TD numeric>{formatMoney(row.profitPerKgUsd, 'USD')}</TD>
                    <TD numeric>{formatPercent(row.grossMarginPct)}</TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </TableWrap>
      </CardContent>
    </Card>
  );
}

async function MonthlyTable({ companyId }: { companyId: string }) {
  const rows = await getMonthlyProfitability({ companyId, months: 12 });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly profitability</CardTitle>
        <CardDescription>The last twelve months, in USD.</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <TableWrap className="rounded-none border-0 border-t">
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Month</TH>
                <TH numeric>Revenue</TH>
                <TH numeric>Cost of goods</TH>
                <TH numeric>Gross profit</TH>
                <TH numeric>Expenses</TH>
                <TH numeric>Net profit</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.month}>
                  <TD className="font-medium">{row.month}</TD>
                  <TD numeric>{formatMoney(row.revenueUsd, 'USD')}</TD>
                  <TD numeric className="text-ink-muted">{formatMoney(row.cogsUsd, 'USD')}</TD>
                  <TD numeric className={row.grossProfitUsd.greaterThanOrEqualTo(0) ? 'text-teal-700' : 'text-red-600'}>
                    {formatMoney(row.grossProfitUsd, 'USD')}
                  </TD>
                  <TD numeric className="text-ink-muted">{formatMoney(row.expensesUsd, 'USD')}</TD>
                  <TD
                    numeric
                    className={cn('font-semibold', row.netProfitUsd.greaterThanOrEqualTo(0) ? 'text-teal-700' : 'text-red-600')}
                  >
                    {formatMoney(row.netProfitUsd, 'USD')}
                  </TD>
                </TR>
              ))}
            </TBody>
            <TFoot>
              <tr>
                <TD>Total</TD>
                <TD numeric>{formatMoney(rows.reduce((a, r) => a.plus(r.revenueUsd), dec(0)), 'USD')}</TD>
                <TD numeric>{formatMoney(rows.reduce((a, r) => a.plus(r.cogsUsd), dec(0)), 'USD')}</TD>
                <TD numeric>{formatMoney(rows.reduce((a, r) => a.plus(r.grossProfitUsd), dec(0)), 'USD')}</TD>
                <TD numeric>{formatMoney(rows.reduce((a, r) => a.plus(r.expensesUsd), dec(0)), 'USD')}</TD>
                <TD numeric>{formatMoney(rows.reduce((a, r) => a.plus(r.netProfitUsd), dec(0)), 'USD')}</TD>
              </tr>
            </TFoot>
          </Table>
        </TableWrap>
      </CardContent>
    </Card>
  );
}
