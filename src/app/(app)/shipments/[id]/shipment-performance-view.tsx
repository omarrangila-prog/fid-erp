import Link from 'next/link';
import type { Decimal } from '@/lib/money';
import { dec } from '@/lib/money';
import { formatDate, formatMoney, formatPercent, formatQuantityKg } from '@/lib/format';
import { Metric, MetricGrid } from '@/components/shared/stat-card';
import { DualAmount } from '@/components/shared/dual-amount';
import { Badge } from '@/components/ui/badge';
import { SHIPMENT_STAGE_LABELS, type ShipmentResult } from '@/lib/services/shipment-performance';

/** The figures the view reads — all from the shipment's cost sheet and profitability, none worked out here. */
export type PerformanceFigures = {
  local: string;
  rateLocalPerUsd: Decimal;
  soldKg: Decimal;
  revenueLocal: Decimal;
  cogsLocal: Decimal;
  grossProfitLocal: Decimal;
  grossMarginPct: Decimal;
  remainingKg: Decimal;
  remainingPurchasePerKgUsd: Decimal | null;
  remainingAvgCostPerKgLocal: Decimal | null;
  remainingPurchaseUsd: Decimal;
  remainingPurchaseLocal: Decimal;
  remainingLandedLocal: Decimal;
  totalLandedLocal: Decimal;
  warehouses: Array<{ name: string; kg: Decimal }>;
};

const MGMT = "Management equivalent at this order's USD/MAD rate";

