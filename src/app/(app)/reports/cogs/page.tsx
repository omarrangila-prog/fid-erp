import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getCogsReport } from '@/lib/services/profitability';
import { formatMoney, formatDate, formatQuantityKg, dayParam, companyToday } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { Metric, MetricGrid } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { PrintButton } from '@/components/shared/print-button';
import { ReportShareButton } from '@/components/share/report-share-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';
import { dec } from '@/lib/money';
import { Term } from '@/components/shared/term';
import { makeTerms } from '@/lib/terminology';

export const metadata: Metadata = { title: 'Cost of Goods Sold' };
export const dynamic = 'force-dynamic';

function startOfYear() {
  return new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
}

export default async function CogsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from, to } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.PROFITS_VIEW);
  const unit = makeTerms(user.activeCompany.terminology)('unit');
  const fromDate = dayParam(from) ?? startOfYear();
  // Today on the company's own clock, not the server's: Dubai is four hours ahead of UTC.
  const toDate = dayParam(to) ?? companyToday(user.activeCompany.timezone);

  const rows = await getCogsReport({
    companyId: user.activeCompany.id,
    from: fromDate,
    to: toDate,
  });

  const qty = rows.reduce((sum, row) => sum.plus(row.quantityKg), dec(0));
  const revenue = rows.reduce((sum, row) => sum.plus(row.revenueUsd), dec(0));
  const cogs = rows.reduce((sum, row) => sum.plus(row.cogsUsd), dec(0));
  const gp = revenue.minus(cogs);
  // The company's own currency, where a confirmed purchase rate moves the cost.
  const local = user.activeCompany.localCurrency;
  const showLocal = local !== 'USD';
  const revenueLocal = rows.reduce((sum, row) => sum.plus(row.revenueLocal), dec(0));
  const cogsLocal = rows.reduce((sum, row) => sum.plus(row.cogsLocal), dec(0));
  const gpLocal = revenueLocal.minus(cogsLocal);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cost of Goods Sold"
        description={`${user.activeCompany.name} · ${formatDate(fromDate)} to ${formatDate(toDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Cost of Goods Sold' }]}
        actions={
          <>
            <ExportLinks href={exportHref('cogs', { from, to })} />
            <PrintButton />
            <ReportShareButton report="cogs" />
          </>
        }
      />
      <PrintHeader
        title="Cost of Goods Sold"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      <DateRangePicker defaultFrom={fromDate.toISOString().slice(0, 10)} defaultTo={toDate.toISOString().slice(0, 10)} />

      <MetricGrid>
        <Metric label="Quantity sold" value={formatQuantityKg(qty)} />
        <Metric label="Revenue" value={showLocal ? formatMoney(revenueLocal, local) : formatMoney(revenue, 'USD')} hint={showLocal ? formatMoney(revenue, 'USD') : undefined} />
        <Metric label="COGS" value={showLocal ? formatMoney(cogsLocal, local) : formatMoney(cogs, 'USD')} hint={showLocal ? formatMoney(cogs, 'USD') : undefined} />
        <Metric
          label={(showLocal ? gpLocal : gp).isNegative() ? 'Gross loss' : 'Gross profit'}
          value={showLocal ? formatMoney(gpLocal, local) : formatMoney(gp, 'USD')}
          hint={showLocal ? formatMoney(gp, 'USD') : undefined}
          tone={(showLocal ? gpLocal : gp).greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
        />
      </MetricGrid>

      {rows.length === 0 ? (
        <EmptyState title="Nothing sold in this period" description="Posted invoices freeze cost of goods on each line." />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Sold lines</CardTitle>
            <CardDescription>
              In {showLocal ? local : 'USD'}: revenue as invoiced, cost at each batch&rsquo;s landed cost — the coffee at
              its order&rsquo;s rate, the rate actually paid once confirmed — the same figures as Shipment Profitability.
              {showLocal ? ' The USD beneath each is the cost frozen on the invoice when it was posted.' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Invoice</TH>
                    <TH>Customer</TH>
                    <TH>Coffee</TH>
                    <TH><Term k="orderRef" /></TH>
                    <TH>Batch</TH>
                    <TH>Warehouse</TH>
                    <TH numeric>{unit}</TH>
                    <TH numeric>Revenue</TH>
                    <TH numeric>COGS</TH>
                    <TH numeric>Gross profit</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row, index) => (
                    <TR key={`${row.invoiceId}-${index}`}>
                      <TD>{formatDate(row.invoiceDate)}</TD>
                      <TD>
                        <Link
                          href={row.source === 'CREDIT' ? `/sales/credit-notes/${row.invoiceId}` : `/sales/${row.invoiceId}`}
                          className="font-medium hover:underline"
                        >
                          {row.invoiceNumber}
                        </Link>
                      </TD>
                      <TD>{row.customerName}</TD>
                      <TD>{row.itemName}</TD>
                      <TD className="text-xs font-medium text-forest-800">{row.contractReference}</TD>
                      <TD className="font-mono text-xs">{row.batchNumber}</TD>
                      <TD className="text-ink-muted">{row.warehouseName ?? '—'}</TD>
                      <TD numeric>{formatQuantityKg(row.quantityKg)}</TD>
                      <TD numeric>
                        <Pair local={showLocal ? row.revenueLocal : null} usd={row.revenueUsd} currency={local} />
                      </TD>
                      <TD numeric className="text-ink-muted">
                        <Pair local={showLocal ? row.cogsLocal : null} usd={row.cogsUsd} currency={local} />
                      </TD>
                      <TD
                        numeric
                        className={(showLocal ? row.grossProfitLocal : row.grossProfitUsd).greaterThanOrEqualTo(0) ? 'text-gold-700' : 'text-red-600'}
                      >
                        <Pair local={showLocal ? row.grossProfitLocal : null} usd={row.grossProfitUsd} currency={local} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <tr>
                    <TD colSpan={7}>Total</TD>
                    <TD numeric>{formatQuantityKg(qty)}</TD>
                    <TD numeric>
                      <Pair local={showLocal ? revenueLocal : null} usd={revenue} currency={local} />
                    </TD>
                    <TD numeric>
                      <Pair local={showLocal ? cogsLocal : null} usd={cogs} currency={local} />
                    </TD>
                    <TD numeric>
                      <Pair local={showLocal ? gpLocal : null} usd={gp} currency={local} />
                    </TD>
                  </tr>
                </TFoot>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** The company's currency above, the dollars beneath; dollars alone for a USD company. */
function Pair({ local, usd, currency }: { local: ReturnType<typeof dec> | null; usd: ReturnType<typeof dec>; currency: string }) {
  if (!local) return <>{formatMoney(usd, 'USD')}</>;
  return (
    <span className="inline-block">
      <span className="tnum block">{formatMoney(local, currency)}</span>
      <span className="tnum block text-[11px] text-ink-subtle">{formatMoney(usd, 'USD')}</span>
    </span>
  );
}
