import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec, toMoney, toQuantity } from '@/lib/money';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import { getBatchCostings } from '@/lib/services/landed-cost';
import { equivalentText } from '@/lib/dual-currency';
import { bagsForKg, addBags } from '@/lib/bags';
import { getShipmentOrdinals, shipmentOrdinalLabel } from '@/lib/services/shipment';
import { PageHeader } from '@/components/shared/page-header';
import { Figure } from '@/components/inventory/figure';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyAction } from '@/components/shared/empty-action';
import { StockClient, type StockRow } from '@/app/(app)/inventory/stock-client';
import { Truck, ArrowLeftRight, History, Layers } from 'lucide-react';
import { warehouseScope, warehouseScopeWhere } from '@/lib/auth/scope';
import { getItemProfitability, getItemProfitabilityChecks, COLLECTION_METHODS, COLLECTION_LABELS } from '@/lib/services/item-profitability';
import { ItemStockClient } from '@/app/(app)/inventory/item-stock-client';
import { StockFilters } from '@/app/(app)/inventory/stock-filters';
import { parseStockFilters, getStockFilterOptions, describeStockFilters, toItemStockRow } from '@/app/(app)/inventory/item-stock-data';
import { pairText, perKgText, profitText, kg } from '@/components/inventory/item-profit-format';
import { formatDate, formatPercent } from '@/lib/format';

export const metadata: Metadata = { title: 'Stock on Hand' };
export const dynamic = 'force-dynamic';

