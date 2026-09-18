import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getForexGainLoss } from '@/lib/services/reports';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { Metric, MetricGrid } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { PrintButton } from '@/components/shared/print-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';

export const metadata: Metadata = { title: 'Forex Gain / Loss' };
export const dynamic = 'force-dynamic';

function startOfYear() {
  return new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
}

export default async function ForexGainLossPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from, to } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const local = user.activeCompany.localCurrency;
  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : startOfYear();
  const toDate = to ? new Date(`${to}T00:00:00.000Z`) : new Date();

  const report = await getForexGainLoss({
    companyId: user.activeCompany.id,
    from: fromDate,
    to: toDate,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Forex Gain / Loss"
        description={`${user.activeCompany.name} · ${formatDate(fromDate)} to ${formatDate(toDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Forex Gain / Loss' }]}
        actions={
          <>
            <ExportLinks href={exportHref('forex', { from, to })} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader
        title="Forex Gain / Loss"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      <DateRangePicker defaultFrom={fromDate.toISOString().slice(0, 10)} defaultTo={toDate.toISOString().slice(0, 10)} />

      <Callout tone="info" title="The original purchase is never rewritten">
        A vendor bill booked at one rate and paid at another posts only the difference here. The coffee cost stays at
        the rate on the purchase order.
      </Callout>

      <MetricGrid>
        <Metric label="Gains (USD)" value={formatMoney(report.gainUsd, 'USD')} tone="positive" />
        <Metric label="Losses (USD)" value={formatMoney(report.lossUsd, 'USD')} tone="negative" />
        <Metric
          label="Net (USD)"
          value={formatMoney(report.netUsd, 'USD')}
          tone={report.netUsd.greaterThan(0) ? 'negative' : 'positive'}
          hint="Positive is a net loss — this is an expense account."
        />
        <Metric label={`Net (${local})`} value={formatMoney(report.netLocal, local)} />
      </MetricGrid>

      {!report.account ? (
        <EmptyState title="No forex account" description="The chart of accounts is created when a company is set up." />
      ) : report.rows.length === 0 ? (
        <EmptyState
          title="No exchange differences in this period"
          description="Differences appear when a foreign-currency payment uses a different rate from the original bill."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {report.account.name}
            </CardTitle>
            <CardDescription>Debit is a loss, credit is a gain.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Voucher</TH>
                    <TH>Source</TH>
                    <TH>Description</TH>
                    <TH numeric>Loss USD</TH>
                    <TH numeric>Gain USD</TH>
                    <TH numeric>Loss {local}</TH>
                    <TH numeric>Gain {local}</TH>
                  </TR>
                </THead>
                <TBody>
                  {report.rows.map((row) => (
                    <TR key={`${row.entryId}-${row.entryNumber}`}>
                      <TD>{formatDate(row.entryDate)}</TD>
                      <TD>
                        <Link
                          href={`/reports/journal?q=${encodeURIComponent(row.entryNumber)}&from=${fromDate.toISOString().slice(0, 10)}&to=${toDate.toISOString().slice(0, 10)}`}
                          className="font-medium hover:underline"
                        >
                          {row.entryNumber}
                        </Link>
                      </TD>
                      <TD className="text-xs text-ink-muted">{row.sourceType.replaceAll('_', ' ')}</TD>
                      <TD>{row.description}</TD>
                      <TD numeric>{row.debitUsd.isZero() ? '—' : formatMoney(row.debitUsd, 'USD')}</TD>
                      <TD numeric>{row.creditUsd.isZero() ? '—' : formatMoney(row.creditUsd, 'USD')}</TD>
                      <TD numeric className="text-ink-muted">
                        {row.debitLocal.isZero() ? '—' : formatMoney(row.debitLocal, local)}
                      </TD>
                      <TD numeric className="text-ink-muted">
                        {row.creditLocal.isZero() ? '—' : formatMoney(row.creditLocal, local)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <tr>
                    <TD colSpan={4}>Total</TD>
                    <TD numeric>{formatMoney(report.lossUsd, 'USD')}</TD>
                    <TD numeric>{formatMoney(report.gainUsd, 'USD')}</TD>
                    <TD numeric>{formatMoney(report.lossLocal, local)}</TD>
                    <TD numeric>{formatMoney(report.gainLocal, local)}</TD>
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
