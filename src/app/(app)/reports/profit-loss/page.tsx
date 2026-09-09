import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getProfitAndLoss } from '@/lib/services/reports';
import { formatMoney, formatDate, formatPercent } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import type { PnlLine } from '@/lib/services/reports';

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

  const pnl = await getProfitAndLoss({ companyId: user.activeCompany.id, from: fromDate, to: toDate });

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
              <span className="text-ink-subtle">{line.code}</span> {line.name}
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
      />

      <DateRangePicker defaultFrom={fromDate.toISOString().slice(0, 10)} defaultTo={toDate.toISOString().slice(0, 10)} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Revenue', value: pnl.totals.revenueUsd, tone: 'text-ink' },
          { label: 'Cost of sales', value: pnl.totals.costOfSalesUsd, tone: 'text-ink' },
          { label: 'Gross profit', value: pnl.totals.grossProfitUsd, tone: 'text-gold-700' },
          { label: 'Net profit', value: pnl.totals.netProfitUsd, tone: pnl.totals.netProfitUsd.greaterThanOrEqualTo(0) ? 'text-gold-700' : 'text-red-600' },
        ].map((card) => (
          <Card key={card.label} className="p-4">
            <p className="text-xs font-medium text-ink-muted">{card.label}</p>
            <p className={`tnum mt-1 text-lg font-semibold ${card.tone}`}>{formatMoney(card.value, 'USD')}</p>
          </Card>
        ))}
      </div>

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
