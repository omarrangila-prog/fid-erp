import type { Metadata } from 'next';
import Link from 'next/link';
import { ReportSummary } from '@/components/shared/report-summary';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getProfitAndLoss } from '@/lib/services/reports';
import { formatMoney, formatDate, formatPercent } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { PrintButton } from '@/components/shared/print-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';
import type { PnlLine } from '@/lib/services/reports';
import type { Decimal } from '@/lib/money';

export const metadata: Metadata = { title: 'Profit & Loss' };
export const dynamic = 'force-dynamic';

function startOfYear() {
  return new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
}

export default async function ProfitLossPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from, to } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const local = user.activeCompany.localCurrency;

  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : startOfYear();
  const toDate = to ? new Date(`${to}T00:00:00.000Z`) : new Date();

  /*
   * The same statement for the period immediately before, of the same
   * length, so "this month against last month" and "this quarter against
   * the previous" are read side by side without anybody working out dates.
   */
  const spanMs = toDate.getTime() - fromDate.getTime() + 86_400_000;
  const previousTo = new Date(fromDate.getTime() - 86_400_000);
  const previousFrom = new Date(previousTo.getTime() - spanMs + 86_400_000);

  const [pnl, previous] = await Promise.all([
    getProfitAndLoss({ companyId: user.activeCompany.id, from: fromDate, to: toDate }),
    getProfitAndLoss({ companyId: user.activeCompany.id, from: previousFrom, to: previousTo }),
  ]);

  /** "+12.5%" against the previous period, or nothing when there is no base to compare with. */
  const change = (now: Decimal, before: Decimal) => {
    if (before.isZero()) return now.isZero() ? 'no change' : 'new this period';
    const pct = now.minus(before).dividedBy(before.abs()).times(100);
    return `${pct.greaterThanOrEqualTo(0) ? '+' : ''}${pct.toFixed(1)}% vs ${formatMoney(before, 'USD')}`;
  };

  const section = (title: string, lines: PnlLine[], totalUsd: string, totalLocal: string, emphasis?: boolean) => (
    <>
      <TR className="bg-forest-50/40 hover:bg-forest-50/40">
        <TD colSpan={3} className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {title}
        </TD>
      </TR>
      {lines.length === 0 ? (
        <TR>
          <TD colSpan={3} className="text-xs text-ink-subtle">
            Nothing in this period.
          </TD>
        </TR>
      ) : (
        lines.map((line) => (
          <TR key={line.code}>
            <TD>
              {/* Every figure on the statement opens the transactions behind
                  it, for the same period. A total nobody can take apart is a
                  total nobody can check. */}
              <Link
                href={`/reports/general-ledger?account=${line.accountId}&from=${fromDate
                  .toISOString()
                  .slice(0, 10)}&to=${toDate.toISOString().slice(0, 10)}`}
                className="text-forest-800 hover:text-gold-700 hover:underline"
              >
{line.name}
              </Link>
            </TD>
            <TD numeric>{formatMoney(line.amountUsd, 'USD')}</TD>
            <TD numeric className="text-ink-muted">
              {formatMoney(line.amountLocal, local)}
            </TD>
          </TR>
        ))
      )}
      <TR className={emphasis ? 'border-t-2 border-line-strong font-semibold' : 'font-medium'}>
        <TD>Total {title.toLowerCase()}</TD>
        <TD numeric>{totalUsd}</TD>
        <TD numeric className="text-ink-muted">{totalLocal}</TD>
      </TR>
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Profit & Loss"
        description={`${user.activeCompany.name} · ${formatDate(fromDate)} to ${formatDate(toDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Profit & Loss' }]}
        actions={
          <>
            <ExportLinks href={exportHref('profit-loss', { from, to })} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader
        title="Profit & Loss"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      <DateRangePicker defaultFrom={fromDate.toISOString().slice(0, 10)} defaultTo={toDate.toISOString().slice(0, 10)} />

      {/* Revenue, what it cost, what was left — read in that order, the way
          the statement below is read. */}
      <ReportSummary
        figures={[
          {
            label: 'Revenue',
            value: formatMoney(pnl.totals.revenueUsd, 'USD'),
            hint: change(pnl.totals.revenueUsd, previous.totals.revenueUsd),
          },
          {
            label: 'Cost of sales',
            value: formatMoney(pnl.totals.costOfSalesUsd, 'USD'),
            hint: change(pnl.totals.costOfSalesUsd, previous.totals.costOfSalesUsd),
          },
          {
            label: 'Gross profit',
            value: formatMoney(pnl.totals.grossProfitUsd, 'USD'),
            hint: `${formatPercent(pnl.grossMarginPct)} margin · ${change(pnl.totals.grossProfitUsd, previous.totals.grossProfitUsd)}`,
          },
          {
            label: 'Expenses',
            value: formatMoney(pnl.totals.operatingExpensesUsd, 'USD'),
            hint: change(pnl.totals.operatingExpensesUsd, previous.totals.operatingExpensesUsd),
          },
          {
            label: 'Net profit',
            value: formatMoney(pnl.totals.netProfitUsd, 'USD'),
            hint: `${formatMoney(pnl.totals.netProfitLocal, local)} · ${change(pnl.totals.netProfitUsd, previous.totals.netProfitUsd)}`,
            lead: true,
            tone: pnl.totals.netProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative',
          },
        ]}
      />
      <p className="text-xs text-ink-muted">
        Compared with the previous period of the same length: {formatDate(previousFrom)} to {formatDate(previousTo)}.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Statement</CardTitle>
          <CardDescription>
            Shown in USD and in {local}. Both columns come from the same journal lines, each translated at the rate
            its voucher was posted at.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Account</TH>
                  <TH numeric>USD</TH>
                  <TH numeric>{local}</TH>
                </TR>
              </THead>
              <TBody>
                {section('Revenue', pnl.revenue, formatMoney(pnl.totals.revenueUsd, 'USD'), formatMoney(pnl.totals.revenueLocal, local))}
                {section('Cost of sales', pnl.costOfSales, formatMoney(pnl.totals.costOfSalesUsd, 'USD'), formatMoney(pnl.totals.costOfSalesLocal, local))}

                <TR className="border-t-2 border-line-strong bg-gold-50/50 font-semibold hover:bg-gold-50/50">
                  <TD>
                    Gross profit
                    <span className="ml-2 text-xs font-normal text-ink-muted">{formatPercent(pnl.grossMarginPct)}</span>
                  </TD>
                  <TD numeric>{formatMoney(pnl.totals.grossProfitUsd, 'USD')}</TD>
                  <TD numeric className="text-ink-muted">{formatMoney(pnl.totals.grossProfitLocal, local)}</TD>
                </TR>

                {section('Operating expenses', pnl.operatingExpenses, formatMoney(pnl.totals.operatingExpensesUsd, 'USD'), formatMoney(pnl.totals.operatingExpensesLocal, local))}
                {pnl.otherItems.length > 0
                  ? section('Other income and costs', pnl.otherItems, formatMoney(pnl.totals.otherUsd, 'USD'), formatMoney(pnl.totals.otherLocal, local))
                  : null}

                <TR className="border-t-2 border-line-strong bg-forest-50 font-semibold hover:bg-forest-50">
                  <TD>
                    Net profit
                    <span className="ml-2 text-xs font-normal text-ink-muted">{formatPercent(pnl.netMarginPct)}</span>
                  </TD>
                  <TD numeric>{formatMoney(pnl.totals.netProfitUsd, 'USD')}</TD>
                  <TD numeric className="text-ink-muted">{formatMoney(pnl.totals.netProfitLocal, local)}</TD>
                </TR>
              </TBody>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}
