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
import { PrintButton } from '@/components/shared/print-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';
import { ProfitabilityStatement } from './statement-view';
import { FavouriteStar } from '@/components/reports/report-statement';

export const metadata: Metadata = { title: 'Profitability' };
export const dynamic = 'force-dynamic';

const VIEWS = [
  { key: 'statement', label: 'Statement' },
  { key: 'shipment', label: 'By shipment' },
  { key: 'customer', label: 'By customer' },
  { key: 'product', label: 'By coffee' },
  { key: 'batch', label: 'By batch' },
  { key: 'container', label: 'By container' },
  { key: 'month', label: 'By month' },
] as const;

export default async function ProfitabilityPage({ searchParams }: { searchParams: Promise<{ view?: string; contract?: string }> }) {
  const { view, contract } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.PROFITS_VIEW);
  const companyId = user.activeCompany.id;
  const local = user.activeCompany.localCurrency;
  // "By contract" was the same rows as "By job"; both are now the one shipment view.
  const active = VIEWS.find((v) => v.key === (view === 'contract' ? 'shipment' : view))?.key ?? 'shipment';

  const summary = await getCompanyProfitSummary({ companyId });

  return (
    <div className="print-landscape space-y-6">
      <PageHeader
        title="Profitability"
        description="Margin measured only on coffee that has actually sold. Unsold stock stays on the balance sheet."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Profitability' }]}
        actions={
          <>
            <FavouriteStar href="/profitability" label="Shipment Profitability" />
            <ExportLinks href={exportHref('profitability', { view: active })} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader
        title="Profitability"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
        period={VIEWS.find((v) => v.key === active)?.label}
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

      <div className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong p-0.5" data-print="hide">
        {VIEWS.map((option) => (
          <Link
            key={option.key}
            href={`/profitability?view=${option.key}`}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              active === option.key ? 'bg-forest-800 text-white' : 'text-ink-muted hover:text-ink',
            )}
          >
            {option.label}
          </Link>
        ))}
      </div>

      {active === 'statement' ? <ProfitabilityStatement companyId={companyId} local={local} contractId={contract} /> : null}
      {active === 'shipment' ? <ShipmentTable companyId={companyId} local={local} lead="job" /> : null}
      {active === 'month' ? <MonthlyTable companyId={companyId} /> : null}
      {active !== 'statement' && active !== 'shipment' && active !== 'month' ? (
        <BreakdownTable companyId={companyId} kind={active} />
      ) : null}
    </div>
  );
}

