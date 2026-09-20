import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getProfitAndLossByColumns, type PnlLine, type ProfitAndLoss } from '@/lib/services/reports';
import { formatMoney, formatDate, formatPercent } from '@/lib/format';
import { Decimal, dec } from '@/lib/money';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { Card, CardContent } from '@/components/ui/card';
import { PrintButton } from '@/components/shared/print-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';
import {
  Statement,
  StatementControls,
  StatementHeader,
  FavouriteStar,
  type StatementCell,
  type StatementLine,
  type StatementSectionData,
} from '@/components/reports/report-statement';

export const metadata: Metadata = { title: 'Profit & Loss' };
export const dynamic = 'force-dynamic';

function startOfYear() {
  return new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
}

/**
 * The profit and loss statement, read the way an accountant reads one.
 *
 * Income, cost of sales, gross profit, expenses, net profit — in that order,
 * as an indented statement rather than a row of cards. Columns are the
 * period, or its months, quarters or years, and optionally the period before
 * with the change and its percentage. Every account line opens the
 * transactions that make it up. Sections collapse and stay collapsed.
 */
export default async function ProfitLossPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; columns?: string; compare?: string; zero?: string }>;
}) {
  const query = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const local = user.activeCompany.localCurrency;

  const fromDate = query.from ? new Date(`${query.from}T00:00:00.000Z`) : startOfYear();
  const toDate = query.to ? new Date(`${query.to}T00:00:00.000Z`) : new Date();
  const columnsBy = (['month', 'quarter', 'year'].includes(query.columns ?? '') ? query.columns : 'total') as 'total' | 'month' | 'quarter' | 'year';
  const compare = (['previous', 'year'].includes(query.compare ?? '') ? query.compare : 'none') as 'none' | 'previous' | 'year';
  const showZero = query.zero === '1';

  const report = await getProfitAndLossByColumns({ companyId: user.activeCompany.id, from: fromDate, to: toDate, columnsBy, compare });
  const { total, before, previous } = report;
  const from = fromDate.toISOString().slice(0, 10);
  const to = toDate.toISOString().slice(0, 10);

  // --- Columns across the top ---------------------------------------------
  const periodColumns = columnsBy === 'total' ? [] : report.columns.map((c) => c.label);
  const columns = [
    ...periodColumns,
    columnsBy === 'total' ? 'Total' : 'Total',
    ...(before ? [compare === 'year' ? 'Previous year' : 'Previous period', 'Change', '% change'] : []),
  ];

  const money = (value: Decimal, muted = false): StatementCell => ({ value: formatMoney(value, 'USD'), muted });
  const changeCells = (now: Decimal, then: Decimal): StatementCell[] => {
    const delta = now.minus(then);
    const pct = then.isZero() ? null : delta.dividedBy(then.abs()).times(100);
    return [
      money(then, true),
      { value: formatMoney(delta, 'USD'), tone: delta.isNegative() ? 'negative' : delta.isZero() ? undefined : 'positive' },
      { value: pct === null ? (delta.isZero() ? '—' : 'new') : `${pct.greaterThanOrEqualTo(0) ? '+' : ''}${pct.toFixed(1)}%`, muted: true },
    ];
  };

  /** One statement section from the matching group on each column's statement. */
  const section = (key: string, title: string, pick: (p: ProfitAndLoss) => PnlLine[], totalOf: (p: ProfitAndLoss) => Decimal, totalLabel: string): StatementSectionData => {
    // Union of accounts across every column, in the order the total statement lists them.
    const ordered = new Map<string, PnlLine>();
    for (const line of pick(total)) ordered.set(line.accountId, line);
    for (const col of report.byColumn) for (const line of pick(col)) if (!ordered.has(line.accountId)) ordered.set(line.accountId, line);
    if (before) for (const line of pick(before)) if (!ordered.has(line.accountId)) ordered.set(line.accountId, line);

    const amountIn = (p: ProfitAndLoss | null, accountId: string) =>
      dec(p ? (pick(p).find((l) => l.accountId === accountId)?.amountUsd ?? 0) : 0);

    const lines: StatementLine[] = [...ordered.values()]
      .filter((line) => showZero || !amountIn(total, line.accountId).isZero() || (before ? !amountIn(before, line.accountId).isZero() : false))
      .map((line) => ({
        key: line.accountId,
        label: line.name,
        href: `/reports/general-ledger?account=${line.accountId}&from=${from}&to=${to}`,
        cells: [
          ...report.byColumn.map((col) => money(amountIn(col, line.accountId))),
          money(amountIn(total, line.accountId)),
          ...(before ? changeCells(amountIn(total, line.accountId), amountIn(before, line.accountId)) : []),
        ],
      }));

    return {
      key,
      title,
      lines,
      total: {
        label: totalLabel,
        cells: [
          ...report.byColumn.map((col) => money(totalOf(col))),
          money(totalOf(total)),
          ...(before ? changeCells(totalOf(total), totalOf(before)) : []),
        ],
      },
    };
  };

  const sections: StatementSectionData[] = [
    section('income', 'Income', (p) => p.revenue, (p) => p.totals.revenueUsd, 'Total income'),
    section('cogs', 'Cost of goods sold', (p) => p.costOfSales, (p) => p.totals.costOfSalesUsd, 'Total cost of goods sold'),
    section('expenses', 'Expenses', (p) => p.operatingExpenses, (p) => p.totals.operatingExpensesUsd, 'Total expenses'),
    ...(total.otherItems.length > 0 || (before?.otherItems.length ?? 0) > 0
      ? [section('other', 'Other income and expenses', (p) => p.otherItems, (p) => p.totals.otherUsd, 'Total other')]
      : []),
  ];

  const grand = (label: string, of: (p: ProfitAndLoss) => Decimal, after: string, emphasis: 'strong' | 'final') => ({
    after,
    label,
    emphasis,
    cells: [
      ...report.byColumn.map((col) => money(of(col))),
      money(of(total)),
      ...(before ? changeCells(of(total), of(before)) : []),
    ],
  });

  const periodLabel = `${formatDate(fromDate)} – ${formatDate(toDate)}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Profit & Loss"
        description="Income, cost of sales, expenses and what is left — for any period, any way you want the columns."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Profit & Loss' }]}
        actions={
          <>
            <FavouriteStar href="/reports/profit-loss" label="Profit & Loss" />
            <ExportLinks href={exportHref('profit-loss', { from, to })} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader title="Profit and Loss" companyName={user.activeCompany.name} country={user.activeCompany.country} />

      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <DateRangePicker defaultFrom={from} defaultTo={to} />
        <StatementControls columnsBy={columnsBy} compare={compare} showZero={showZero} />
      </div>

      <Card>
        <CardContent className="px-2 pb-4 pt-2 sm:px-4">
          <StatementHeader
            company={user.activeCompany.name}
            title="Profit and Loss"
            period={periodLabel}
            meta={
              previous ? (
                <p className="text-xs text-ink-subtle">
                  Compared with {formatDate(previous.from)} – {formatDate(previous.to)}
                </p>
              ) : null
            }
          />
          <Statement
            report="profit-loss"
            columns={columns}
            sections={sections}
            grandTotals={[
              grand('Gross profit', (p) => p.totals.grossProfitUsd, 'cogs', 'strong'),
              grand('Net profit', (p) => p.totals.netProfitUsd, sections[sections.length - 1].key, 'final'),
            ]}
          />
          <p className="mt-3 px-3 text-xs text-ink-subtle">
            Gross margin {formatPercent(total.grossMarginPct)} · net margin {formatPercent(total.netMarginPct)} · in {local}: net{' '}
            {formatMoney(total.totals.netProfitLocal, local)}. Every figure comes from posted journal lines; click an account to
            see them.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
