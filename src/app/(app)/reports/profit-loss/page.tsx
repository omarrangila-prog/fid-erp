import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getProfitAndLossByColumns, type PnlLine, type ProfitAndLoss } from '@/lib/services/reports';
import { formatMoney, formatDate, formatPercent, formatQuantityKg, companyToday, dayParam } from '@/lib/format';
import { Decimal, dec } from '@/lib/money';
import { PageHeader } from '@/components/shared/page-header';
import { FilterApply, FilterBar, FilterCell, FilterSelect } from '@/components/shared/filter-bar';
import { getCostOfSalesBreakdown } from '@/lib/services/cost-of-sales-breakdown';
import { DateRangePicker } from '@/components/shared/date-range';
import { Card, CardContent } from '@/components/ui/card';
import { ReportShareButton } from '@/components/share/report-share-button';
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
import { CustomizePanel } from '@/components/reports/customize-panel';
import { prisma } from '@/lib/db';
import { getShipmentPnl, getCustomerPnl, type ScopedPnl, type ScopedPair } from '@/lib/services/scoped-pnl';

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
  searchParams: Promise<{ from?: string; to?: string; columns?: string; compare?: string; zero?: string; shipment?: string; customer?: string }>;
}) {
  const query = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const local = user.activeCompany.localCurrency;

  const fromDate = dayParam(query.from) ?? startOfYear();
  const toDate = dayParam(query.to) ?? companyToday(user.activeCompany.timezone);
  const columnsBy = (['month', 'quarter', 'year'].includes(query.columns ?? '') ? query.columns : 'total') as 'total' | 'month' | 'quarter' | 'year';
  const compare = (['previous', 'year'].includes(query.compare ?? '') ? query.compare : 'none') as 'none' | 'previous' | 'year';
  const showZero = query.zero === '1';

  /*
   * §6.8–6.9: the same statement for one shipment or one customer. The
   * scope is read on the server and every query is this company's alone.
   */
  const companyId = user.activeCompany.id;
  const [shipmentOptions, customerOptions] = await Promise.all([
    prisma.purchaseContract.findMany({ where: { companyId, status: 'POSTED' }, orderBy: { contractDate: 'desc' }, select: { id: true, contractReference: true } }),
    prisma.customer.findMany({ where: { companyId }, orderBy: { customerName: 'asc' }, select: { id: true, customerName: true } }),
  ]);
  const scoped: ScopedPnl | null = query.shipment
    ? await getShipmentPnl({ companyId, contractId: query.shipment, from: fromDate, to: toDate })
    : query.customer
      ? await getCustomerPnl({ companyId, customerId: query.customer, from: fromDate, to: toDate })
      : null;

  const report = await getProfitAndLossByColumns({ companyId: user.activeCompany.id, from: fromDate, to: toDate, columnsBy, compare });
  // What the cost of goods sold is made of: the coffee, and each kind of
  // shipment expense on the coffee sold. Shown on the single-column statement.
  const [breakdown, cogsAccount] = await Promise.all([
    columnsBy === 'total' && !compare ? getCostOfSalesBreakdown({ companyId, from: fromDate, to: toDate }) : Promise.resolve(null),
    prisma.account.findFirst({ where: { companyId, systemKey: 'COST_OF_GOODS_SOLD' }, select: { id: true } }),
  ]);
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

  // The company's own currency first — the ledgers' figures — and the USD equivalent under it, each
  // transaction at its own rate: never the other way round.
  type Pair = { local: Decimal; usd: Decimal };
  const money = (value: Pair, muted = false): StatementCell => ({
    value: formatMoney(value.local, local),
    secondary: `≈ ${formatMoney(value.usd, 'USD')}`,
    muted,
  });
  const changeCells = (now: Pair, then: Pair): StatementCell[] => {
    const delta = now.local.minus(then.local);
    const pct = then.local.isZero() ? null : delta.dividedBy(then.local.abs()).times(100);
    return [
      money(then, true),
      { value: formatMoney(delta, local), tone: delta.isNegative() ? 'negative' : delta.isZero() ? undefined : 'positive' },
      { value: pct === null ? (delta.isZero() ? '—' : 'new') : `${pct.greaterThanOrEqualTo(0) ? '+' : ''}${pct.toFixed(1)}%`, muted: true },
    ];
  };

  /** One statement section from the matching group on each column's statement. */
  const section = (key: string, title: string, pick: (p: ProfitAndLoss) => PnlLine[], totalOf: (p: ProfitAndLoss) => Pair, totalLabel: string): StatementSectionData => {
    // Union of accounts across every column, in the order the total statement lists them.
    const ordered = new Map<string, PnlLine>();
    for (const line of pick(total)) ordered.set(line.accountId, line);
    for (const col of report.byColumn) for (const line of pick(col)) if (!ordered.has(line.accountId)) ordered.set(line.accountId, line);
    if (before) for (const line of pick(before)) if (!ordered.has(line.accountId)) ordered.set(line.accountId, line);

    const amountIn = (p: ProfitAndLoss | null, accountId: string): Pair => {
      const line = p ? pick(p).find((l) => l.accountId === accountId) : undefined;
      return { local: dec(line?.amountLocal ?? 0), usd: dec(line?.amountUsd ?? 0) };
    };
    const isZero = (v: Pair) => v.local.isZero() && v.usd.isZero();

    const lines: StatementLine[] = [...ordered.values()]
      .filter((line) => showZero || !isZero(amountIn(total, line.accountId)) || (before ? !isZero(amountIn(before, line.accountId)) : false))
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

  const cogsSection = section('cogs', 'Cost of goods sold', (p) => p.costOfSales, (p) => ({ local: p.totals.costOfSalesLocal, usd: p.totals.costOfSalesUsd }), 'Total cost of goods sold');
  if (breakdown && cogsAccount) {
    // The one "Cost of Goods Sold" line opened into what it is made of. The
    // parts add up to the ledger's figure: any difference (a correction dated
    // in another period) is its own line, never folded in silently.
    const ledgerLine = total.costOfSales.find((l) => l.accountId === cogsAccount.id);
    const ledger: Pair = { local: dec(ledgerLine?.amountLocal ?? 0), usd: dec(ledgerLine?.amountUsd ?? 0) };
    const timing: Pair = { local: ledger.local.minus(breakdown.totalLocal), usd: ledger.usd.minus(breakdown.totalUsd) };
    const href = `/reports/general-ledger?account=${cogsAccount.id}&from=${from}&to=${to}`;
    const parts: StatementLine[] = [
      { key: 'cos-purchase', label: 'Coffee purchase cost (coffee sold)', href, cells: [money({ local: breakdown.purchase.local, usd: breakdown.purchase.usd })] },
      ...breakdown.expenses.map((e) => ({
        key: `cos-${e.key}`,
        label: `Shipment expense — ${e.label}`,
        href: `/reports/cogs?from=${from}&to=${to}`,
        indent: true,
        cells: [money({ local: e.local, usd: e.usd })],
      })),
      {
        key: 'cos-expenses',
        label: 'Total shipment expenses on the coffee sold',
        cells: [money({ local: breakdown.expensesTotal.local, usd: breakdown.expensesTotal.usd })],
      },
      ...(timing.local.abs().greaterThanOrEqualTo('0.01')
        ? [{ key: 'cos-timing', label: 'Stock / cost of sales correction dated in this period', href, cells: [money(timing)] }]
        : []),
    ];
    const at = cogsSection.lines.findIndex((l) => l.key === cogsAccount.id);
    if (at >= 0) cogsSection.lines.splice(at, 1, ...parts);
  }

  const sections: StatementSectionData[] = [
    section('income', 'Income', (p) => p.revenue, (p) => ({ local: p.totals.revenueLocal, usd: p.totals.revenueUsd }), 'Total income'),
    cogsSection,
    section('expenses', 'Expenses', (p) => p.operatingExpenses, (p) => ({ local: p.totals.operatingExpensesLocal, usd: p.totals.operatingExpensesUsd }), 'Total expenses'),
    ...(total.otherItems.length > 0 || (before?.otherItems.length ?? 0) > 0
      ? [section('other', 'Other income and expenses', (p) => p.otherItems, (p) => ({ local: p.totals.otherLocal, usd: p.totals.otherUsd }), 'Total other')]
      : []),
  ];

  const grand = (label: string, of: (p: ProfitAndLoss) => Pair, after: string, emphasis: 'strong' | 'final') => ({
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
            <CustomizePanel report="Profit & Loss" fields={['period', 'columns', 'compare', 'zero']} />
            <ExportLinks href={exportHref('profit-loss', { from, to })} />
            <ReportShareButton report="profit-loss" />
          </>
        }
      />
      <PrintHeader title="Profit and Loss" companyName={user.activeCompany.name} currency={user.activeCompany.localCurrency} country={user.activeCompany.country} />

      <div className="flex flex-wrap items-start gap-3 print:hidden">
        <DateRangePicker defaultFrom={from} defaultTo={to} />
        {scoped ? null : <StatementControls columnsBy={columnsBy} compare={compare} showZero={showZero} />}
      </div>

      <form method="get" className="space-y-1.5 print:hidden" data-testid="pnl-scope">
        <input type="hidden" name="from" value={from} />
        <input type="hidden" name="to" value={to} />
        <FilterBar className="md:inline-flex">
          <FilterCell label="Shipment" className="md:w-64">
            <FilterSelect name="shipment" defaultValue={query.shipment ?? ''}>
              <option value="">Whole company</option>
              {shipmentOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.contractReference}
                </option>
              ))}
            </FilterSelect>
          </FilterCell>
          <FilterCell label="or Customer" className="md:w-64">
            <FilterSelect name="customer" defaultValue={query.customer ?? ''}>
              <option value="">Whole company</option>
              {customerOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.customerName}
                </option>
              ))}
            </FilterSelect>
          </FilterCell>
          <FilterApply type="submit" dirty>
            Show
          </FilterApply>
        </FilterBar>
        {scoped ? (
          <a href={`/reports/profit-loss?from=${from}&to=${to}`} className="inline-block px-1 text-xs font-medium text-forest-800 hover:text-gold-700">
            ← Back to the whole company
          </a>
        ) : null}
      </form>

      {scoped ? <ScopedStatement p={scoped} local={local} company={user.activeCompany.name} period={`${formatDate(fromDate)} – ${formatDate(toDate)}`} /> : null}
      {query.shipment || query.customer ? (scoped ? null : <p className="text-sm text-ink-subtle">Nothing to show for that selection.</p>) : (
      <>

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
              grand('Gross profit', (p) => ({ local: p.totals.grossProfitLocal, usd: p.totals.grossProfitUsd }), 'cogs', 'strong'),
              grand('Net profit', (p) => ({ local: p.totals.netProfitLocal, usd: p.totals.netProfitUsd }), sections[sections.length - 1].key, 'final'),
            ]}
          />
          <p className="mt-3 px-3 text-xs text-ink-subtle">
            Gross margin {formatPercent(total.grossMarginPct)} · net margin {formatPercent(total.netMarginPct)}. Figures in {local}, the
            currency the books are kept in; ≈ USD under each is the equivalent at every transaction&rsquo;s own rate. Every figure
            comes from posted journal lines; click an account to see them.
          </p>
        </CardContent>
      </Card>
      </>
      )}
    </div>
  );
}

