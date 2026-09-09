import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Boxes, CircleDollarSign, HandCoins, TrendingUp,
  Package, Container as ContainerIcon, Coins, Truck, Plus, ArrowRight,
} from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, SHIPMENT_STATUS_META } from '@/lib/constants';
import { getDashboard } from '@/lib/services/dashboard';
import { getSetupStatus, toChecklistStep } from '@/lib/services/setup';
import { getMonthlyPurchases } from '@/lib/services/profitability';
import { formatMoney, formatMoneyCompact, formatQuantityKg, formatDate, daysUntil } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/shared/stat-card';
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

  const [data, purchases, setup] = await Promise.all([
    getDashboard({ companyId }),
    getMonthlyPurchases({ companyId, months: 12 }),
    getSetupStatus(companyId),
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
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-gold-700 hover:underline"
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
      <PageHeader
        title={user.activeCompany.name}
        description="Everything below is calculated from posted transactions, live."
        meta={
          <>
            <Badge tone="neutral">Local currency {local}</Badge>
            <Badge tone="info">Group currency USD</Badge>
            {data.unreadAlerts > 0 ? (
              <Link href="/notifications">
                <Badge tone="warning">{data.unreadAlerts} alert{data.unreadAlerts === 1 ? '' : 's'}</Badge>
              </Link>
            ) : null}
          </>
        }
        actions={<DashboardActions canBuy={canBuy} canSell={canSell} canReceipt={canReceipt} />}
      />

      {setupSteps.length > 0 && setupCompleted < setupSteps.length ? (
        <SetupChecklist
          steps={setupSteps}
          completed={setupCompleted}
          total={setupSteps.length}
          title="Finish setting up"
          description="A few things are still outstanding. The dashboard works either way — this is just what is left."
        />
      ) : null}

      {/* --- The six figures people actually open this screen for ---------- */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">Position</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          {showProfit ? (
            <StatCard
              label="Sales Revenue"
              value={formatMoney(data.profit.revenueUsd, 'USD')}
              sublabel="Posted invoices"
              icon={TrendingUp}
              href="/sales"
            />
          ) : null}
          <StatCard
            label="Receivables"
            value={formatMoney(data.position.receivableUsd, 'USD')}
            sublabel={
              data.receivables.overdueCount > 0
                ? `${formatMoney(data.receivables.overdueUsd, 'USD')} overdue`
                : 'Nothing overdue'
            }
            tone={data.receivables.overdueCount > 0 ? 'warning' : 'default'}
            icon={CircleDollarSign}
            href="/finance/receivables"
          />
          <StatCard
            label="Payables"
            value={formatMoney(data.position.payableUsd, 'USD')}
            sublabel={`${data.payables.count} open contract${data.payables.count === 1 ? '' : 's'}`}
            icon={HandCoins}
            href="/finance/payables"
          />
          {showCost ? (
            <StatCard
              label="Inventory Value"
              value={formatMoneyCompact(data.position.inventoryValueUsd, 'USD')}
              sublabel={`${formatQuantityKg(data.position.availableKg)} on hand`}
              icon={Boxes}
              href="/inventory"
            />
          ) : (
            <StatCard
              label="Stock on Hand"
              value={formatQuantityKg(data.position.availableKg)}
              sublabel={`${data.position.bags.toLocaleString()} bags`}
              icon={Boxes}
              href="/inventory"
            />
          )}
          <StatCard
            label="Coffee in Transit"
            value={formatQuantityKg(data.position.inTransitKg)}
            sublabel={showCost ? formatMoneyCompact(data.position.inTransitValueUsd, 'USD') : 'Not yet landed'}
            icon={Truck}
            href="/shipments"
          />
          {showProfit ? (
            <StatCard
              label="Net Profit"
              value={formatMoney(data.profit.netProfitUsd, 'USD')}
              sublabel={`${data.profit.netMarginPct.toString()}% margin`}
              tone={data.profit.netProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
              icon={TrendingUp}
              href="/profitability"
            />
          ) : null}
        </div>
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
