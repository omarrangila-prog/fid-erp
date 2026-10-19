import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { warehouseScope } from '@/lib/auth/scope';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { Decimal, toQuantity, toMoney, toUnitCost } from '@/lib/money';
import { formatDate, formatMoney, formatPercent } from '@/lib/format';
import {
  getItemProfitability,
  COLLECTION_METHODS,
  COLLECTION_LABELS,
  type ItemMeasures,
  type ItemSaleLine,
  type Pair,
} from '@/lib/services/item-profitability';
import { pairText, perKgText, profitText, usdFirstText, kg, STOCK_STATUS_META as STATUS_META, type PairText } from '@/components/inventory/item-profit-format';
import { Figure } from '@/components/inventory/figure';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { DualText } from '@/components/shared/dual-text';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TableWrap, Table, THead, TBody, TR, TH, TD, TFoot } from '@/components/ui/table';
import { StockFilters } from '@/app/(app)/inventory/stock-filters';
import { parseStockFilters, getStockFilterOptions } from '@/app/(app)/inventory/item-stock-data';
import { cn } from '@/lib/utils';
import { shortDocumentNumber } from '@/lib/short-number';

export const metadata: Metadata = { title: 'Item Stock & Profitability' };
export const dynamic = 'force-dynamic';

const STATUS_TONE = { PAID: 'success', PARTIAL: 'progress', UNPAID: 'warning' } as const;
const STATUS_LABEL = { PAID: 'Paid', PARTIAL: 'Partially paid', UNPAID: 'Unpaid' } as const;

/**
 * One coffee, all the way down: what came in and where it is, what it cost,
 * what it sold for and to whom, what has been collected and how, and which
 * shipment, container and batch made the money. Read from the same item
 * service as Stock on Hand, so the two can never disagree.
 */
