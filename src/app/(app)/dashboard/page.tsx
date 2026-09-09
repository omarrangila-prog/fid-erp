import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Boxes, CircleDollarSign, HandCoins, TrendingUp, Wallet,
  Package, Container as ContainerIcon, Coins, Plus, ArrowRight, CalendarDays,
} from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, SHIPMENT_STATUS_META, TRANSACTION_STATUS_META } from '@/lib/constants';
import { getDashboard, getRecentActivity, getLowStock } from '@/lib/services/dashboard';
import { getSetupStatus, toChecklistStep } from '@/lib/services/setup';
import { getMonthlyPurchases } from '@/lib/services/profitability';
import { dec } from '@/lib/money';
import { formatMoney, formatMoneyCompact, formatQuantityKg, formatDate, daysUntil } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/shared/stat-card';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { SetupChecklist } from '@/components/shared/setup-checklist';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import {
  ProfitTrendChart, AgeingChart, StockByItemChart, ShipmentStatusChart, PurchaseVsSalesChart,
} from '@/components/dashboard/charts';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

/** The three things people come to this screen to start. */
function DashboardActions({
  canBuy,
  canSell,
  canReceipt,
}: {
  canBuy: boolean;
  canSell: boolean;
  canReceipt: boolean;
}) {
  if (!canBuy && !canSell && !canReceipt) return null;
  return (
    <>
      {canBuy ? (
        <Button asChild variant="outline" size="sm">
          <Link href="/purchases/new">
            <Plus />
            Purchase
          </Link>
        </Button>
      ) : null}
      {canSell ? (
        <Button asChild variant="outline" size="sm">
          <Link href="/sales/new">
            <Plus />
            Sale
          </Link>
        </Button>
      ) : null}
      {canReceipt ? (
        <Button asChild size="sm">
          <Link href="/finance/receipts/new">
            <Plus />
            Receipt
          </Link>
        </Button>
      ) : null}
    </>
  );
}

