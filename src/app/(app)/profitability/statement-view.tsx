import Link from 'next/link';
import { getShipmentProfitability, getShipmentExpensesByCategory, type ShipmentProfitability } from '@/lib/services/profitability';
import { getShipmentOrdinals, shipmentOrdinalLabel } from '@/lib/services/shipment';
import { Decimal, dec, sum } from '@/lib/money';
import { formatMoney, formatQuantityKg, formatPercent, formatDate } from '@/lib/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { shipmentStage, shipmentResult, getClosedDates, SHIPMENT_STAGE_LABELS } from '@/lib/services/shipment-performance';

/**
 * The profitability statement the client laid out: one column per shipment,
 * the measures down the side, a total on the right. Purchase, direct
 * expenses and landed cost first; then what sold and what is left; then
 * revenue, cost of sales, profit and margin. Every figure is the same one
 * the job table shows, only turned on its side.
 */
export async function ProfitabilityStatement({
  companyId,
  local,
  contractId,
}: {
  companyId: string;
  local: string;
  /** Narrow the columns to one order's shipments. */
  contractId?: string;
}) {
  const [all, ordinals, expensesByShipment] = await Promise.all([
    getShipmentProfitability({ companyId }),
    getShipmentOrdinals(companyId),
    getShipmentExpensesByCategory({ companyId }),
  ]);
  const rows = (contractId ? all.filter((r) => r.contractId === contractId) : all).slice().reverse();
  const hasOverhead = rows.some((r) => !r.allocatedOverheadUsd.isZero());
  /*
   * Each column's stage: profit on what sold, stock in hand at cost apart
   * from it, and a final result only for a closed shipment.
   */
  const closedDates = await getClosedDates(companyId, rows.map((r) => r.shipmentId));
  const stageOf = new Map(
    rows.map((r) => {
      const stage = shipmentStage({ remainingKg: r.onHandQuantityKg, soldKg: r.soldQuantityKg, closed: r.status === 'CLOSED' });
      const result = shipmentResult({
        stage,
        revenueLocal: r.salesRevenueLocal,
        grossProfitLocal: r.grossProfitLocal,
        soldKg: r.soldQuantityKg,
        periodCostsLocal: r.otherCostsLocal,
        overheadLocal: r.allocatedOverheadLocal,
      });
      return [r.shipmentId, { stage, result }] as const;
    }),
  );
  const isFinal = (r: ShipmentProfitability) => stageOf.get(r.shipmentId)!.stage === 'CLOSED';

  // Every direct-cost category booked to any of these shipments, each its own
  // line — freight, clearing, transport — so the total is not one opaque sum.
  const categories = [
    ...new Set(
      rows.flatMap((r) => (expensesByShipment.get(r.shipmentId) ?? []).filter((e) => e.capitalised).map((e) => e.category)),
    ),
  ].sort();
  const categoryAmount = (shipmentId: string, category: string) =>
    dec((expensesByShipment.get(shipmentId) ?? []).find((e) => e.capitalised && e.category === category)?.amountUsd ?? 0);

  type Measure = {
    key: string;
    label: string;
    of: (r: ShipmentProfitability) => Decimal;
    kind: 'kg' | 'usd' | 'local' | 'pct' | 'unitUsd' | 'unitLocal';
    /** How the total column is built: a plain sum, or recomputed from sums. */
    total?: (totals: Map<string, Decimal>) => Decimal;
    emphasis?: 'strong' | 'final';
    tone?: 'profit';
    group?: string;
    /** Words instead of the figure for this column — "Not final" for an open shipment. */
    text?: (r: ShipmentProfitability) => string | null;
    /** Words instead of the total. */
    totalText?: string;
  };

  const ratio = (a: Decimal, b: Decimal) => (b.isZero() ? new Decimal(0) : a.dividedBy(b));
  const measures: Measure[] = [
    { key: 'purchasedKg', label: 'Purchased', of: (r) => r.purchaseQuantityKg, kind: 'kg', group: 'Quantity' },
    { key: 'receivedKg', label: 'Received', of: (r) => r.receivedQuantityKg, kind: 'kg' },
    { key: 'soldKg', label: 'Sold', of: (r) => r.soldQuantityKg, kind: 'kg' },
    { key: 'remainingKg', label: 'Remaining stock (purchased less sold)', of: (r) => r.remainingQuantityKg, kind: 'kg' },
    { key: 'onHandKg', label: 'Remaining available for sale', of: (r) => r.onHandQuantityKg, kind: 'kg', group: 'Goods in hand — at cost, not profit' },
    { key: 'closingValueLocal', label: `Remaining inventory value (${local})`, of: (r) => r.closingStockValueLocal, kind: 'local', emphasis: 'strong' },
    { key: 'closingValue', label: 'Remaining inventory value (USD)', of: (r) => r.closingStockValueUsd, kind: 'usd' },

    { key: 'purchaseUsd', label: 'Purchase cost', of: (r) => r.goodsCostUsd, kind: 'usd', group: 'Landed cost' },
    ...categories.map(
      (category): Measure => ({
        key: `cat-${category}`,
        label: `  ${category}`,
        of: (r) => categoryAmount(r.shipmentId, category),
        kind: 'usd',
      }),
    ),
    { key: 'directUsd', label: 'Total direct shipment expenses', of: (r) => r.capitalisedCostUsd, kind: 'usd', emphasis: 'strong' },
    { key: 'landedUsd', label: 'Total landed cost', of: (r) => r.totalLandedCostUsd, kind: 'usd', emphasis: 'strong' },
    { key: 'purchaseLocal', label: `Purchase cost (${local})`, of: (r) => r.goodsCostLocal, kind: 'local' },
    { key: 'directLocal', label: `Direct shipment expenses (${local})`, of: (r) => r.capitalisedCostLocal, kind: 'local' },
    { key: 'landedLocal', label: `Total landed cost (${local})`, of: (r) => r.totalLandedCostLocal, kind: 'local', emphasis: 'strong' },
    {
      key: 'costPerKg',
      label: 'Landed cost per KG',
      of: (r) => r.landedCostPerKgUsd,
      kind: 'unitUsd',
      total: (t) => ratio(t.get('landedUsd')!, t.get('purchasedKg')!),
    },
    {
      key: 'costPerKgLocal',
      label: `Landed cost per KG (${local})`,
      of: (r) => r.landedCostPerKgLocal,
      kind: 'unitLocal',
      total: (t) => ratio(t.get('landedLocal')!, t.get('purchasedKg')!),
    },

    { key: 'revenueUsd', label: 'Sales revenue', of: (r) => r.salesRevenueUsd, kind: 'usd', group: 'Sold goods performance' },
    {
      key: 'avgPrice',
      label: 'Average selling price per KG',
      of: (r) => r.averageSellingPriceUsd,
      kind: 'unitUsd',
      total: (t) => ratio(t.get('revenueUsd')!, t.get('soldKg')!),
    },
    { key: 'cogsUsd', label: 'Cost of goods sold', of: (r) => r.allocatedLandedCostUsd, kind: 'usd' },
    { key: 'grossUsd', label: 'Gross profit on sold goods', of: (r) => r.grossProfitUsd, kind: 'usd', emphasis: 'strong', tone: 'profit' },
    { key: 'otherUsd', label: 'Other shipment costs', of: (r) => r.otherCostsUsd, kind: 'usd' },
    { key: 'netUsd', label: 'Net profit — to date until closed', of: (r) => r.netProfitUsd, kind: 'usd', emphasis: 'strong', tone: 'profit' },
    { key: 'revenueLocal', label: `Sales revenue (${local})`, of: (r) => r.salesRevenueLocal, kind: 'local' },
    { key: 'cogsLocal', label: `Cost of goods sold (${local})`, of: (r) => r.allocatedLandedCostLocal, kind: 'local' },
    { key: 'grossLocal', label: `Gross profit on sold goods (${local})`, of: (r) => r.grossProfitLocal, kind: 'local', emphasis: 'strong', tone: 'profit' },
    { key: 'netLocal', label: `Net profit — to date until closed (${local})`, of: (r) => r.netProfitLocal, kind: 'local', emphasis: 'strong', tone: 'profit' },
    {
      key: 'finalLocal',
      label: `Final net profit / loss (${local})`,
      of: (r) => (isFinal(r) ? stageOf.get(r.shipmentId)!.result.netLocal : new Decimal(0)),
      kind: 'local',
      emphasis: 'final',
      tone: 'profit',
      text: (r) => (isFinal(r) ? null : 'Not final'),
      totalText: rows.every(isFinal) ? undefined : 'Closed shipments only',
    },
    {
      key: 'grossMargin',
      label: 'Gross margin',
      of: (r) => r.grossMarginPct,
      kind: 'pct',
      total: (t) => ratio(t.get('grossUsd')!, t.get('revenueUsd')!).times(100),
      group: 'Margin',
    },
    {
      key: 'netMargin',
      label: 'Net margin',
      of: (r) => r.netMarginPct,
      kind: 'pct',
      total: (t) => ratio(t.get('netUsd')!, t.get('revenueUsd')!).times(100),
    },
    {
      key: 'profitPerKg',
      label: 'Profit per KG sold',
      of: (r) => r.profitPerKgUsd,
      kind: 'unitUsd',
      total: (t) => ratio(t.get('netUsd')!, t.get('soldKg')!),
    },
    ...(hasOverhead
      ? ([
          { key: 'overheadUsd', label: 'Share of company overheads (management view)', of: (r) => r.allocatedOverheadUsd, kind: 'usd', group: 'After overheads' },
          { key: 'afterOverheadUsd', label: 'Profit after overheads', of: (r) => r.profitAfterOverheadUsd, kind: 'usd', emphasis: 'final', tone: 'profit' },
        ] as Measure[])
      : []),
  ];

  // Totals: sums for amounts, recomputed from the sums for rates and ratios.
  const totals = new Map<string, Decimal>();
  for (const m of measures) if (!m.total) totals.set(m.key, sum(rows.map((r) => dec(m.of(r)))));
  for (const m of measures) if (m.total) totals.set(m.key, m.total(totals));

  const format = (m: Measure, value: Decimal) => {
    switch (m.kind) {
      case 'kg':
        return formatQuantityKg(value);
      case 'usd':
        return formatMoney(value, 'USD');
      case 'local':
        return formatMoney(value, local);
      case 'pct':
        return formatPercent(value);
      case 'unitUsd':
        return formatMoney(value, 'USD');
      case 'unitLocal':
        return formatMoney(value, local);
    }
  };
  const toneOf = (m: Measure, value: Decimal) => (m.tone === 'profit' ? (value.isNegative() ? 'text-red-600' : 'text-gold-700') : '');

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-ink-subtle">No approved shipments to lay out yet.</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shipment profitability statement</CardTitle>
        <CardDescription>
          One column per shipment, with a total on the right. Local figures use each order&rsquo;s contract rate for cost and
          each invoice&rsquo;s rate for sales; margins in the total column are recomputed from the totals.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto border-t border-line" data-wide-sheet>
          <table className="data-grid grid-framed w-full min-w-[40rem] text-sm" data-testid="profitability-statement">
            <thead>
              <tr className="border-b border-line-strong text-[11px] uppercase tracking-wider text-ink-muted">
                <th className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-semibold">Measure</th>
                {rows.map((r) => (
                  <th key={r.shipmentId} className="min-w-[10rem] px-3 py-2 text-right font-semibold normal-case tracking-normal">
                    <Link href={`/shipments/${r.shipmentId}`} className="text-forest-800 hover:text-gold-700 hover:underline">
                      {r.contractReference}
                    </Link>
                    <span className="block text-[11px] font-normal text-ink-subtle">{shipmentOrdinalLabel(ordinals.get(r.shipmentId))}</span>
                    <span className="block text-[11px] font-normal text-ink-muted">{r.itemName}</span>
                    <span className="block text-[11px] font-normal text-ink-subtle" data-testid="statement-stage">
                      {SHIPMENT_STAGE_LABELS[stageOf.get(r.shipmentId)!.stage]}
                      {closedDates.get(r.shipmentId) ? ` · ${formatDate(closedDates.get(r.shipmentId)!)}` : ''}
                    </span>
                  </th>
                ))}
                <th className="min-w-[9rem] border-l border-line px-3 py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {measures.map((m) => (
                <tr
                  key={m.key}
                  className={cn(
                    'hover:bg-surface-sunken/40',
                    m.emphasis === 'strong' && 'bg-surface-sunken/30 font-semibold',
                    m.emphasis === 'final' && 'grid-total grid-final',
                  )}
                >
                  <td className="sticky left-0 z-10 bg-surface px-3 py-1.5 text-left">
                    {m.group ? <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">{m.group}</span> : null}
                    {m.label}
                  </td>
                  {rows.map((r) => {
                    const value = m.of(r);
                    const words = m.text?.(r) ?? null;
                    return (
                      <td key={r.shipmentId} className={cn('tnum px-3 py-1.5 text-right', words ? 'text-ink-subtle' : toneOf(m, value))}>
                        {words ?? format(m, value)}
                      </td>
                    );
                  })}
                  <td className={cn('tnum border-l border-line px-3 py-1.5 text-right font-semibold', m.totalText ? 'text-ink-subtle' : toneOf(m, totals.get(m.key)!))}>
                    {m.totalText ?? format(m, totals.get(m.key)!)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
