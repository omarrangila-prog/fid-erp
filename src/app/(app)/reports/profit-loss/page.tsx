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
  // `compare` is 'none' when off — a string, so it is compared, not tested for truth.
  const single = columnsBy === 'total' && compare === 'none';
  const [breakdown, cogsAccount, soldToDate, recorded] = await Promise.all([
    single ? getCostOfSalesBreakdown({ companyId, from: fromDate, to: toDate }) : Promise.resolve(null),
    prisma.account.findFirst({ where: { companyId, systemKey: 'COST_OF_GOODS_SOLD' }, select: { id: true } }),
    // Every shipment expense recorded to the end date, and how much of it has
    // gone out with coffee sold: the rest is still in stock (or in transit).
    single ? getCostOfSalesBreakdown({ companyId, to: toDate }) : Promise.resolve(null),
    single
      ? prisma.expense.aggregate({
          where: { companyId, status: 'POSTED', kind: 'SHIPMENT', capitaliseToLandedCost: true, expenseDate: { lte: toDate } },
          _sum: { amountLocal: true },
        })
      : Promise.resolve(null),
  ]);
  const shipmentExpenses = recorded && soldToDate
    ? { recorded: dec(recorded._sum.amountLocal ?? 0), inStock: dec(recorded._sum.amountLocal ?? 0).minus(soldToDate.expensesTotal.local) }
    : null;
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
      // The requirements' statement: one line per heading. Each opens to show what it is made of.
      defaultOpen: false,
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

  let shippingMoved: Pair | null = null;
  let shippingLines: StatementLine[] = [];
  const cogsSection = section('cogs', 'Less: Cost of Goods Sold', (p) => p.costOfSales, (p) => ({ local: p.totals.costOfSalesLocal, usd: p.totals.costOfSalesUsd }), 'Total Cost of Goods Sold');
  if (breakdown && cogsAccount) {
    // The one "Cost of Goods Sold" line opened into what it is made of. The
    // parts add up to the ledger's figure: any difference (a correction dated
    // in another period) is its own line, never folded in silently.
    const ledgerLine = total.costOfSales.find((l) => l.accountId === cogsAccount.id);
    const ledger: Pair = { local: dec(ledgerLine?.amountLocal ?? 0), usd: dec(ledgerLine?.amountUsd ?? 0) };
    const timing: Pair = { local: ledger.local.minus(breakdown.totalLocal), usd: ledger.usd.minus(breakdown.totalUsd) };
    const href = `/reports/general-ledger?account=${cogsAccount.id}&from=${from}&to=${to}`;
    // The owner's presentation: Cost of Goods Sold is the coffee itself, and
    // the shipment expenses on the coffee sold are listed with the other
    // expenses. Only where they are shown moves — the books keep them in the
    // coffee's cost, and net profit is the same either way.
    const parts: StatementLine[] = [
      { key: 'cos-purchase', label: 'Coffee purchase cost (coffee sold)', href, cells: [money({ local: breakdown.purchase.local, usd: breakdown.purchase.usd })] },
      ...(timing.local.abs().greaterThanOrEqualTo('0.01')
        ? [{ key: 'cos-timing', label: 'Stock / cost of sales correction dated in this period', href, cells: [money(timing)] }]
        : []),
    ];
    const at = cogsSection.lines.findIndex((l) => l.key === cogsAccount.id);
    if (at >= 0) {
      cogsSection.lines.splice(at, 1, ...parts);
      shippingMoved = { local: breakdown.expensesTotal.local, usd: breakdown.expensesTotal.usd };
      shippingLines = breakdown.expenses.map((e) => ({
        key: `ship-${e.key}`,
        label: `Shipment expense — ${e.label}`,
        href: `/reports/cogs?from=${from}&to=${to}`,
        cells: [money({ local: e.local, usd: e.usd })],
      }));
      cogsSection.total.cells = [money({ local: total.totals.costOfSalesLocal.minus(shippingMoved.local), usd: total.totals.costOfSalesUsd.minus(shippingMoved.usd) })];
    }
  }
  const expensesSection = section('expenses', 'Less: Operating Expenses', (p) => p.operatingExpenses, (p) => ({ local: p.totals.operatingExpensesLocal, usd: p.totals.operatingExpensesUsd }), 'Total Operating Expenses');
  if (shippingMoved) {
    expensesSection.lines.unshift(...shippingLines);
    expensesSection.total.cells = [
      money({ local: total.totals.operatingExpensesLocal.plus(shippingMoved.local), usd: total.totals.operatingExpensesUsd.plus(shippingMoved.usd) }),
    ];
  }

  const sections: StatementSectionData[] = [
    section('income', 'Sales / Revenue', (p) => p.revenue, (p) => ({ local: p.totals.revenueLocal, usd: p.totals.revenueUsd }), 'Total Sales / Revenue'),
    cogsSection,
    expensesSection,
    ...(total.otherItems.length > 0 || (before?.otherItems.length ?? 0) > 0
      ? [section('other', 'Other Income / Expenses', (p) => p.otherItems, (p) => ({ local: p.totals.otherLocal, usd: p.totals.otherUsd }), 'Total Other Income / Expenses')]
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
            report="profit-loss-pdf"
            columns={columns}
            sections={sections}
            grandTotals={[
              grand(
                'Gross Profit',
                (p) => ({
                  local: p.totals.grossProfitLocal.plus(shippingMoved?.local ?? 0),
                  usd: p.totals.grossProfitUsd.plus(shippingMoved?.usd ?? 0),
                }),
                'cogs',
                'strong',
              ),
              grand('Net Profit / Loss', (p) => ({ local: p.totals.netProfitLocal, usd: p.totals.netProfitUsd }), sections[sections.length - 1].key, 'final'),
            ]}
          />
          <p className="mt-3 px-3 text-xs text-ink-subtle">
            Gross margin {formatPercent(shippingMoved && !total.totals.revenueLocal.isZero() ? total.totals.grossProfitLocal.plus(shippingMoved.local).dividedBy(total.totals.revenueLocal).times(100) : total.grossMarginPct)} · net margin {formatPercent(total.netMarginPct)}. Figures in {local}, the
            currency the books are kept in; ≈ USD under each is the equivalent at every transaction&rsquo;s own rate. Every figure
            comes from posted journal lines; click an account to see them.
          </p>
          {breakdown && shipmentExpenses ? (
            <div className="mx-3 mt-3 rounded-md border border-line bg-surface-sunken/40 px-3 py-2 text-xs text-ink-muted" data-testid="pnl-shipment-expenses">
              <p className="font-semibold text-ink">Where the shipment expenses are</p>
              <p className="mt-1">
                All shipment expenses recorded up to {formatDate(toDate)}: <span className="tnum font-semibold text-ink">{formatMoney(shipmentExpenses.recorded, local)}</span>.
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                <li>
                  <span className="tnum font-semibold text-ink">{formatMoney(breakdown.expensesTotal.local, local)}</span> is on the coffee sold in this
                  period — under Operating Expenses above, line by line. In the books they are part of the coffee&rsquo;s cost; only where they are shown differs, and net profit is the same.
                </li>
                <li>
                  <span className="tnum font-semibold text-ink">{formatMoney(shipmentExpenses.inStock, local)}</span> is on coffee not sold yet (in stock or
                  in transit). It stays in Inventory on the Balance Sheet and comes into this statement when that coffee is sold.
                </li>
              </ul>
            </div>
          ) : null}
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
  return (
    <Card>
      <CardContent className="px-2 pb-4 pt-2 sm:px-4">
        <StatementHeader company={company} title={`Profit and Loss — ${p.scope === 'shipment' ? 'Shipment' : 'Customer'}: ${p.label}`} period={p.scope === 'customer' ? period : 'Shipment to date'} />
        <div className="overflow-x-auto" data-wide-sheet>
          <table className="data-grid grid-framed w-full min-w-[22rem] text-sm" data-testid="scoped-pnl">
            <tbody>
              {row('Sales / Revenue', p.revenue, { testId: 'scoped-revenue' })}
              {row('Cost of Goods Sold', p.cogs, { less: true, testId: 'scoped-cogs' })}
              {row('Gross Profit', p.grossProfit, { strong: true, testId: 'scoped-gross' })}
              <tr>
                <td className="px-3 py-1.5 text-left text-ink-muted">Gross margin</td>
                <td className="tnum px-3 py-1.5 text-right">{p.grossMarginPct ? formatPercent(p.grossMarginPct) : '—'}</td>
              </tr>
              {p.periodCosts ? row('Other expenses allocated to the shipment', p.periodCosts, { less: true }) : null}
              {p.allocatedOverhead ? row('Allocated company overhead (management)', p.allocatedOverhead, { less: true }) : null}
              {p.netProfit ? row('Net Profit / Loss', p.netProfit, { final: true, testId: 'scoped-net' }) : null}
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