/** The P&L of one shipment or one customer, in the statement's order. */
function ScopedStatement({ p, local, company, period }: { p: ScopedPnl; local: string; company: string; period: string }) {
  const amount = (v: ScopedPair) => (
    <>
      <span className="block">{formatMoney(v.local, local)}</span>
      <span className="block text-[11px] font-normal text-ink-subtle">{v.usd ? `≈ ${formatMoney(v.usd, 'USD')}` : 'USD equivalent unavailable'}</span>
    </>
  );
  const row = (label: string, v: ScopedPair, opts: { strong?: boolean; final?: boolean; less?: boolean; testId?: string } = {}) => (
    <tr className={opts.final ? 'grid-total grid-final' : opts.strong ? 'bg-surface-sunken/30 font-semibold' : undefined} data-testid={opts.testId}>
      <td className="px-3 py-1.5 text-left">{opts.less ? `Less: ${label}` : label}</td>
      <td className={`tnum px-3 py-1.5 text-right ${v.local.isNegative() && (opts.strong || opts.final) ? 'text-red-600' : ''}`}>{amount(v)}</td>
    </tr>
  );
  const grossLoss = p.grossProfit.local.isNegative();
  const netLoss = p.netProfit?.local.isNegative() ?? false;
  return (
    <Card>
      <CardContent className="px-2 pb-4 pt-2 sm:px-4">
        <StatementHeader company={company} title={`Profit and Loss — ${p.scope === 'shipment' ? 'Shipment' : 'Customer'}: ${p.label}`} period={p.scope === 'customer' ? period : 'Shipment to date'} />
        <div className="overflow-x-auto" data-wide-sheet>
          <table className="data-grid grid-framed w-full min-w-[22rem] text-sm" data-testid="scoped-pnl">
            <tbody>
              {row('Sales / revenue', p.revenue, { testId: 'scoped-revenue' })}
              {row('Cost of goods sold', p.cogs, { less: true, testId: 'scoped-cogs' })}
              {row(grossLoss ? 'Gross loss' : 'Gross profit', p.grossProfit, { strong: true, testId: 'scoped-gross' })}
              <tr>
                <td className="px-3 py-1.5 text-left text-ink-muted">Gross margin</td>
                <td className="tnum px-3 py-1.5 text-right">{p.grossMarginPct ? formatPercent(p.grossMarginPct) : '—'}</td>
              </tr>
              {p.periodCosts ? row('Shipment period costs (not in stock)', p.periodCosts, { less: true }) : null}
              {p.allocatedOverhead ? row('Allocated company overhead (management)', p.allocatedOverhead, { less: true }) : null}
              {p.netProfit ? row(netLoss ? 'Net loss' : 'Net profit', p.netProfit, { final: true, testId: 'scoped-net' }) : null}
              {p.netProfit ? (
                <tr>
                  <td className="px-3 py-1.5 text-left text-ink-muted">Net margin</td>
                  <td className="tnum px-3 py-1.5 text-right">{p.netMarginPct ? formatPercent(p.netMarginPct) : '—'}</td>
                </tr>
              ) : null}
              <tr>
                <td className="px-3 py-1.5 text-left text-ink-muted">Company operating expenses in the period — unallocated, not deducted above</td>
                <td className="tnum px-3 py-1.5 text-right text-ink-muted">{formatMoney(p.unallocatedCompanyExpensesLocal, local)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 px-3 text-xs text-ink-subtle">
          {p.periodNote} {p.netNote ?? ''} {p.usdBasis} {formatQuantityKg(p.soldKg)} sold{p.scope === 'shipment' ? ` from ${p.lines} container${p.lines === 1 ? '' : 's'}` : ` on ${p.lines} line${p.lines === 1 ? '' : 's'}`}. COGS is the landed cost of the
          KG sold only — the stock still in hand stays an asset. Capitalised shipment costs are inside COGS and are not deducted again.
        </p>
      </CardContent>
    </Card>
  );
}
