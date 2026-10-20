import type { Metadata } from 'next';
import type { Decimal } from '@/lib/money';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getCashFlow } from '@/lib/services/reports';
import { formatMoney, formatDate, dayParam, companyToday } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { ReportShareButton } from '@/components/share/report-share-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';

export const metadata: Metadata = { title: 'Cash Flow' };
export const dynamic = 'force-dynamic';

export default async function CashFlowPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.CASHBANK_VIEW);

  const fromDate = dayParam(from) ?? new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  // Today on the company's own clock, not the server's: Dubai is four hours ahead of UTC.
  const toDate = dayParam(to) ?? companyToday(user.activeCompany.timezone);

  const flow = await getCashFlow({ companyId: user.activeCompany.id, from: fromDate, to: toDate });
  // The company's currency first, as the cash book has it; USD underneath.
  const local = user.activeCompany.localCurrency;
  const usd = (amount: Decimal) => (local !== 'USD' ? <span className="block text-[11px] font-normal text-ink-subtle">≈ {formatMoney(amount, 'USD')}</span> : null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash Flow"
        description={`Money in and out of every cash and bank account · ${formatDate(fromDate)} to ${formatDate(toDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Cash Flow' }]}
        actions={
          <>
            <ExportLinks href={exportHref('cash-flow', { from, to })} />
            <ReportShareButton report="cash-flow" />
          </>
        }
      />
      <PrintHeader
        title="Cash Flow"
        companyName={user.activeCompany.name} currency={user.activeCompany.localCurrency}
        country={user.activeCompany.country}
      />

      <DateRangePicker defaultFrom={fromDate.toISOString().slice(0, 10)} defaultTo={toDate.toISOString().slice(0, 10)} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs font-medium text-ink-muted">Money in</p>
          <p className="tnum mt-1 text-lg font-semibold text-gold-700">{formatMoney(flow.totalInLocal, local)}</p>
          {usd(flow.totalInUsd)}
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium text-ink-muted">Money out</p>
          <p className="tnum mt-1 text-lg font-semibold text-red-600">{formatMoney(flow.totalOutLocal, local)}</p>
          {usd(flow.totalOutUsd)}
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium text-ink-muted">Net movement</p>
          <p
            className={`tnum mt-1 text-lg font-semibold ${flow.netMovementUsd.greaterThanOrEqualTo(0) ? 'text-gold-700' : 'text-red-600'}`}
          >
            {formatMoney(flow.netMovementLocal, local)}
          </p>
          {usd(flow.netMovementUsd)}
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By source</CardTitle>
          <CardDescription>
            A direct statement: the money that actually moved, grouped by what caused it — not a reconciliation from
            profit.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Source</TH>
                  <TH numeric>In</TH>
                  <TH numeric>Out</TH>
                  <TH numeric>Net</TH>
                </TR>
              </THead>
              <TBody>
                {flow.lines.length === 0 ? (
                  <TR>
                    <TD colSpan={4} className="py-8 text-center text-xs text-ink-subtle">
                      No cash movements in this period.
                    </TD>
                  </TR>
                ) : (
                  flow.lines.map((line) => (
                    <TR key={line.sourceType}>
                      <TD className="font-medium">{line.label}</TD>
                      <TD numeric className={line.inLocal.greaterThan(0) ? 'text-gold-700' : 'text-ink-subtle'}>
                        {line.inLocal.greaterThan(0) ? (
                          <>
                            {formatMoney(line.inLocal, local)}
                            {usd(line.inUsd)}
                          </>
                        ) : '—'}
                      </TD>
                      <TD numeric className={line.outLocal.greaterThan(0) ? 'text-red-600' : 'text-ink-subtle'}>
                        {line.outLocal.greaterThan(0) ? (
                          <>
                            {formatMoney(line.outLocal, local)}
                            {usd(line.outUsd)}
                          </>
                        ) : '—'}
                      </TD>
                      <TD numeric className="font-medium">
                        {formatMoney(line.netLocal, local)}
                        {usd(line.netUsd)}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
              <TFoot>
                <tr>
                  <TD>Total</TD>
                  <TD numeric>{formatMoney(flow.totalInLocal, local)}{usd(flow.totalInUsd)}</TD>
                  <TD numeric>{formatMoney(flow.totalOutLocal, local)}{usd(flow.totalOutUsd)}</TD>
                  <TD numeric>{formatMoney(flow.netMovementLocal, local)}{usd(flow.netMovementUsd)}</TD>
                </tr>
              </TFoot>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}
