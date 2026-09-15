import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getCogsReport } from '@/lib/services/profitability';
import { formatMoney, formatDate, formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { Metric, MetricGrid } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { PrintButton } from '@/components/shared/print-button';
import { ExcelLink, exportHref } from '@/components/shared/excel-link';
import { PrintHeader } from '@/components/shared/print-header';
import { dec } from '@/lib/money';

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
  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : startOfYear();
  const toDate = to ? new Date(`${to}T00:00:00.000Z`) : new Date();

  const rows = await getCogsReport({
    companyId: user.activeCompany.id,
    from: fromDate,
    to: toDate,
  });

  const qty = rows.reduce((sum, row) => sum.plus(row.quantityKg), dec(0));
  const revenue = rows.reduce((sum, row) => sum.plus(row.revenueUsd), dec(0));
  const cogs = rows.reduce((sum, row) => sum.plus(row.cogsUsd), dec(0));
  const gp = revenue.minus(cogs);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cost of Goods Sold"
        description={`${user.activeCompany.name} · ${formatDate(fromDate)} to ${formatDate(toDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Cost of Goods Sold' }]}
        actions={
          <>
            <ExcelLink href={exportHref('cogs', { from, to })} />
            <PrintButton />
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
        <Metric label="Revenue" value={formatMoney(revenue, 'USD')} />
        <Metric label="COGS" value={formatMoney(cogs, 'USD')} />
        <Metric
          label="Gross profit"
          value={formatMoney(gp, 'USD')}
          tone={gp.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
        />
      </MetricGrid>

      {rows.length === 0 ? (
        <EmptyState title="Nothing sold in this period" description="Posted invoices freeze cost of goods on each line." />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Sold lines</CardTitle>
            <CardDescription>
              Cost is the batch landed cost at the moment the invoice was posted, not a later revaluation.
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
                    <TH>Batch</TH>
                    <TH>Warehouse</TH>
                    <TH numeric>KG</TH>
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
                      <TD className="font-mono text-xs">{row.batchNumber}</TD>
                      <TD className="text-ink-muted">{row.warehouseName ?? '—'}</TD>
                      <TD numeric>{formatQuantityKg(row.quantityKg)}</TD>
                      <TD numeric>{formatMoney(row.revenueUsd, 'USD')}</TD>
                      <TD numeric className="text-ink-muted">{formatMoney(row.cogsUsd, 'USD')}</TD>
                      <TD numeric className={row.grossProfitUsd.greaterThanOrEqualTo(0) ? 'text-gold-700' : 'text-red-600'}>
                        {formatMoney(row.grossProfitUsd, 'USD')}
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <tr>
                    <TD colSpan={6}>Total</TD>
                    <TD numeric>{formatQuantityKg(qty)}</TD>
                    <TD numeric>{formatMoney(revenue, 'USD')}</TD>
                    <TD numeric>{formatMoney(cogs, 'USD')}</TD>
                    <TD numeric>{formatMoney(gp, 'USD')}</TD>
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