export default async function ItemStockPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const { id } = await params;
  const companyId = user.activeCompany.id;
  // Another company's coffee is simply not here.
  const item = await prisma.coffeeItem.findFirst({ where: { id, companyId }, select: { id: true, itemName: true, itemCode: true, originCountry: true } });
  if (!item) notFound();

  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);
  // COGS, profit and margin are profitability: "View profit" on top of cost.
  const showProfit = showCost && can(user, PERMISSIONS.PROFITS_VIEW);
  const showSales = can(user, PERMISSIONS.SALES_VIEW);
  const both = showProfit && showSales;
  const scope = warehouseScope(user);
  const { values, filters } = parseStockFilters({ ...(await searchParams), item: id });
  // Narrowed by anything but the item itself (a date, a warehouse), the containers' lifetime averages are not the view's.
  const filtered = Object.entries(values).some(([key, value]) => key !== 'item' && !!value);
  const [report, options] = await Promise.all([
    getItemProfitability({ companyId, ...filters, itemId: id, warehouseIds: scope }),
    getStockFilterOptions(companyId, scope),
  ]);
  const local = report.localCurrency;
  const node = report.items[0] ?? null;
  const m: ItemMeasures = node ?? report.total;
  const lines = report.lines;
  const profit = profitText(m.grossProfit, local);
  const pt = (p: Pair | null | undefined) => pairText(p, local);
  const query = new URLSearchParams(
    Object.entries({ warehouse: values.warehouse, shipment: values.shipment, batch: values.batch, container: values.container, from: values.from, to: values.to }).filter(
      (entry): entry is [string, string] => !!entry[1],
    ),
  ).toString();

  const money = (text: PairText | null) => (text ? <DualText primary={text.primary} equivalent={text.equivalent} /> : <span className="text-ink-subtle">—</span>);
  const profitCell = (value: Pair) => {
    const text = profitText(value, local);
    return (
      <span className={cn(text.loss ? 'text-red-700' : 'text-emerald-800')}>
        <DualText primary={text.primary} equivalent={text.equivalent} />
      </span>
    );
  };

  // The item's own identities, each against the records behind it.
  const warehouses = (node?.warehouses ?? []).filter(
    (w) => !(w.receivedKg.isZero() && w.transferInKg.isZero() && w.transferOutKg.isZero() && w.stockSoldKg.isZero() && w.onHandKg.isZero() && w.soldKg.isZero()),
  );
  const shipments = node?.shipments ?? [];
  const sumKg = (list: ItemMeasures[], pick: (x: ItemMeasures) => Decimal) => list.reduce((s, x) => s.plus(pick(x)), new Decimal(0));
  const sumLocal = (list: Array<{ local: Decimal }>) => list.reduce((s, x) => s.plus(x.local), new Decimal(0));
  /*
   * §22: the item's averages rebuilt from its containers — every batch's KG
   * at its own landed cost — so the client sees why the average is what it
   * is, and the page proves the two agree.
   */
  const allBatches = shipments.flatMap((s) => s.containers.flatMap((c) => c.batches));
  const containerReceivedKg = allBatches.reduce((t, b) => t.plus(b.receivedKg), new Decimal(0));
  const containerLanded = allBatches.reduce((t, b) => t.plus(b.receivedKg.times(b.landedPerKg.local)), new Decimal(0));
  const containerRemainingKg = allBatches.reduce((t, b) => t.plus(b.onHandKg), new Decimal(0));
  const containerRemaining = allBatches.reduce((t, b) => t.plus(b.stockValue.local), new Decimal(0));
  const containerAvg = containerReceivedKg.greaterThan(0) ? containerLanded.dividedBy(containerReceivedKg) : null;
  const containerCurrentAvg = containerRemainingKg.greaterThan(0) ? containerRemaining.dividedBy(containerRemainingKg) : null;
  const hasAdjustments = warehouses.some((w) => !w.adjustmentKg.isZero()) || !m.openingKg.isZero();
  const checks = [
    {
      key: 'stock',
      label: 'Received + transferred in − transferred out − sold ± adjustments = on hand',
      shown: kg(m.openingKg.plus(m.receivedKg).plus(m.transferInKg).minus(m.transferOutKg).minus(m.stockSoldKg).plus(m.adjustmentKg)),
      source: kg(m.onHandKg),
      ok: m.openingKg.plus(m.receivedKg).plus(m.transferInKg).minus(m.transferOutKg).minus(m.stockSoldKg).plus(m.adjustmentKg).minus(m.onHandKg).abs().lessThan('0.001'),
    },
    {
      key: 'warehouses',
      label: 'Warehouses add up to the item’s available stock',
      shown: kg(sumKg(warehouses, (w) => w.availableKg)),
      source: kg(m.availableKg),
      ok: sumKg(warehouses, (w) => w.availableKg).minus(m.availableKg).abs().lessThan('0.001'),
    },
    {
      key: 'transfers',
      label: 'Transfers only move stock: in = out',
      shown: kg(m.transferInKg),
      source: kg(m.transferOutKg),
      ok: m.transferInKg.minus(m.transferOutKg).abs().lessThan('0.001') || !!values.warehouse || !!scope,
    },
    {
      key: 'sold',
      label: 'Sold on invoices = sold in the stock ledger',
      shown: kg(m.soldKg),
      source: kg(m.stockSoldKg),
      ok: m.soldKg.minus(m.stockSoldKg).abs().lessThan('0.001'),
    },
    {
      key: 'shipments',
      label: 'Shipments add up to the item (received, sold)',
      shown: `${kg(sumKg(shipments, (s) => s.receivedKg))} · ${kg(sumKg(shipments, (s) => s.soldKg))}`,
      source: `${kg(m.receivedKg)} · ${kg(m.soldKg)}`,
      ok: sumKg(shipments, (s) => s.receivedKg).minus(m.receivedKg).abs().lessThan('0.001') && sumKg(shipments, (s) => s.soldKg).minus(m.soldKg).abs().lessThan('0.001'),
    },
    ...(showSales
      ? [
          {
            key: 'revenue',
            label: 'Revenue = the invoice lines for this item',
            shown: formatMoney(m.revenue.local, local),
            source: formatMoney(sumLocal(lines.map((l) => l.amount)), local),
            // Credit notes reduce revenue after the lines, so only compare when there are none.
            ok: m.credited.local.isZero() ? m.revenue.local.minus(sumLocal(lines.map((l) => l.amount))).abs().lessThan('0.01') : true,
          },
          {
            key: 'money',
            label: 'Collected + credited + outstanding = invoiced',
            shown: formatMoney(m.collectedTotal.local.plus(m.credited.local).plus(m.outstanding.local), local),
            source: formatMoney(m.invoiced.local, local),
            ok: m.collectedTotal.local.plus(m.credited.local).plus(m.outstanding.local).minus(m.invoiced.local).abs().lessThan('0.01'),
          },
        ]
      : []),
    ...(showCost && !filtered
      ? [
          {
            key: 'containers',
            label: 'Containers add up to the item: landed cost ÷ KG received, remaining value ÷ KG on hand',
            shown: `${containerAvg ? formatMoney(containerAvg, local) : '—'} · ${containerCurrentAvg ? formatMoney(containerCurrentAvg, local) : '—'}`,
            source: `${m.receivedAvgCostPerKg ? formatMoney(m.receivedAvgCostPerKg.local, local) : '—'} · ${m.avgCostPerKg ? formatMoney(m.avgCostPerKg.local, local) : '—'}`,
            ok:
              containerReceivedKg.minus(m.receivedKg).abs().lessThan('0.001') &&
              containerRemainingKg.minus(m.onHandKg).abs().lessThan('0.001') &&
              containerRemaining.minus(m.stockValue.local).abs().lessThan('0.05') &&
              (!containerAvg || !m.receivedAvgCostPerKg || containerAvg.minus(m.receivedAvgCostPerKg.local).abs().lessThan('0.01')),
          },
        ]
      : []),
    ...(both
      ? [
          {
            key: 'profit',
            label: 'Gross profit = revenue − COGS; shipments add up to it',
            shown: formatMoney(sumLocal(shipments.map((s) => s.grossProfit)), local),
            source: formatMoney(m.revenue.local.minus(m.cogs.local), local),
            ok:
              m.grossProfit.local.minus(m.revenue.local.minus(m.cogs.local)).abs().lessThan('0.01') &&
              sumLocal(shipments.map((s) => s.grossProfit)).minus(m.grossProfit.local).abs().lessThan('0.05'),
          },
        ]
      : []),
  ];

  const linesFor = (batchId: string, warehouseId: string) => lines.filter((l) => l.batchId === batchId && l.warehouseId === warehouseId);

  return (
    <div className="space-y-6">
      <PageHeader
        title={item.itemName}
        description="Item stock & profitability — received, sold, where it is, what it cost, what it sold for, what has been collected."
        breadcrumbs={[{ label: 'Inventory' }, { label: 'Stock on Hand', href: '/inventory' }, { label: item.itemName }]}
        actions={<PrintButton />}
      />

      <StockFilters
        action={`/inventory/items/${id}`}
        values={values}
        items={options.items}
        warehouses={options.warehouses}
        shipments={options.shipments}
        batches={options.batches}
        containers={options.containers}
        showItem={false}
      />

      <section aria-labelledby="item-summary" className="space-y-2" data-testid="item-summary">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="item-summary" className="text-base font-semibold uppercase tracking-wide text-ink">
            Item Stock &amp; Profitability
          </h2>
          {node ? <Badge tone={STATUS_META[node.status].tone}>{STATUS_META[node.status].label}</Badge> : null}
          <span className="text-xs text-ink-subtle">{item.originCountry}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Figure testId="item-received" label="Received" value={kg(m.receivedKg)} sub={m.openingKg.isZero() ? undefined : `${kg(m.openingKg)} before the period`} />
          <Figure testId="item-sold" label="Sold" value={kg(m.soldKg)} />
          <Figure
            testId="item-available"
            label="Remaining"
            value={kg(m.availableKg)}
            sub={m.reservedKg.greaterThan(0) ? `${kg(m.reservedKg)} held for drafts` : `In ${warehouses.filter((w) => !w.availableKg.isZero()).length} warehouse(s)`}
          />
          {showCost ? (
            <>
              <Figure testId="item-containers" label="Total containers" value={String(m.containerCount)} sub="Across every shipment of this item" />
              <Figure
                testId="item-received-avg-cost"
                label="Average landed cost / KG"
                info="Weighted average cost based on the actual purchase cost and allocated direct shipment expenses of the stock included in this Item."
                value={perKgText(m.receivedAvgCostPerKg, local)?.primary ?? '—'}
                equivalent={perKgText(m.receivedAvgCostPerKg, local)?.equivalent}
                sub="Overall: every KG received, sold-out containers included"
              />
              <Figure
                testId="item-avg-cost"
                label="Current stock average cost / KG"
                info="Weighted average cost of the inventory currently remaining on hand."
                value={perKgText(m.avgCostPerKg, local)?.primary ?? '—'}
                equivalent={perKgText(m.avgCostPerKg, local)?.equivalent}
                sub={m.onHandKg.isZero() ? 'No stock left' : 'Only the containers still in stock'}
              />
              <Figure testId="item-stock-value" label="Remaining inventory value" value={pt(m.stockValue)!.primary} equivalent={pt(m.stockValue)!.equivalent} sub="What is left, at its landed cost" />
              <Figure
                testId="item-avg-purchase"
                label="Average purchase cost / KG"
                value={usdFirstText(m.avgPurchasePerKg, local, ' / KG')?.primary ?? '—'}
                equivalent={usdFirstText(m.avgPurchasePerKg, local, ' / KG')?.equivalent}
                sub="What is left, before shipment charges"
              />
              <Figure
                testId="item-purchase-value"
                label="Remaining purchase value"
                value={usdFirstText(m.purchaseValue, local)!.primary}
                equivalent={usdFirstText(m.purchaseValue, local)!.equivalent}
                sub="What is left, at the supplier's price"
              />
            </>
          ) : null}
          {showSales ? (
            <Figure testId="item-avg-sell" label="Average selling price / KG" value={perKgText(m.avgSellPerKg, local)?.primary ?? '—'} equivalent={perKgText(m.avgSellPerKg, local)?.equivalent} sub="Revenue ÷ KG sold" />
          ) : null}
        </div>
        {showSales ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Figure testId="item-revenue" label="Sales revenue" value={pt(m.revenue)!.primary} equivalent={pt(m.revenue)!.equivalent} sub={`${m.invoiceCount} invoice${m.invoiceCount === 1 ? '' : 's'}`} />
            {showProfit ? (
              <>
                <Figure testId="item-cogs" label="COGS" value={pt(m.cogs)!.primary} equivalent={pt(m.cogs)!.equivalent} sub="Landed cost of the KG sold" />
                <Figure
                  testId="item-profit"
                  label={profit.label}
                  value={profit.primary}
                  equivalent={profit.equivalent}
                  tone={profit.loss ? 'negative' : m.grossProfit.local.isZero() ? 'default' : 'positive'}
                  sub={perKgText(m.profitPerKg, local) ? `${perKgText(m.profitPerKg, local)!.primary} profit per KG sold` : undefined}
                />
                <Figure testId="item-margin" label="Margin" value={m.marginPct ? formatPercent(m.marginPct) : '—'} sub="Gross profit ÷ revenue" />
              </>
            ) : null}
            <Figure testId="item-collected" label="Collected" value={pt(m.collectedTotal)!.primary} equivalent={pt(m.collectedTotal)!.equivalent} />
            <Figure testId="item-outstanding" label="Outstanding" value={pt(m.outstanding)!.primary} equivalent={pt(m.outstanding)!.equivalent} sub="Still owed on these invoices" />
          </div>
        ) : null}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Stock by warehouse</CardTitle>
          <CardDescription>A transfer moves coffee between warehouses; it never adds to the company&rsquo;s stock.</CardDescription>
        </CardHeader>
        <CardContent>
          <TableWrap>
            <Table data-testid="item-warehouses">
              <THead>
                <TR>
                  <TH>Warehouse</TH>
                  {m.openingKg.isZero() ? null : <TH numeric>Opening</TH>}
                  <TH numeric>Received</TH>
                  <TH numeric>Transferred in</TH>
                  <TH numeric>Transferred out</TH>
                  <TH numeric>Sold</TH>
                  {hasAdjustments ? <TH numeric>Adjusted</TH> : null}
                  <TH numeric>Available</TH>
                  {showCost ? <TH numeric>Stock value</TH> : null}
                </TR>
              </THead>
              <TBody>
                {warehouses.map((w) => (
                  <TR key={w.warehouseId} data-warehouse={w.warehouseName}>
                    <TD>{w.warehouseName}</TD>
                    {m.openingKg.isZero() ? null : <TD numeric>{kg(w.openingKg)}</TD>}
                    <TD numeric>{kg(w.receivedKg)}</TD>
                    <TD numeric>{kg(w.transferInKg)}</TD>
                    <TD numeric>{kg(w.transferOutKg)}</TD>
                    <TD numeric>{kg(w.stockSoldKg)}</TD>
                    {hasAdjustments ? <TD numeric>{kg(w.adjustmentKg)}</TD> : null}
                    <TD numeric className="font-semibold" data-cell="available">
                      {kg(w.availableKg)}
                    </TD>
                    {showCost ? <TD numeric>{money(pt(w.stockValue))}</TD> : null}
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <TR data-warehouse="TOTAL">
                  <TD>TOTAL</TD>
                  {m.openingKg.isZero() ? null : <TD numeric>{kg(m.openingKg)}</TD>}
                  <TD numeric>{kg(sumKg(warehouses, (w) => w.receivedKg))}</TD>
                  <TD numeric>{kg(sumKg(warehouses, (w) => w.transferInKg))}</TD>
                  <TD numeric>{kg(sumKg(warehouses, (w) => w.transferOutKg))}</TD>
                  <TD numeric>{kg(sumKg(warehouses, (w) => w.stockSoldKg))}</TD>
                  {hasAdjustments ? <TD numeric>{kg(sumKg(warehouses, (w) => w.adjustmentKg))}</TD> : null}
                  <TD numeric data-cell="available">{kg(sumKg(warehouses, (w) => w.availableKg))}</TD>
                  {showCost ? <TD numeric>{money(pt(m.stockValue))}</TD> : null}
                </TR>
              </TFoot>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>

      {showSales ? (
        <Card>
          <CardHeader>
            <CardTitle>How the sales were paid</CardTitle>
            <CardDescription>
              Every payment against the invoices for this item, by how it came in. A payment made against a whole invoice is shared over its
              lines in proportion to their value. Money collected by an agent counts as collected for the invoice; it reaches cash or bank
              when the agent settles.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TableWrap className="max-w-2xl">
              <Table data-testid="payment-breakdown">
                <THead>
                  <TR>
                    <TH>How</TH>
                    <TH numeric>Amount</TH>
                  </TR>
                </THead>
                <TBody>
                  {COLLECTION_METHODS.filter((method) => method !== 'LEDGER' || !m.collected[method].local.isZero()).map((method) => (
                    <TR key={method} data-method={method}>
                      <TD>{method === 'AGENT' ? 'Agent collection (collected via agent)' : `${COLLECTION_LABELS[method]} received`}</TD>
                      <TD numeric>{money(pt(m.collected[method]))}</TD>
                    </TR>
                  ))}
                  {m.credited.local.isZero() ? null : (
                    <TR data-method="CREDIT">
                      <TD>Credit notes</TD>
                      <TD numeric>{money(pt(m.credited))}</TD>
                    </TR>
                  )}
                  <TR data-method="OUTSTANDING">
                    <TD className="font-medium">Outstanding</TD>
                    <TD numeric className="font-medium">
                      {money(pt(m.outstanding))}
                    </TD>
                  </TR>
                </TBody>
                <TFoot>
                  <TR data-method="TOTAL">
                    <TD>Total invoiced for this item</TD>
                    <TD numeric>{money(pt(m.invoiced))}</TD>
                  </TR>
                </TFoot>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>By shipment</CardTitle>
          <CardDescription>Which shipment made how much — each at its own landed cost. A sale from any warehouse belongs to the shipment its coffee came in on.</CardDescription>
        </CardHeader>
        <CardContent>
          <TableWrap>
            <Table data-testid="item-shipments">
              <THead>
                <TR>
                  <TH>Shipment reference</TH>
                  <TH>Container</TH>
                  <TH>Batch</TH>
                  <TH numeric>Received KG</TH>
                  <TH numeric>Sold KG</TH>
                  <TH numeric>Remaining KG</TH>
                  {showCost ? <TH numeric>Landed cost/KG</TH> : null}
                  {showSales ? <TH numeric>Sales</TH> : null}
                  {showProfit ? <TH numeric>COGS</TH> : null}
                  {both ? <TH numeric>Profit / loss</TH> : null}
                </TR>
              </THead>
              <TBody>
                {shipments.map((s) => (
                  <TR key={s.shipmentId} data-shipment={s.reference}>
                    <TD>
                      <Link href={`/shipments/${s.shipmentId}`} className="font-mono text-xs text-forest-800 hover:underline">
                        {s.reference}
                      </Link>
                      <span className="block text-[11px] text-ink-subtle">{s.shipmentLabel}</span>
                    </TD>
                    <TD className="font-mono text-xs">{s.containers.map((c) => c.containerNumber ?? '—').join(', ')}</TD>
                    <TD className="text-xs">{s.containers.flatMap((c) => c.batches.map((b) => b.batchNumber)).join(', ')}</TD>
                    <TD numeric>{kg(s.receivedKg)}</TD>
                    <TD numeric>{kg(s.soldKg)}</TD>
                    <TD numeric>{kg(s.availableKg)}</TD>
                    {showCost ? <TD numeric>{money(perKgText(s.avgCostPerKg, local))}</TD> : null}
                    {showSales ? <TD numeric>{money(pt(s.revenue))}</TD> : null}
                    {showProfit ? <TD numeric>{money(pt(s.cogs))}</TD> : null}
                    {both ? <TD numeric>{profitCell(s.grossProfit)}</TD> : null}
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <TR>
                  <TD>Total</TD>
                  <TD />
                  <TD />
                  <TD numeric>{kg(m.receivedKg)}</TD>
                  <TD numeric>{kg(m.soldKg)}</TD>
                  <TD numeric>{kg(m.availableKg)}</TD>
                  {showCost ? <TD numeric>{money(perKgText(m.avgCostPerKg, local))}</TD> : null}
                  {showSales ? <TD numeric>{money(pt(m.revenue))}</TD> : null}
                  {showProfit ? <TD numeric>{money(pt(m.cogs))}</TD> : null}
                  {both ? <TD numeric>{profitCell(m.grossProfit)}</TD> : null}
                </TR>
              </TFoot>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>

      {showCost ? (
        <Card>
          <CardHeader>
            <CardTitle>Cost per batch</CardTitle>
            <CardDescription>
              What a KG of each batch cost: the supplier&apos;s price in USD at its order&apos;s USD/{local} rate, plus its share of the shipment&apos;s charges. Edit the
              order&apos;s rate and these follow.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TableWrap>
              <Table data-testid="item-batch-costs">
                <THead>
                  <TR>
                    <TH>Shipment reference</TH>
                    <TH>Container</TH>
                    <TH>Batch</TH>
                    <TH>Warehouse</TH>
                    <TH numeric>USD/{local} rate</TH>
                    <TH numeric>Purchase / KG</TH>
                    <TH numeric>Allocated expense / KG</TH>
                    <TH numeric>Landed cost / KG</TH>
                    <TH numeric>Received KG</TH>
                    <TH numeric>Sold KG</TH>
                    <TH numeric>Remaining KG</TH>
                    <TH numeric>Remaining purchase value</TH>
                    <TH numeric>Remaining inventory value</TH>
                  </TR>
                </THead>
                <TBody>
                  {shipments.flatMap((s) =>
                    s.containers.flatMap((c) =>
                      c.batches.map((b) => (
                        <TR key={b.batchId} data-batch={b.batchNumber}>
                          <TD>
                            <Link href={`/shipments/${s.shipmentId}`} className="font-mono text-xs text-forest-800 hover:underline">
                              {s.reference}
                            </Link>
                          </TD>
                          <TD className="font-mono text-xs">{c.containerNumber ?? '—'}</TD>
                          <TD className="text-xs">{b.batchNumber}</TD>
                          <TD className="text-xs">{b.warehouses.filter((w) => !w.onHandKg.isZero()).map((w) => w.warehouseName).join(', ') || '—'}</TD>
                          <TD numeric data-testid="batch-rate">{b.rateLocalPerUsd ? b.rateLocalPerUsd.toString() : '—'}</TD>
                          <TD numeric>{money(usdFirstText(b.purchasePerKg, local, ' / KG'))}</TD>
                          <TD numeric>{money(perKgText(b.expensePerKg, local))}</TD>
                          <TD numeric>{money(perKgText(b.landedPerKg, local))}</TD>
                          <TD numeric>{kg(b.receivedKg)}</TD>
                          <TD numeric>{kg(b.soldKg)}</TD>
                          <TD numeric>{kg(b.onHandKg)}</TD>
                          <TD numeric>{money(usdFirstText(b.purchaseValue, local))}</TD>
                          <TD numeric>{money(pt(b.stockValue))}</TD>
                        </TR>
                      )),
                    ),
                  )}
                </TBody>
                <TFoot>
                  <TR>
                    <TD>Total</TD>
                    <TD />
                    <TD />
                    <TD />
                    <TD />
                    <TD numeric>{money(usdFirstText(m.avgPurchasePerKg, local, ' / KG'))}</TD>
                    <TD />
                    <TD numeric>{money(perKgText(m.avgCostPerKg, local))}</TD>
                    <TD numeric>{kg(m.receivedKg)}</TD>
                    <TD numeric>{kg(m.soldKg)}</TD>
                    <TD numeric>{kg(m.onHandKg)}</TD>
                    <TD numeric>{money(usdFirstText(m.purchaseValue, local))}</TD>
                    <TD numeric>{money(pt(m.stockValue))}</TD>
                  </TR>
                </TFoot>
              </Table>
            </TableWrap>
            <dl className="grid gap-x-6 gap-y-1 px-1 pt-3 text-xs sm:grid-cols-2" data-testid="item-cost-reconciliation">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Total KG received (containers)</dt>
                <dd className="tnum">{kg(containerReceivedKg)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Total landed cost of KG received</dt>
                <dd className="tnum">{formatMoney(toMoney(containerLanded), local)}</dd>
              </div>
              <div className="flex justify-between gap-3 font-semibold">
                <dt>Weighted average landed cost / KG</dt>
                <dd className="tnum">{containerAvg ? formatMoney(toUnitCost(containerAvg), local) : '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Remaining KG (containers)</dt>
                <dd className="tnum">{kg(containerRemainingKg)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">Remaining inventory cost</dt>
                <dd className="tnum">{formatMoney(toMoney(containerRemaining), local)}</dd>
              </div>
              <div className="flex justify-between gap-3 font-semibold">
                <dt>Current stock weighted average cost / KG</dt>
                <dd className="tnum">{containerCurrentAvg ? formatMoney(toUnitCost(containerCurrentAvg), local) : '—'}</dd>
              </div>
            </dl>
            <p className="px-1 pt-2 text-[11px] text-ink-subtle">
              Each container&apos;s KG at its own landed cost, added up — never an average of the containers&apos; averages.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Drill down</CardTitle>
          <CardDescription>Shipment → container → batch → warehouse → the invoices that sold it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2" data-testid="item-drilldown">
          {shipments.map((s) => (
            <details key={s.shipmentId} className="rounded-lg border border-line" data-level="shipment" data-ref={s.reference}>
              <summary className="cursor-pointer px-3 py-2 text-sm">
                <DrillLine title={`${s.reference} · ${s.shipmentLabel}`} m={s} local={local} showCost={showCost} showProfit={showProfit} showSales={showSales} />
              </summary>
              <div className="space-y-2 border-t border-line p-2 pl-4">
                {s.containers.map((c) => (
                  <details key={c.containerKey || 'none'} className="rounded-lg border border-line" data-level="container" data-ref={c.containerNumber ?? ''}>
                    <summary className="cursor-pointer px-3 py-2 text-sm">
                      <DrillLine title={`Container ${c.containerNumber ?? '—'}`} m={c} local={local} showCost={showCost} showProfit={showProfit} showSales={showSales} />
                    </summary>
                    <div className="space-y-2 border-t border-line p-2 pl-4">
                      {c.batches.map((b) => (
                        <details key={b.batchId} className="rounded-lg border border-line" data-level="batch" data-ref={b.batchNumber}>
                          <summary className="cursor-pointer px-3 py-2 text-sm">
                            <DrillLine title={`Batch ${b.batchNumber} · lot ${b.lotNumber}`} m={b} local={local} showCost={showCost} showProfit={showProfit} showSales={showSales} />
                          </summary>
                          <div className="space-y-3 border-t border-line p-2 pl-4">
                            <Link href={`/inventory/batches/${b.batchId}`} className="text-xs font-medium text-forest-800 hover:underline">
                              Open batch {b.batchNumber}
                            </Link>
                            {b.warehouses.map((w) => {
                              const sold = linesFor(b.batchId, w.warehouseId);
                              return (
                                <div key={w.warehouseId} className="rounded-lg border border-line/70 p-2" data-level="warehouse" data-ref={w.warehouseName}>
                                  <DrillLine title={w.warehouseName} m={w} local={local} showCost={showCost} showProfit={showProfit} showSales={showSales} />
                                  {showSales && sold.length > 0 ? (
                                    <SalesTable lines={sold} local={local} showCost={showProfit} compact />
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </details>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          ))}
          {shipments.length === 0 ? <p className="text-sm text-ink-subtle">Nothing received or sold in this view.</p> : null}
        </CardContent>
      </Card>

      {showSales ? (
        <Card>
          <CardHeader>
            <CardTitle>Sales against this item</CardTitle>
            <CardDescription>
              Each invoice line for this coffee — the line&rsquo;s amount, never the whole invoice. Paid and outstanding are the line&rsquo;s share of
              the invoice; where an invoice sells other items too, its own total, paid and outstanding are shown under the status.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SalesTable lines={lines} local={local} showCost={showProfit} />
          </CardContent>
        </Card>
      ) : null}

      <details className="rounded-xl border border-line bg-surface p-4 shadow-card" data-testid="item-reconciliation" open={checks.some((c) => !c.ok)}>
        <summary className="cursor-pointer text-sm font-semibold text-ink">
          Reconciliation — {checks.every((c) => c.ok) ? `all ${checks.length} checks agree` : `${checks.filter((c) => !c.ok).length} of ${checks.length} checks disagree`}
        </summary>
        <table className="data-grid grid-framed mt-3 w-full text-sm">
          <tbody>
            {checks.map((c) => (
              <tr key={c.key} data-check={c.key} data-ok={c.ok ? 'true' : 'false'}>
                <td className="py-1.5 pr-3">{c.label}</td>
                <td className="tnum py-1.5 pr-3 text-right">{c.shown}</td>
                <td className="tnum py-1.5 pr-3 text-right">{c.source}</td>
                <td className={c.ok ? 'py-1.5 text-emerald-700' : 'py-1.5 font-semibold text-red-700'}>{c.ok ? 'Agrees' : 'Disagrees'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-ink-subtle">
          Figures in {local}; ≈ USD is each transaction at its own rate. Cost of goods sold is the KG sold at its batch&rsquo;s landed cost — the
          same figure Shipment Profitability shows.
          {query ? ' Filters apply to every figure on this page.' : ''}
        </p>
      </details>
    </div>
  );
}

/** One level of the drill-down, in a line. */
function DrillLine({
  title,
  m,
  local,
  showCost,
  showProfit,
  showSales,
}: {
  title: string;
  m: ItemMeasures;
  local: string;
  showCost: boolean;
  showProfit: boolean;
  showSales: boolean;
}) {
  const profit = profitText(m.grossProfit, local);
  const facts: Array<[string, string, string?]> = [
    ['Received', kg(m.receivedKg)],
    ...(m.transferInKg.isZero() ? [] : [['In', kg(m.transferInKg)] as [string, string]]),
    ...(m.transferOutKg.isZero() ? [] : [['Out', kg(m.transferOutKg)] as [string, string]]),
    ['Sold', kg(m.soldKg)],
    ['Remaining', kg(m.availableKg)],
    ...(showCost && m.avgCostPerKg ? [['Landed/KG', perKgText(m.avgCostPerKg, local)!.primary] as [string, string]] : []),
    ...(showSales ? [['Sales', formatMoney(m.revenue.local, local)] as [string, string]] : []),
    ...(showProfit ? [['COGS', formatMoney(m.cogs.local, local)] as [string, string]] : []),
    ...(showProfit && showSales ? [[profit.loss ? 'Loss' : 'Profit', formatMoney(m.grossProfit.local.abs(), local), profit.loss ? 'loss' : 'profit'] as [string, string, string]] : []),
  ];
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span className="font-medium text-ink">{title}</span>
      {facts.map(([label, value, tone]) => (
        <span key={label} className="text-xs text-ink-muted" data-fact={label}>
          {label}{' '}
          <span className={cn('tnum font-medium text-ink', tone === 'loss' && 'text-red-700', tone === 'profit' && 'text-emerald-800')}>{value}</span>
        </span>
      ))}
    </span>
  );
}

/** Invoice lines for the item, with each line's share of what was paid. */
function SalesTable({ lines, local, showCost, compact = false }: { lines: ItemSaleLine[]; local: string; showCost: boolean; compact?: boolean }) {
  if (lines.length === 0) return <p className="text-sm text-ink-subtle">No sales in this view.</p>;
  const total = (pick: (l: ItemSaleLine) => Pair): Pair =>
    lines.reduce((s, l) => ({ local: s.local.plus(pick(l).local), usd: s.usd.plus(pick(l).usd) }), { local: new Decimal(0), usd: new Decimal(0) });
  const qty = toQuantity(lines.reduce((s, l) => s.plus(l.quantityKg), new Decimal(0)));
  const cell = (p: Pair) => <DualText primary={formatMoney(p.local, local)} equivalent={local === 'USD' ? null : { text: `≈ ${formatMoney(p.usd, 'USD')}`, title: 'At the USD/MAD rate of the order the coffee came from' }} />;
  return (
    <TableWrap className={compact ? 'mt-2' : undefined}>
      <Table data-testid={compact ? 'drill-sales' : 'item-sales'}>
        <THead>
          <TR>
            <TH>Invoice</TH>
            <TH>Date</TH>
            <TH>Customer</TH>
            {compact ? null : <TH>Shipment ref</TH>}
            {compact ? null : <TH>Batch</TH>}
            {compact ? null : <TH>Warehouse</TH>}
            <TH numeric>Qty sold</TH>
            <TH numeric>Rate</TH>
            <TH numeric>Invoice amount</TH>
            <TH numeric>Paid</TH>
            <TH numeric>Outstanding</TH>
            {showCost ? <TH numeric>Profit / loss</TH> : null}
            <TH>Status</TH>
          </TR>
        </THead>
        <TBody>
          {lines.map((l) => (
            <TR key={l.lineId} data-invoice={l.invoiceNumber}>
              <TD>
                <Link href={`/sales/${l.invoiceId}`} className="font-mono text-xs text-forest-800 hover:underline">
                  {shortDocumentNumber(l.invoiceNumber)}
                </Link>
              </TD>
              <TD className="whitespace-nowrap">{formatDate(l.invoiceDate)}</TD>
              <TD>
                <Link href={`/customers/${l.customerId}`} className="hover:underline">
                  {l.customerName}
                </Link>
              </TD>
              {compact ? null : (
                <TD className="text-xs">
                  <span className="font-mono">{l.reference}</span>
                  <span className="block text-[11px] text-ink-subtle">{l.shipmentLabel}</span>
                </TD>
              )}
              {compact ? null : <TD className="text-xs">{l.batchNumber}</TD>}
              {compact ? null : <TD className="text-xs">{l.warehouseName}</TD>}
              <TD numeric>{kg(l.quantityKg)}</TD>
              <TD numeric>{`${formatMoney(l.ratePerKg, l.currency)} / KG`}</TD>
              <TD numeric>{cell(l.gross)}</TD>
              <TD numeric>{cell(l.collectedTotal)}</TD>
              <TD numeric className={l.outstanding.local.greaterThan(0) ? 'font-semibold' : undefined}>
                {cell(l.outstanding)}
              </TD>
              {showCost ? (
                <TD numeric className={l.profit.local.isNegative() ? 'text-red-700' : 'text-emerald-800'}>
                  {l.profit.local.isNegative() ? `Loss ${formatMoney(l.profit.local.abs(), local)}` : formatMoney(l.profit.local, local)}
                </TD>
              ) : null}
              <TD>
                <Badge tone={STATUS_TONE[l.status]}>{STATUS_LABEL[l.status]}</Badge>
                {l.shared ? (
                  <span className="mt-0.5 block text-[11px] text-ink-subtle" data-invoice-totals>
                    Invoice {formatMoney(l.invoiceTotal.local, local)} · paid {formatMoney(l.invoicePaid.local, local)} · outstanding{' '}
                    {formatMoney(l.invoiceOutstanding.local, local)}
                  </span>
                ) : null}
              </TD>
            </TR>
          ))}
        </TBody>
        <TFoot>
          <TR>
            <TD>Total</TD>
            <TD />
            <TD />
            {compact ? null : <TD />}
            {compact ? null : <TD />}
            {compact ? null : <TD />}
            <TD numeric>{kg(qty)}</TD>
            <TD />
            <TD numeric>{cell(total((l) => l.gross))}</TD>
            <TD numeric>{cell(total((l) => l.collectedTotal))}</TD>
            <TD numeric>{cell(total((l) => l.outstanding))}</TD>
            {showCost ? <TD numeric>{formatMoney(toMoney(total((l) => l.profit).local), local)}</TD> : null}
            <TD />
          </TR>
        </TFoot>
      </Table>
    </TableWrap>
  );
}