export default async function DashboardPage() {
  const user = await requirePageAccess(PERMISSIONS.DASHBOARD_VIEW);
  const companyId = user.activeCompany.id;
  const local = user.activeCompany.localCurrency;

  const [data, purchases, setup, activity, lowStock] = await Promise.all([
    getDashboard({ companyId }),
    getMonthlyPurchases({ companyId, months: 12 }),
    getSetupStatus(companyId),
    getRecentActivity(companyId),
    getLowStock(companyId),
  ]);

  // Only steps this user could actually carry out are worth showing them.
  const setupSteps = setup.steps
    .filter((step) => can(user, step.permission))
    .map(toChecklistStep);
  const setupCompleted = setupSteps.filter((step) => step.done).length;

  const showProfit = can(user, PERMISSIONS.PROFITS_VIEW);
  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);
  const canBuy = can(user, PERMISSIONS.PURCHASES_CREATE);
  const canSell = can(user, PERMISSIONS.SALES_CREATE);
  const canReceipt = can(user, PERMISSIONS.RECEIPTS_CREATE);

  // Greeting by the company's own clock, not the server's.
  const now = new Date();
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hour12: false,
      timeZone: user.activeCompany.timezone,
    }).format(now),
  );
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = user.name.split(/\s+/)[0];
  const today = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: user.activeCompany.timezone,
  }).format(now);

  // Month-on-month movement, taken from the same series the chart draws.
  const trend = (series: Array<{ value: number }>) => {
    if (series.length < 2) return null;
    const previous = series[series.length - 2].value;
    const latest = series[series.length - 1].value;
    if (previous === 0) return latest === 0 ? 0 : null;
    return ((latest - previous) / Math.abs(previous)) * 100;
  };
  const salesDeltaPct = trend(data.monthly.map((m) => ({ value: Number(m.revenueUsd) })));
  const profitDeltaPct = trend(data.monthly.map((m) => ({ value: Number(m.netProfitUsd) })));

  // The local-currency cash position; every currency is listed in its own panel.
  const localTotals = data.position.currencyTotals.find((c) => c.currency === local);
  const localCash = dec(localTotals?.cash ?? 0).plus(localTotals?.bank ?? 0);

  // Nothing has been traded yet. Charts of nothing help no one, so the screen
  // becomes a set of next steps instead.
  if (setup.isNewCompany) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={`Welcome to ${user.activeCompany.name}`}
          description="Your books are open and empty. Work down this list and the dashboard fills itself in."
          meta={
            <>
              <Badge tone="neutral">Local currency {local}</Badge>
              <Badge tone="info">Group currency USD</Badge>
            </>
          }
          actions={<DashboardActions canBuy={canBuy} canSell={canSell} canReceipt={canReceipt} />}
        />

        {setupSteps.length > 0 ? (
          <SetupChecklist steps={setupSteps} completed={setupCompleted} total={setupSteps.length} />
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>What appears here once you start</CardTitle>
            <CardDescription>
              Nothing on this dashboard is typed in by hand — every figure is read back out of the transactions you
              post.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: 'Cash and bank', body: `Balances per account, ${local} and USD kept apart.` },
                { label: 'Stock on hand', body: 'Kilograms and bags, per warehouse and per batch.' },
                { label: 'Who owes what', body: 'Customer ageing, supplier payables, overdue alerts.' },
                { label: 'Profit', body: 'Gross and net margin, and profit per kilogram sold.' },
              ].map((preview) => (
                <div key={preview.label} className="rounded-lg border border-dashed border-line-strong p-4">
                  <dt className="text-sm font-semibold text-ink">{preview.label}</dt>
                  <dd className="mt-1 text-xs leading-relaxed text-ink-muted">{preview.body}</dd>
                </div>
              ))}
            </dl>
            <Link
              href="/getting-started"
              className="mt-4 inline-flex min-h-8 items-center gap-1.5 text-sm font-medium text-gold-700 hover:underline"
            >
              Read how the pieces fit together
              <ArrowRight className="size-4" />
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }


  const monthly = data.monthly.map((m) => ({
    month: m.month.slice(2),
    revenue: Number(m.revenueUsd),
    grossProfit: Number(m.grossProfitUsd),
    netProfit: Number(m.netProfitUsd),
  }));

  const purchaseVsSales = data.monthly.map((m, i) => ({
    month: m.month.slice(2),
    purchases: Number(purchases[i]?.valueUsd ?? 0),
    sales: Number(m.revenueUsd),
  }));

  const receivableAgeing = data.receivables.ageing.map((a) => ({ label: a.label, amount: Number(a.amountUsd) }));
  const payableAgeing = data.payables.ageing.map((a) => ({ label: a.label, amount: Number(a.amountUsd) }));
  const stockByItem = data.itemStock.map((i) => ({ label: i.itemName, kg: Number(i.availableKg) }));
  const shipmentStatus = Object.entries(data.shipments.byStatus).map(([status, v]) => ({
    label: SHIPMENT_STATUS_META[status]?.label ?? status,
    value: v.count,
  }));

  return (
    <div className="space-y-6">
      {/* --- Greeting ------------------------------------------------------ */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            {greeting}, {firstName}
          </h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            Here&rsquo;s what&rsquo;s happening at {user.activeCompany.name} today.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-muted">
            <CalendarDays className="size-4 text-ink-subtle" />
            {today}
          </span>
          <DashboardActions canBuy={canBuy} canSell={canSell} canReceipt={canReceipt} />
        </div>
      </header>

      {/* --- The six figures ------------------------------------------------ */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {showProfit ? (
          <KpiCard
            label="Sales"
            currency="USD"
            value={formatMoneyCompact(data.profit.revenueUsd, 'USD').replace(/^USD\s*/, '')}
            icon={TrendingUp}
            tone="sales"
            deltaPct={salesDeltaPct}
            deltaLabel="vs last month"
            href="/sales"
            linkLabel="View sales"
          />
        ) : null}

        <KpiCard
          label="Receivables"
          currency="USD"
          value={formatMoneyCompact(data.position.receivableUsd, 'USD').replace(/^USD\s*/, '')}
          icon={CircleDollarSign}
          tone="receivable"
          note={
            data.receivables.overdueCount > 0
              ? `${data.receivables.overdueCount} overdue`
              : 'Nothing overdue'
          }
          noteTone={data.receivables.overdueCount > 0 ? 'danger' : 'muted'}
          href="/finance/receivables"
        />

        <KpiCard
          label="Payables"
          currency="USD"
          value={formatMoneyCompact(data.position.payableUsd, 'USD').replace(/^USD\s*/, '')}
          icon={HandCoins}
          tone="payable"
          note={`${data.payables.count} open contract${data.payables.count === 1 ? '' : 's'}`}
          href="/finance/payables"
        />

        <KpiCard
          label="Inventory Value"
          currency={showCost ? 'USD' : undefined}
          value={
            showCost
              ? formatMoneyCompact(data.position.inventoryValueUsd, 'USD').replace(/^USD\s*/, '')
              : formatQuantityKg(data.position.availableKg)
          }
          icon={Boxes}
          tone="inventory"
          note={`${formatQuantityKg(data.position.availableKg)} on hand`}
          href="/inventory"
          linkLabel="View stock"
        />

        <KpiCard
          label="Cash & Bank"
          currency={local}
          value={formatMoneyCompact(localCash, local).replace(new RegExp(`^${local}\\s*`), '')}
          icon={Wallet}
          tone="cash"
          note={`${data.position.currencyTotals.length} currenc${data.position.currencyTotals.length === 1 ? 'y' : 'ies'}`}
          href="/finance/cash-bank"
          linkLabel="View accounts"
        />

        {showProfit ? (
          <KpiCard
            label="Net Profit"
            currency="USD"
            value={formatMoneyCompact(data.profit.netProfitUsd, 'USD').replace(/^USD\s*/, '')}
            icon={Coins}
            tone="profit"
            deltaPct={profitDeltaPct}
            deltaLabel={`${data.profit.netMarginPct.toString()}% margin`}
            href="/profitability"
          />
        ) : null}
      </section>

      {/* --- Cash, by currency. Never one merged number. -------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Cash and bank</CardTitle>
            <CardDescription>
              Each currency stands on its own — adding {local} to USD would produce a number that means nothing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.position.currencyTotals.length === 0 ? (
                <p className="py-4 text-xs text-ink-subtle">No cash or bank movement yet.</p>
              ) : (
                data.position.currencyTotals.map((totals) => (
                  <Link
                    key={totals.currency}
                    href="/finance/cash-bank"
                    className="rounded-lg border border-line bg-paper p-4 transition-colors hover:border-forest-300"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                        {totals.currency}
                      </span>
                      <Coins className="size-4 text-forest-300" />
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-3">
                      <div>
                        <dt className="text-[11px] text-ink-muted">Cash</dt>
                        <dd className="tnum text-sm font-semibold text-ink">
                          {formatMoney(totals.cash, totals.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-ink-muted">Bank</dt>
                        <dd className="tnum text-sm font-semibold text-ink">
                          {formatMoney(totals.bank, totals.currency)}
                        </dd>
                      </div>
                    </dl>
                  </Link>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
            <CardDescription>What would go wrong if nobody looked today.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Link
              href="/finance/receivables"
              className="flex items-center justify-between gap-3 rounded-lg border border-line p-3 transition-colors hover:border-forest-300"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">Overdue customers</span>
                <span className="block text-xs text-ink-subtle">
                  {formatMoney(data.receivables.overdueUsd, 'USD')} outstanding
                </span>
              </span>
              <span
                className={`tnum shrink-0 text-lg font-semibold ${
                  data.receivables.topOverdue.length > 0 ? 'text-red-600' : 'text-ink-subtle'
                }`}
              >
                {data.receivables.topOverdue.length}
              </span>
            </Link>

            <Link
              href="/shipments"
              className="flex items-center justify-between gap-3 rounded-lg border border-line p-3 transition-colors hover:border-forest-300"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">Active shipments</span>
                <span className="block text-xs text-ink-subtle">
                  {data.shipments.totalContainers} container{data.shipments.totalContainers === 1 ? '' : 's'}
                </span>
              </span>
              <span className="tnum shrink-0 text-lg font-semibold text-ink">{data.shipments.activeCount}</span>
            </Link>

            <Link
              href="/notifications"
              className="flex items-center justify-between gap-3 rounded-lg border border-line p-3 transition-colors hover:border-forest-300"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">Unread alerts</span>
                <span className="block text-xs text-ink-subtle">ETA and overdue warnings</span>
              </span>
              <span
                className={`tnum shrink-0 text-lg font-semibold ${
                  data.unreadAlerts > 0 ? 'text-amber-700' : 'text-ink-subtle'
                }`}
              >
                {data.unreadAlerts}
              </span>
            </Link>
          </CardContent>
        </Card>
      </div>

      {showProfit ? (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">Margin</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Gross Profit"
              value={formatMoney(data.profit.grossProfitUsd, 'USD')}
              sublabel={`${data.profit.grossMarginPct.toString()}% margin`}
              tone={data.profit.grossProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
            />
            <StatCard
              label="Profit per KG"
              value={formatMoney(data.profit.profitPerKgUsd, 'USD')}
              sublabel={`on ${formatQuantityKg(data.profit.soldKg)} sold`}
              tone={data.profit.profitPerKgUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
            />
            <StatCard
              label="Warehouses"
              value={String(data.warehouseStock.length)}
              sublabel={data.warehouseStock.map((w) => w.code).join(' · ') || 'None set up'}
              icon={Package}
              href="/inventory"
            />
            <StatCard
              label="Containers"
              value={String(data.shipments.totalContainers)}
              icon={ContainerIcon}
              href="/shipments"
            />
          </div>
        </section>
      ) : null}

      {/* --- Where is my stock? --------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Stock by warehouse</CardTitle>
            <CardDescription>On-hand coffee at each location.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.warehouseStock.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-subtle">No warehouse stock yet.</p>
            ) : (
              data.warehouseStock.map((w) => (
                <div key={w.warehouseId} className="-mx-2 flex items-center justify-between gap-3 rounded-lg border-b border-line px-2 py-2.5 transition-colors last:border-0 hover:bg-forest-50/60">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{w.name}</p>
                    <p className="text-xs text-ink-subtle">
                      {w.code} · {w.bags.toLocaleString()} bags
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tnum text-sm font-semibold text-ink">{formatQuantityKg(w.onHandKg)}</p>
                    {showCost ? (
                      <p className="tnum text-xs text-ink-subtle">{formatMoneyCompact(w.valueUsd, 'USD')}</p>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Available stock by coffee</CardTitle>
            <CardDescription>Kilograms free to sell, across every warehouse.</CardDescription>
          </CardHeader>
          <CardContent>
            {stockByItem.length === 0 ? (
              <EmptyState title="No stock on hand" description="Receive a purchase order to bring coffee into a warehouse." />
            ) : (
              <StockByItemChart data={stockByItem} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* --- Trends --------------------------------------------------------- */}
      {showProfit ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Revenue and profit</CardTitle>
              <CardDescription>Last 12 months, in USD.</CardDescription>
            </CardHeader>
            <CardContent>
              <ProfitTrendChart data={monthly} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Purchases against sales</CardTitle>
              <CardDescription>Contracted purchases versus invoiced sales.</CardDescription>
            </CardHeader>
            <CardContent>
              <PurchaseVsSalesChart data={purchaseVsSales} />
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Receivable ageing</CardTitle>
            <CardDescription>Outstanding customer balances by age in days, in USD.</CardDescription>
          </CardHeader>
          <CardContent>
            <AgeingChart data={receivableAgeing} tone="receivable" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payable ageing</CardTitle>
            <CardDescription>What we owe suppliers by age in days, in USD.</CardDescription>
          </CardHeader>
          <CardContent>
            <AgeingChart data={payableAgeing} tone="payable" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Shipment status</CardTitle>
            <CardDescription>Where the jobs currently stand.</CardDescription>
          </CardHeader>
          <CardContent>
            {shipmentStatus.length === 0 ? (
              <p className="py-12 text-center text-xs text-ink-subtle">No shipments yet.</p>
            ) : (
              <ShipmentStatusChart data={shipmentStatus} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* --- What happened, and what is running out ------------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div>
              <CardTitle>Recent transactions</CardTitle>
              <CardDescription>Everything posted lately, across every module.</CardDescription>
            </div>
            <Link href="/reports" className="inline-flex min-h-8 shrink-0 items-center text-xs font-medium text-forest-700 hover:underline">
              View all →
            </Link>
          </CardHeader>
          <CardContent>
            {activity.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-subtle">Nothing posted yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-left text-xs">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-subtle">
                      <th className="pb-2 pr-3 font-semibold">Date</th>
                      <th className="pb-2 px-3 font-semibold">Type</th>
                      <th className="pb-2 px-3 font-semibold">Reference</th>
                      <th className="pb-2 px-3 font-semibold">Party</th>
                      <th className="pb-2 px-3 text-right font-semibold">Amount</th>
                      <th className="pb-2 pl-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {activity.map((row, index) => (
                      <tr key={`${row.reference}-${index}`} className="transition-colors hover:bg-forest-50/50">
                        <td className="py-2.5 pr-3 whitespace-nowrap text-ink-muted">{formatDate(row.date)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-ink">{row.kind}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <Link
                            href={row.href}
                            className="inline-flex min-h-8 items-center font-medium text-forest-700 hover:underline"
                          >
                            {row.reference}
                          </Link>
                        </td>
                        <td className="max-w-40 truncate px-3 py-2.5 text-ink-muted">{row.party}</td>
                        <td className="tnum px-3 py-2.5 text-right whitespace-nowrap font-medium text-ink">
                          {row.currency === 'KG'
                            ? formatQuantityKg(row.amount)
                            : formatMoney(row.amount, row.currency)}
                        </td>
                        <td className="pl-3 py-2.5">
                          <StatusBadge status={row.status} meta={TRANSACTION_STATUS_META} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div>
              <CardTitle>Low stock</CardTitle>
              <CardDescription>Batches close to running out.</CardDescription>
            </div>
            <Link href="/inventory" className="inline-flex min-h-8 shrink-0 items-center text-xs font-medium text-forest-700 hover:underline">
              View all →
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {lowStock.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-subtle">
                Nothing is running low. Batches under 5,000 KG appear here.
              </p>
            ) : (
              lowStock.map((row) => (
                <Link
                  key={`${row.batchNumber}-${row.warehouseCode}`}
                  href="/inventory"
                  className="flex items-center justify-between gap-3 rounded-lg border border-line p-3 transition-colors hover:border-amber-300 hover:bg-amber-50/40"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{row.itemName}</span>
                    <span className="block truncate text-[11px] text-ink-subtle">
                      {row.warehouseCode} · {row.batchNumber}
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-sm font-semibold text-amber-700">
                    {formatQuantityKg(row.availableKg)}
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* --- What needs attention? ------------------------------------------ */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Arriving soon</CardTitle>
            <CardDescription>Jobs with an ETA in the near future.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.shipments.upcoming.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-subtle">Nothing on the water.</p>
            ) : (
              data.shipments.upcoming.map((s) => {
                const days = daysUntil(s.etaDate);
                return (
                  <Link
                    key={s.id}
                    href={`/shipments/${s.id}`}
                    className="-mx-2 flex items-center justify-between gap-3 rounded-lg border-b border-line px-2 py-2.5 transition-colors last:border-0 hover:bg-forest-50/60"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-forest-800">{s.shipmentNumber}</p>
                      <p className="truncate text-xs text-ink-subtle">
                        {s.itemName} · {s.vendorName}
                      </p>
                    </div>
                    <div className="shrink-0 space-y-1 text-right">
                      <StatusBadge status={s.status} meta={SHIPMENT_STATUS_META} />
                      <p className="text-xs text-ink-muted">
                        {formatDate(s.etaDate)}
                        {days !== null ? (
                          <span className={days <= 3 ? ' font-semibold text-amber-700' : ''}>
                            {' '}· {days < 0 ? `${Math.abs(days)}d late` : days === 0 ? 'today' : `in ${days}d`}
                          </span>
                        ) : null}
                      </p>
                    </div>
                  </Link>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Customers to chase</CardTitle>
            <CardDescription>Largest overdue balances.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.receivables.topOverdue.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-subtle">Nothing is overdue. </p>
            ) : (
              data.receivables.topOverdue.map((c) => (
                <Link
                  key={c.customerId}
                  href={`/ledgers/customers/${c.customerId}`}
                  className="-mx-2 flex items-center justify-between gap-3 rounded-lg border-b border-line px-2 py-2.5 transition-colors last:border-0 hover:bg-forest-50/60"
                >
                  <p className="min-w-0 truncate text-sm font-medium text-forest-800">{c.customerName}</p>
                  <p className="tnum shrink-0 text-sm font-semibold text-red-600">
                    {formatMoney(c.amountUsd, 'USD')}
                  </p>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