async function ShipmentTable({
  companyId,
  local,
}: {
  companyId: string;
  local: string;
  lead?: 'job' | 'contract';
}) {
  const rows = await getShipmentProfitability({ companyId });

  /*
   * One shipment reference, one row.
   *
   * An order of three containers was shown as three "shipments" side by side,
   * each with only its own share of the sales. The client runs shipment-to-
   * shipment accounting: the order's reference is the shipment, and the
   * containers are its detail. Every figure on the parent is the sum of its
   * containers, each counted once.
   */
  type Row = (typeof rows)[number];
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.contractId, [...(groups.get(row.contractId) ?? []), row]);
  const add = (list: Row[], pick: (r: Row) => Parameters<typeof dec>[0]) => list.reduce((a, r) => a.plus(dec(pick(r))), dec(0));
  const tone = (value: ReturnType<typeof dec>) => (value.greaterThanOrEqualTo(0) ? 'text-gold-700' : 'text-red-600');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shipment profitability</CardTitle>
        <CardDescription>
          One row per shipment reference; open it for its containers. Sales follow the coffee each invoice line sold,
          wherever it was stored. Cost of sales is the landed cost of what sold, so shipment costs are never deducted twice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2" data-testid="shipment-profitability">
        {groups.size === 0 ? <p className="py-8 text-center text-xs text-ink-subtle">No approved shipments yet.</p> : null}
        {[...groups.values()].map((children) => {
          const first = children[0];
          const sold = add(children, (r) => r.soldQuantityKg);
          const purchased = add(children, (r) => r.purchaseQuantityKg);
          const remaining = add(children, (r) => r.remainingQuantityKg);
          const revenue = add(children, (r) => r.salesRevenueUsd);
          const revenueLocal = add(children, (r) => r.salesRevenueLocal);
          const cogs = add(children, (r) => r.allocatedLandedCostUsd);
          const cogsLocal = add(children, (r) => r.allocatedLandedCostLocal);
          const gross = add(children, (r) => r.grossProfitUsd);
          const grossLocal = add(children, (r) => r.grossProfitLocal);
          const other = add(children, (r) => r.otherCostsUsd);
          const net = add(children, (r) => r.netProfitUsd);
          const netLocal = add(children, (r) => r.netProfitLocal);
          const landed = add(children, (r) => r.totalLandedCostUsd);
          const stock = add(children, (r) => r.closingStockValueUsd);
          const items = [...new Set(children.map((r) => r.itemName))];
          return (
            <details key={first.contractId} className="rounded-xl border border-line" data-testid="shipment-profitability-row">
              <summary className="grid cursor-pointer list-none grid-cols-2 gap-3 px-4 py-3 text-sm sm:grid-cols-6">
                <span className="col-span-2 sm:col-span-2">
                  <span className="block font-semibold text-forest-800">{first.contractReference}</span>
                  <span className="block text-xs text-ink-subtle">
                    {children.length} {children.length === 1 ? 'container' : 'containers'} · {items.join(', ')}
                  </span>
                </span>
                <span className="tnum text-right">
                  <span className="block text-[11px] text-ink-subtle">Sold / bought</span>
                  {formatQuantityKg(sold)} of {formatQuantityKg(purchased)}
                  <span className="block text-xs text-ink-subtle">{formatQuantityKg(remaining)} left</span>
                </span>
                <span className="tnum text-right">
                  <span className="block text-[11px] text-ink-subtle">Sales</span>
                  {formatMoney(revenueLocal, local)}
                  <span className="block text-xs text-ink-subtle">{formatMoney(revenue, 'USD')}</span>
                </span>
                <span className="tnum text-right">
                  <span className="block text-[11px] text-ink-subtle">Cost of what sold</span>
                  {formatMoney(cogsLocal, local)}
                  <span className="block text-xs text-ink-subtle">{formatMoney(cogs, 'USD')}</span>
                </span>
                <span className={cn('tnum text-right font-semibold', tone(net))}>
                  <span className="block text-[11px] font-normal text-ink-subtle">Profit</span>
                  {formatMoney(netLocal, local)}
                  <span className="block text-xs font-normal text-ink-subtle">
                    {formatMoney(net, 'USD')} · {revenue.greaterThan(0) ? formatPercent(net.dividedBy(revenue).times(100)) : '—'}
                  </span>
                </span>
              </summary>
              <div className="space-y-2 border-t border-line px-4 py-3">
                <p className="text-xs text-ink-muted">
                  Landed cost {formatMoney(landed, 'USD')} · gross profit {formatMoney(grossLocal, local)} ({formatMoney(gross, 'USD')}) ·
                  costs not added to the coffee {formatMoney(other, 'USD')} · stock left carried at {formatMoney(stock, 'USD')}.{' '}
                  <Link href={`/reports/shipment-cost`} className="underline underline-offset-2">Full costing and FX</Link>
                </p>
                <TableWrap>
                  <Table>
                    <THead>
                      <TR className="hover:bg-transparent">
                        <TH>Container</TH>
                        <TH>Coffee</TH>
                        <TH>Status</TH>
                        <TH numeric>Bought</TH>
                        <TH numeric>Sold</TH>
                        <TH numeric>Left</TH>
                        <TH numeric>Sales</TH>
                        <TH numeric>Cost of what sold</TH>
                        <TH numeric>Profit</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {children.map((row, index) => (
                        <TR key={row.shipmentId}>
                          <TD>
                            <Link href={`/shipments/${row.shipmentId}`} className="font-medium text-forest-800 hover:text-gold-700">
                              Container {index + 1}
                            </Link>
                          </TD>
                          <TD>{row.itemName}</TD>
                          <TD>
                            <StatusBadge status={row.status} meta={SHIPMENT_STATUS_META} />
                          </TD>
                          <TD numeric>{formatQuantityKg(row.purchaseQuantityKg)}</TD>
                          <TD numeric>{formatQuantityKg(row.soldQuantityKg)}</TD>
                          <TD numeric className="text-ink-muted">{formatQuantityKg(row.remainingQuantityKg)}</TD>
                          <TD numeric>
                            {formatMoney(row.salesRevenueLocal, local)}
                            <span className="block text-xs text-ink-subtle">{formatMoney(row.salesRevenueUsd, 'USD')}</span>
                          </TD>
                          <TD numeric className="text-ink-muted">
                            {formatMoney(row.allocatedLandedCostLocal, local)}
                            <span className="block text-xs">{formatMoney(row.allocatedLandedCostUsd, 'USD')}</span>
                          </TD>
                          <TD numeric className={cn('font-semibold', tone(row.netProfitUsd))}>
                            {formatMoney(row.netProfitLocal, local)}
                            <span className="block text-xs font-normal text-ink-subtle">{formatMoney(row.netProfitUsd, 'USD')}</span>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                    <TFoot>
                      <tr>
                        <TD colSpan={3}>Shipment total</TD>
                        <TD numeric>{formatQuantityKg(purchased)}</TD>
                        <TD numeric>{formatQuantityKg(sold)}</TD>
                        <TD numeric>{formatQuantityKg(remaining)}</TD>
                        <TD numeric>{formatMoney(revenueLocal, local)}</TD>
                        <TD numeric>{formatMoney(cogsLocal, local)}</TD>
                        <TD numeric>{formatMoney(netLocal, local)}</TD>
                      </tr>
                    </TFoot>
                  </Table>
                </TableWrap>
              </div>
            </details>
          );
        })}
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
            <TableWrap className="rounded-none border-0 border-t" data-wide-sheet>
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
                      className={cn('font-semibold', row.grossProfitUsd.greaterThanOrEqualTo(0) ? 'text-gold-700' : 'text-red-600')}
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
            <TableWrap className="rounded-none border-0 border-t" data-wide-sheet>
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
                  <TD numeric className={row.grossProfitUsd.greaterThanOrEqualTo(0) ? 'text-gold-700' : 'text-red-600'}>
                    {formatMoney(row.grossProfitUsd, 'USD')}
                  </TD>
                  <TD numeric className="text-ink-muted">{formatMoney(row.expensesUsd, 'USD')}</TD>
                  <TD
                    numeric
                    className={cn('font-semibold', row.netProfitUsd.greaterThanOrEqualTo(0) ? 'text-gold-700' : 'text-red-600')}
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