function Section({ title, hint, children, testId }: { title: string; hint?: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="space-y-3 rounded-xl border border-line p-4" data-testid={testId}>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
        {hint ? <p className="text-xs text-ink-subtle">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A shipment's performance, in the order the client reads it: what the coffee
 * already sold made, what the coffee still here cost, and — only once the
 * shipment is closed — the final result. Stock still in hand is an asset at
 * cost, never profit, so it has its own section and is in no profit figure.
 */
export function ShipmentPerformanceView({
  f,
  result,
  showProfit,
  closedAt,
  shipmentId,
}: {
  f: PerformanceFigures;
  result: ShipmentResult;
  showProfit: boolean;
  closedAt: Date | null;
  shipmentId: string;
}) {
  const mad = (value: Decimal) => <DualAmount amount={value} currency={f.local} localCurrency={f.local} rateLocalPerUsd={f.rateLocalPerUsd} rateSource={MGMT} />;
  const usd = (value: Decimal, localValue: Decimal) => (
    <DualAmount amount={value} currency="USD" localCurrency={f.local} amountLocal={localValue} rateLocalPerUsd={f.rateLocalPerUsd} rateSource="This order's USD/MAD rate" />
  );
  const grossLoss = f.grossProfitLocal.isNegative();
  const netLoss = result.netLocal.isNegative();
  const stage = result.stage;
  // COGS + what is left = the landed cost; anything else is a stock count or write-off.
  const difference = f.totalLandedLocal.minus(f.cogsLocal).minus(f.remainingLandedLocal);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" data-testid="shipment-stage">
        <Badge tone={stage === 'CLOSED' ? 'neutral' : stage === 'SOLD_OUT_PENDING' ? 'warning' : 'success'}>{SHIPMENT_STAGE_LABELS[stage]}</Badge>
        {stage === 'CLOSED' && closedAt ? <span className="text-xs text-ink-subtle">Closed {formatDate(closedAt)}</span> : null}
        {stage === 'SOLD_OUT_PENDING' ? (
          <span className="text-xs text-ink-subtle">Close the shipment from its status once every cost is in — the result is final only then.</span>
        ) : null}
      </div>

      {showProfit ? (
        <Section title="Sold goods performance" hint="Profit earned on goods already sold." testId="sold-goods">
          <MetricGrid>
            <Metric label="Sold quantity" value={formatQuantityKg(f.soldKg)} />
            <Metric label="Sales revenue" value={mad(f.revenueLocal)} />
            <Metric label="COGS of sold goods" value={mad(f.cogsLocal)} tone="muted" />
            <Metric
              label={grossLoss ? 'Gross loss on sold goods' : 'Gross profit on sold goods'}
              value={mad(f.grossProfitLocal)}
              tone={grossLoss ? 'negative' : 'positive'}
            />
            <Metric label="Gross margin" value={formatPercent(f.grossMarginPct)} tone={grossLoss ? 'negative' : 'default'} />
            <Metric label={grossLoss ? 'Loss / KG sold' : 'Profit / KG sold'} value={result.profitPerKgSold ? mad(result.profitPerKgSold) : '—'} />
          </MetricGrid>
          <p className="text-xs text-ink-subtle">
            Sales revenue less the cost of the KG sold. Collected and outstanding are shown at the top of the page; they do not change the profit.{' '}
            <a href="#sales-invoices" className="text-forest-800 hover:underline">
              The invoices
            </a>
          </p>
        </Section>
      ) : null}

      <Section title="Goods in hand — remaining available for sale" hint="Cost value of goods still available for sale. An asset at cost, not profit." testId="remaining-stock-value">
        <MetricGrid>
          <Metric label="Remaining available for sale" value={<span data-testid="remaining-kg">{formatQuantityKg(f.remainingKg)}</span>} />
          <Metric
            label="Avg purchase cost / KG"
            value={f.remainingPurchasePerKgUsd ? usd(f.remainingPurchasePerKgUsd, f.remainingPurchasePerKgUsd.times(f.rateLocalPerUsd)) : '—'}
          />
          <Metric label="Avg landed cost / KG" value={<span data-testid="remaining-avg-cost">{f.remainingAvgCostPerKgLocal ? mad(f.remainingAvgCostPerKgLocal) : '—'}</span>} />
          <Metric label="Remaining purchase value" value={usd(f.remainingPurchaseUsd, f.remainingPurchaseLocal)} hint="The supplier's price of what is left" />
          <Metric label="Remaining inventory value" value={<span data-testid="remaining-value">{mad(f.remainingLandedLocal)}</span>} hint="What is left at landed cost" />
        </MetricGrid>
        {f.warehouses.length ? (
          <ul className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3" data-testid="remaining-by-warehouse">
            {f.warehouses.map((w) => (
              <li key={w.name} className="flex justify-between gap-3 rounded-md bg-surface-sunken px-3 py-1.5">
                <span className="truncate">{w.name}</span>
                <span className="tnum font-medium">{formatQuantityKg(w.kg)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-ink-subtle">
          Each container at its own landed cost — the same figures as Stock on Hand.{' '}
          <Link href={`/inventory?shipment=${shipmentId}`} className="text-forest-800 hover:underline">
            Open in Stock on Hand
          </Link>
        </p>
      </Section>

      {showProfit ? (
        <p className="text-xs text-ink-subtle" data-testid="cost-reconciliation">
          COGS {formatMoney(f.cogsLocal, f.local)} + remaining inventory {formatMoney(f.remainingLandedLocal, f.local)} = {formatMoney(f.cogsLocal.plus(f.remainingLandedLocal), f.local)} of{' '}
          {formatMoney(f.totalLandedLocal, f.local)} landed
          {difference.abs().lessThan('0.05') ? ' ✓' : ` — ${formatMoney(difference, f.local)} written off or adjusted by stock counts`}.
        </p>
      ) : null}

      {showProfit && stage === 'CLOSED' ? (
        <Section title="Final shipment result" hint="Final profit after the shipment is fully sold and all applicable costs are included." testId="profit-final">
          <MetricGrid>
            <Metric label="Total sales revenue" value={mad(f.revenueLocal)} />
            <Metric label="Total COGS" value={mad(f.cogsLocal)} tone="muted" />
            <Metric label={grossLoss ? 'Gross loss' : 'Gross profit'} value={mad(f.grossProfitLocal)} tone={grossLoss ? 'negative' : 'positive'} />
            {result.hasDeductions ? (
              <>
                <Metric label="Period / allocated expenses" value={mad(result.periodCostsLocal.plus(result.overheadLocal))} tone="muted" />
                <Metric label={netLoss ? 'Final net loss' : 'Final net profit'} value={mad(result.netLocal)} tone={netLoss ? 'negative' : 'positive'} />
                <Metric label="Net margin" value={result.netMarginPct ? formatPercent(result.netMarginPct) : '—'} tone={netLoss ? 'negative' : 'default'} />
              </>
            ) : (
              <Metric
                label={grossLoss ? 'Final gross loss' : 'Final gross profit'}
                value={mad(f.grossProfitLocal)}
                tone={grossLoss ? 'negative' : 'positive'}
                hint="Net profit unavailable: no company overhead is allocated to this shipment"
              />
            )}
            <Metric label="Remaining inventory value" value={mad(dec(0))} tone="muted" />
          </MetricGrid>
        </Section>
      ) : null}

      {showProfit && stage !== 'CLOSED' && result.hasDeductions ? (
        <Section title="Profit to date" hint="Not final — the shipment is still open." testId="profit-to-date">
          <MetricGrid>
            <Metric label="Period / allocated expenses to date" value={mad(result.periodCostsLocal.plus(result.overheadLocal))} tone="muted" />
            <Metric label={netLoss ? 'Current net loss / loss to date' : 'Current net profit / profit to date'} value={mad(result.netLocal)} tone={netLoss ? 'negative' : 'positive'} />
            <Metric label="Final net profit" value="Not final" tone="muted" />
          </MetricGrid>
        </Section>
      ) : null}
    </div>
  );
}