export default async function InventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const companyId = user.activeCompany.id;
  const showValue = can(user, PERMISSIONS.PURCHASE_COST_VIEW);
  const showSales = can(user, PERMISSIONS.SALES_VIEW);
  const scope = warehouseScope(user);

  // --- The item view: stock, sales and profit per coffee -------------------
  const { values, filters } = parseStockFilters(await searchParams);
  const filtered = Object.values(values).some(Boolean);
  const [report, options] = await Promise.all([
    getItemProfitability({ companyId, ...filters, warehouseIds: scope }),
    getStockFilterOptions(companyId, scope),
  ]);
  // The reconciliation is of the whole company, as the other screens show it —
  // so only when nothing narrows the view.
  const checks = !filtered && !scope && showValue && showSales ? await getItemProfitabilityChecks(companyId, report) : [];
  const local = report.localCurrency;
  const itemQuery = new URLSearchParams(
    Object.entries({ warehouse: values.warehouse, shipment: values.shipment, batch: values.batch, container: values.container, from: values.from, to: values.to }).filter(
      (entry): entry is [string, string] => !!entry[1],
    ),
  ).toString();
  const itemRows = report.items.map((item) => toItemStockRow(item, local, { showCost: showValue, showSales }, itemQuery ? `?${itemQuery}` : ''));
  const t = report.total;
  const profit = profitText(t.grossProfit, local);
  const periodLabel = values.from || values.to ? `${values.from ? formatDate(values.from) : 'Start'} – ${values.to ? formatDate(values.to) : 'today'}` : undefined;
  const siteTotals = new Map<string, { name: string; available: typeof t.availableKg; value: typeof t.stockValue.local }>();
  for (const item of report.items) {
    for (const w of item.warehouses) {
      const entry = siteTotals.get(w.warehouseId) ?? { name: w.warehouseName, available: t.availableKg.times(0), value: t.stockValue.local.times(0) };
      entry.available = entry.available.plus(w.availableKg);
      entry.value = entry.value.plus(w.stockValue.local);
      siteTotals.set(w.warehouseId, entry);
    }
  }
  const sites = [...siteTotals.values()].filter((w) => !w.available.isZero()).sort((a, b) => a.name.localeCompare(b.name));

  const [balances, warehouses, inTransit, ordinals, costings] = await Promise.all([
    prisma.inventoryBalance.findMany({
      // Only the warehouses assigned to this person, when any are.
      where: { companyId, ...(warehouseScope(user) ? { warehouseId: { in: warehouseScope(user)! } } : {}) },
      include: {
        item: { select: { itemName: true, itemCode: true, originCountry: true, region: true } },
        warehouse: { select: { id: true, name: true } },
        // The batch is what carries the trail back to the shipment it came
        // in on and the contract that bought it, so the stock row can say
        // where the coffee came from without opening anything.
        batch: {
          select: {
            landedUnitCostUsd: true,
            bagWeightKg: true,
            batchNumber: true,
            container: { select: { containerNumber: true } },
            purchaseContract: { select: { contractReference: true, contractNumber: true } },
            shipmentId: true,
            lot: { select: { lotNumber: true } },
          },
        },
      },
    }),
    prisma.warehouse.findMany({
      where: { companyId, status: 'ACTIVE', ...warehouseScopeWhere(user) },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.batch.aggregate({
      where: { companyId, status: 'ACTIVE' },
      _sum: { inTransitQuantityKg: true },
    }),
    getShipmentOrdinals(companyId),
    getBatchCostings({ companyId }),
  ]);

  // Aggregate to one row per coffee per warehouse.
  const grouped = new Map<string, StockRow>();
  const localPerKg = new Map(costings.map((c) => [c.batchId, c.landedPerKgLocal]));

  for (const balance of balances) {
    const key = `${balance.itemId}:${balance.warehouseId}`;
    const existing = grouped.get(key);
    const onHand = dec(balance.onHandKg);
    const reserved = dec(balance.reservedKg);
    const available = dec(balance.availableKg);
    const value = toMoney(onHand.times(dec(balance.batch.landedUnitCostUsd)));
    // The same coffee in the company's currency at its historical cost rates.
    const valueLocal = Number(toMoney(onHand.times(localPerKg.get(balance.batchId) ?? 0)));
    // Bags follow the kilograms at the batch's bag weight — never a separate
    // count that can drift below zero while coffee is still on the shelf.
    const bags = bagsForKg(onHand, balance.batch.bagWeightKg);

    // Every batch behind the row, so the breakdown can be opened in place.
    const lot = {
      batchNumber: balance.batch.batchNumber,
      reference: balance.batch.purchaseContract?.contractReference ?? '—',
      contractNumber: balance.batch.purchaseContract?.contractNumber ?? '—',
      shipment: shipmentOrdinalLabel(ordinals.get(balance.batch.shipmentId)),
      lotNumber: balance.batch.lot?.lotNumber ?? '—',
      container: balance.batch.container?.containerNumber ?? '—',
      onHandLabel: formatQuantityKg(onHand),
      availableLabel: formatQuantityKg(available),
      bags,
    };

    if (existing) {
      existing.lots.push(lot);
      existing.onHandSort += Number(onHand);
      existing.availableSort += Number(available);
      existing.bags = addBags(existing.bags, bags);
      existing.valueSort += Number(value);
      existing.valueLocalSort += valueLocal;
      existing.onHandLabel = formatQuantityKg(existing.onHandSort);
      existing.availableLabel = formatQuantityKg(existing.availableSort);
      existing.reservedLabel = formatQuantityKg(
        dec(existing.reservedLabel.replace(/[^\d.-]/g, '') || 0).plus(reserved),
      );
      existing.valueLabel = formatMoney(existing.valueSort, 'USD');
      existing.costPerKgLabel =
        existing.onHandSort > 0 ? formatMoney(existing.valueSort / existing.onHandSort, 'USD') : '—';
    } else {
      grouped.set(key, {
        id: key,
        itemName: balance.item.itemName,
        itemCode: balance.item.itemCode,
        origin: balance.item.originCountry,
        category: balance.item.region ?? '',
        warehouse: balance.warehouse.name,
        warehouseId: balance.warehouseId,
        onHandLabel: formatQuantityKg(onHand),
        onHandSort: Number(onHand),
        reservedLabel: formatQuantityKg(reserved),
        availableLabel: formatQuantityKg(available),
        availableSort: Number(available),
        inTransitLabel: '—',
        bags,
        valueLabel: formatMoney(value, 'USD'),
        valueSort: Number(value),
        valueLocalSort: valueLocal,
        valueEquivalent: null,
        costPerKgEquivalent: null,
        // §24: what a kilo of this actually cost, beside how much there is.
        costPerKgLabel: Number(onHand) > 0 ? formatMoney(Number(value) / Number(onHand), 'USD') : '—',
        lots: [lot],
      });
    }
  }

  const rows = [...grouped.values()].filter((r) => r.onHandSort !== 0);
  for (const row of rows) {
    row.valueEquivalent = equivalentText({
      amount: row.valueSort,
      currency: 'USD',
      localCurrency: local,
      amountLocal: row.valueLocalSort,
    });
    row.costPerKgEquivalent =
      row.onHandSort > 0
        ? equivalentText({
            amount: row.valueSort / row.onHandSort,
            currency: 'USD',
            localCurrency: local,
            amountLocal: row.valueLocalSort / row.onHandSort,
          })
        : null;
  }
  const inTransitKg = toQuantity(inTransit._sum.inTransitQuantityKg ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock on Hand"
        description="Every coffee: what came in, what sold, what is left and where, what it cost, what it sold for, what has been collected — and whether it made money."
        breadcrumbs={[{ label: 'Inventory' }, { label: 'Stock on Hand' }]}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/inventory/movements">
                <History />
                Movements
              </Link>
            </Button>
            {can(user, PERMISSIONS.INVENTORY_TRANSFER) ? (
              <Button asChild>
                <Link href="/inventory/transfers">
                  <ArrowLeftRight />
                  Transfers
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <StockFilters action="/inventory" values={values} {...options} />

      <section aria-labelledby="stock-summary" className="space-y-2">
        <h2 id="stock-summary" className="text-sm font-semibold text-ink-muted">
          Stock{showValue ? ' — an asset, at what it cost to land' : ''}
          {periodLabel ? ` · ${periodLabel}` : ''}
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Figure
            testId="total-received"
            label="Received"
            value={kg(t.receivedKg)}
            sub={t.openingKg.isZero() ? undefined : `${kg(t.openingKg)} on hand before the period`}
          />
          <Figure testId="total-sold" label="Sold" value={kg(t.soldKg)} />
          <Figure
            testId="total-available"
            label="Available"
            value={kg(t.availableKg)}
            sub={`${sites.length === 1 ? 'In 1 warehouse' : `Across ${sites.length} warehouses`}${t.reservedKg.greaterThan(0) ? ` · ${kg(t.reservedKg)} held for drafts` : ''}`}
          />
          <Figure testId="total-in-transit" label="In transit" value={formatQuantityKg(inTransitKg)} sub="Owned, not yet landed" />
          {showValue ? (
            <Figure
              testId="total-stock-value"
              label="Stock value"
              value={pairText(t.stockValue, local)!.primary}
              equivalent={pairText(t.stockValue, local)!.equivalent}
              sub={`What is left, at its landed cost${perKgText(t.avgCostPerKg, local) ? ` · average ${perKgText(t.avgCostPerKg, local)!.primary}` : ''}`}
            />
          ) : null}
        </div>
      </section>

      {showSales ? (
        <section aria-labelledby="sales-summary" className="space-y-2">
          <h2 id="sales-summary" className="text-sm font-semibold text-ink-muted">
            Sales and customer money — what customers owe is a receivable, separate from the stock
          </h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Figure
              testId="total-revenue"
              label="Sales revenue"
              value={pairText(t.revenue, local)!.primary}
              equivalent={pairText(t.revenue, local)!.equivalent}
              sub={perKgText(t.avgSellPerKg, local) ? `Average ${perKgText(t.avgSellPerKg, local)!.primary}` : undefined}
            />
            <Figure
              testId="total-collected"
              label="Collected"
              value={pairText(t.collectedTotal, local)!.primary}
              equivalent={pairText(t.collectedTotal, local)!.equivalent}
              sub={COLLECTION_METHODS.filter((m) => !t.collected[m].local.isZero())
                .map((m) => `${COLLECTION_LABELS[m]} ${pairText(t.collected[m], local)!.primary}`)
                .join(' · ') || undefined}
            />
            <Figure
              testId="total-outstanding"
              label="Outstanding"
              value={pairText(t.outstanding, local)!.primary}
              equivalent={pairText(t.outstanding, local)!.equivalent}
              sub="Still owed on these invoices"
            />
            {showValue ? (
              <>
                <Figure testId="total-cogs" label="Cost of goods sold" value={pairText(t.cogs, local)!.primary} equivalent={pairText(t.cogs, local)!.equivalent} />
                <Figure
                  testId="total-profit"
                  label={profit.label}
                  value={profit.primary}
                  equivalent={profit.equivalent}
                  tone={profit.loss ? 'negative' : t.grossProfit.local.isZero() ? 'default' : 'positive'}
                  sub={t.marginPct ? `Margin ${formatPercent(t.marginPct)}` : undefined}
                />
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      {sites.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Where the stock is</CardTitle>
            <CardDescription>What is left, by physical location. The warehouses add up to the company total.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {sites.map((w) => (
              <div key={w.name} className="rounded-lg border border-line p-3" data-testid="site-total">
                <p className="truncate text-sm font-medium text-ink">{w.name}</p>
                <p className="tnum mt-1 text-lg font-semibold text-forest-800">{kg(w.available)}</p>
                {showValue ? <p className="text-xs text-ink-subtle">{formatMoney(w.value, local)} at landed cost</p> : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {[
          { href: '/inventory/batches', label: 'Batch / lot stock', icon: Layers },
          { href: '/inventory/shipments', label: 'Shipment stock', icon: Truck },
          { href: '/inventory/movements', label: 'Stock movements', icon: History },
        ].map((link) => (
          <Button key={link.href} variant="outline" size="sm" asChild>
            <Link href={link.href}>
              <link.icon />
              {link.label}
            </Link>
          </Button>
        ))}
      </div>

      <section aria-labelledby="by-item" className="space-y-2">
        <h2 id="by-item" className="text-base font-semibold text-ink">
          By item
        </h2>
        <ItemStockClient
          rows={itemRows}
          showCost={showValue}
          showSales={showSales}
          canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
          canSell={can(user, PERMISSIONS.SALES_CREATE)}
          canTransfer={can(user, PERMISSIONS.INVENTORY_TRANSFER)}
          period={periodLabel}
          filters={describeStockFilters(values, options)}
        />
        <p className="text-xs text-ink-subtle">
          Sold is what posted invoices sold, less returns. Revenue is each invoice line for the item — never a whole invoice. A payment
          made against a whole invoice is shared over its lines in proportion to their value; agent collections count as collected. Cost
          of goods sold is the landed cost of the KG sold, as posted. Figures in {local}; ≈ USD is each transaction at its own rate.
        </p>
      </section>

      {checks.length > 0 ? (
        <details className="rounded-xl border border-line bg-surface p-4 shadow-card" data-testid="stock-reconciliation">
          <summary className="cursor-pointer text-sm font-semibold text-ink">
            Reconciliation — {checks.every((c) => c.ok) ? `all ${checks.length} checks agree` : `${checks.filter((c) => !c.ok).length} of ${checks.length} checks disagree`}
          </summary>
          <table className="data-grid grid-framed mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="py-1.5 pr-3 font-medium">Check</th>
                <th className="py-1.5 pr-3 text-right font-medium">This page</th>
                <th className="py-1.5 pr-3 text-right font-medium">Source</th>
                <th className="py-1.5 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.key} data-check={c.key} data-ok={c.ok ? 'true' : 'false'}>
                  <td className="py-1.5 pr-3">{c.label}</td>
                  <td className="tnum py-1.5 pr-3 text-right">{c.shown}</td>
                  <td className="tnum py-1.5 pr-3 text-right">
                    {c.source}
                    <span className="block text-[11px] text-ink-subtle">{c.sourceLabel}</span>
                  </td>
                  <td className={c.ok ? 'py-1.5 text-emerald-700' : 'py-1.5 font-semibold text-red-700'}>{c.ok ? 'Agrees' : 'Disagrees'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}

      <section aria-labelledby="by-warehouse" className="space-y-2" data-testid="warehouse-stock">
        <h2 id="by-warehouse" className="text-base font-semibold text-ink">
          By warehouse and batch
        </h2>
      <StockClient
        emptyAction={
          can(user, PERMISSIONS.PURCHASES_VIEW) ? (
            <EmptyAction href="/purchases" label="Receive a purchase contract" tone="go" />
          ) : undefined
        }
        rows={rows}
        warehouses={warehouses}
        showValue={showValue}
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
      />
      </section>
    </div>
  );
}
