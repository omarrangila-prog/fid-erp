import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS, SHIPMENT_STATUS_META } from '@/lib/constants';
import { getOrderCostSheets, type OrderCostSheet } from '@/lib/services/order-cost';
import { formatMoney, formatDate, formatQuantityKg } from '@/lib/format';
import { dec, sum } from '@/lib/money';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { PrintButton } from '@/components/shared/print-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { FavouriteStar } from '@/components/reports/report-statement';
import { PrintHeader } from '@/components/shared/print-header';
import { MemoCell } from '@/components/shared/memo-cell';
import { businessNumber } from '@/lib/short-number';
import { OpenAllForPrint } from '@/app/(app)/reports/shipment-cost/open-for-print';

export const metadata: Metadata = { title: 'Shipment Costing' };
export const dynamic = 'force-dynamic';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What each shipment of coffee cost and earned, one collapsed row per
 * shipment.
 *
 * A shipment is the order it was bought on — its ICUL/FID reference — with
 * every container, item and batch under it. Two orders are two rows, however
 * many containers each has. The row carries the figures a trader asks for
 * first (kilos, costs added, landed cost, profit); opening it shows the
 * containers, every expense, the split by category and the full costing.
 *
 * Every figure is a posted expense, a posted invoice line or a batch's own
 * cost, summed once per order. Nothing is estimated or apportioned.
 */
export default async function ShipmentCostPage({
  searchParams,
}: {
  searchParams: Promise<{ open?: string; q?: string }>;
}) {
  const { open, q } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.SHIPMENTS_VIEW);
  const companyId = user.activeCompany.id;
  const local = user.activeCompany.localCurrency;

  const all = await getOrderCostSheets(companyId);
  const needle = q?.trim().toLowerCase() ?? '';
  const sheets = needle
    ? all.filter((s) =>
        [s.contractReference, s.vendorName, ...s.items, ...s.lines.map((l) => `${l.containerNumber ?? ''} ${l.lotNumber} ${l.batchNumber}`)]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : all;

  const totals = {
    landedUsd: sum(sheets.map((s) => s.landedUsd)),
    landedLocal: sum(sheets.map((s) => s.landedLocal)),
    expenseLocal: sum(sheets.map((s) => s.expenseLocal)),
    profitUsd: sum(sheets.map((s) => s.grossProfitUsd)),
    profitLocal: sum(sheets.map((s) => s.grossProfitLocal)),
    kg: sum(sheets.map((s) => s.orderedKg)),
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shipment Costing"
        description="One row per shipment. Open a row for its containers, every expense, the landed cost and what it earned."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Shipment Costing' }]}
        actions={
          <>
            <FavouriteStar href="/reports/shipment-cost" label="Shipment Costing" />
            <PrintButton />
          </>
        }
      />
      <PrintHeader title="Shipment Costing" companyName={user.activeCompany.name} country={user.activeCompany.country} />
      <OpenAllForPrint />

      {all.length === 0 ? (
        <EmptyState
          title="No shipments yet"
          description="A shipment is opened when a purchase order is approved. Its costs appear here as they are booked."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
            <p className="text-sm text-ink-muted" data-testid="shipment-count">
              Total shipments: <span className="font-semibold text-ink">{all.length}</span>
              {needle ? ` · ${sheets.length} matching` : ''}
            </p>
            <form method="get" className="flex items-center gap-2">
              <input
                type="search"
                name="q"
                defaultValue={q ?? ''}
                placeholder="Search reference, item, container, lot…"
                aria-label="Search shipments"
                className="h-9 w-72 rounded-lg border border-line bg-surface px-3 text-sm"
              />
            </form>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 print:hidden">
            {[
              { label: 'Coffee bought', value: formatQuantityKg(totals.kg) },
              { label: 'Costs added', value: formatMoney(totals.expenseLocal, local) },
              { label: 'Total landed cost', value: formatMoney(totals.landedLocal, local), sub: formatMoney(totals.landedUsd, 'USD') },
              { label: 'Gross profit', value: formatMoney(totals.profitLocal, local), sub: formatMoney(totals.profitUsd, 'USD') },
            ].map((card) => (
              <Card key={card.label}>
                <CardContent className="pt-5">
                  <p className="text-xs text-ink-muted">{card.label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{card.value}</p>
                  {card.sub ? <p className="mt-0.5 text-[11px] text-ink-subtle">{card.sub}</p> : null}
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="space-y-3" data-testid="shipment-costing-list">
            {sheets.map((sheet, index) => (
              <OrderSection
                key={sheet.contractId}
                sheet={sheet}
                ordinal={all.indexOf(sheet) + 1}
                local={local}
                defaultOpen={open === sheet.contractId || (Boolean(needle) && index === 0 && sheets.length === 1)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function OrderSection({
  sheet,
  ordinal,
  local,
  defaultOpen,
}: {
  sheet: OrderCostSheet;
  ordinal: number;
  local: string;
  defaultOpen: boolean;
}) {
  const statuses = [...new Set(sheet.statuses)];
  const profitTone = sheet.grossProfitLocal.greaterThanOrEqualTo(0) ? 'text-gold-700' : 'text-red-600';
  return (
    <details
      className="group rounded-xl border border-line bg-surface shadow-card open:border-forest-300"
      open={defaultOpen}
      data-testid="shipment-costing-row"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-ink-muted transition-transform group-open:rotate-90" aria-hidden />
        <span className="min-w-[7rem]">
          <span className="block text-sm font-semibold text-ink">Shipment {ordinal}</span>
          <span className="block font-mono text-xs text-ink-muted">{sheet.contractReference}</span>
        </span>
        <span className="text-xs text-ink-muted">
          {plural(sheet.items.length, 'item', 'items')} · {plural(sheet.containers, 'container', 'containers')}
          <span className="block text-ink-subtle">{sheet.vendorName}</span>
        </span>
        <span className="tnum text-sm">
          {formatQuantityKg(sheet.orderedKg)}
          <span className="block text-[11px] text-ink-subtle">{formatQuantityKg(sheet.remainingKg)} in stock</span>
        </span>
        <span className="tnum text-sm">
          <span className="block text-[11px] text-ink-subtle">Costs added</span>
          {formatMoney(sheet.expenseLocal, local)}
        </span>
        <span className="tnum text-sm">
          <span className="block text-[11px] text-ink-subtle">Total landed cost</span>
          {formatMoney(sheet.landedLocal, local)}
          <span className="block text-[11px] text-ink-subtle">{formatMoney(sheet.costPerKgLocal, local)} per KG</span>
        </span>
        <span className={cn('tnum text-sm font-semibold', profitTone)}>
          <span className="block text-[11px] font-normal text-ink-subtle">Profit</span>
          {formatMoney(sheet.grossProfitLocal, local)}
          <span className="block text-[11px] font-normal text-ink-subtle">{dec(sheet.marginPct).toFixed(1)}% margin</span>
        </span>
        <span className="flex flex-wrap gap-1">
          {statuses.map((s) => (
            <StatusBadge key={s} status={s} meta={SHIPMENT_STATUS_META} />
          ))}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs print:hidden">
          <Link href={`/shipments/${sheet.firstShipmentId}`} className="rounded-md border border-line px-2.5 py-1 font-medium text-forest-800 hover:bg-forest-50">
            View
          </Link>
          <ExportLinks href={exportHref('shipment-cost', { order: sheet.contractId })} print={false} />
        </span>
      </summary>

      <div className="space-y-5 border-t border-line px-4 py-4">
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Items / containers</h3>
          <TableWrap>
            <Table data-testid="costing-lines">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Item</TH>
                  <TH>Container</TH>
                  <TH>Lot</TH>
                  <TH>Batch</TH>
                  <TH numeric>KG</TH>
                  <TH numeric>Sold</TH>
                  <TH>Warehouse</TH>
                  <TH numeric>Purchase USD</TH>
                  <TH numeric>Landed USD</TH>
                  <TH numeric>Per KG</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {sheet.lines.map((line) => (
                  <TR key={line.batchId}>
                    <TD className="font-medium">{line.itemName}</TD>
                    <TD className="font-mono text-xs">{line.containerNumber ?? '—'}</TD>
                    <TD className="text-xs">{line.lotNumber}</TD>
                    <TD className="text-xs">{line.batchNumber}</TD>
                    <TD numeric>
                      {formatQuantityKg(line.receivedKg.greaterThan(0) ? line.receivedKg : line.orderedKg)}
                    </TD>
                    <TD numeric className="text-xs">{formatQuantityKg(line.soldKg)}</TD>
                    <TD className="text-xs">{line.warehouse ?? '—'}</TD>
                    <TD numeric>{formatMoney(line.purchaseUsd, 'USD')}</TD>
                    <TD numeric>{formatMoney(line.landedUsd, 'USD')}</TD>
                    <TD numeric className="text-xs">{formatMoney(line.landedPerKgUsd, 'USD')}</TD>
                    <TD>
                      <StatusBadge status={line.status} meta={SHIPMENT_STATUS_META} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Direct expenses</h3>
          {sheet.expenses.length === 0 ? (
            <p className="text-xs text-ink-subtle">No costs have been booked against this shipment yet.</p>
          ) : (
            <TableWrap>
              <Table data-testid="costing-expenses">
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Cost</TH>
                    <TH>Memo</TH>
                    <TH>Container</TH>
                    <TH numeric>Amount</TH>
                    <TH numeric>USD</TH>
                    <TH numeric>{local}</TH>
                    <TH>In the coffee?</TH>
                    <TH>Paid</TH>
                  </TR>
                </THead>
                <TBody>
                  {sheet.expenses.map((e) => (
                    <TR key={e.expenseId}>
                      <TD className="whitespace-nowrap">{formatDate(e.expenseDate)}</TD>
                      <TD>
                        <Link href={`/finance/expenses/${e.expenseId}`} className="font-medium text-forest-800 hover:text-gold-700">
                          {e.category}
                        </Link>
                        <span className="block text-xs text-ink-subtle">{businessNumber(e.expenseNumber)}</span>
                      </TD>
                      <TD>
                        <MemoCell memo={e.memo} />
                      </TD>
                      <TD className="font-mono text-xs">{e.containerNumber ?? '—'}</TD>
                      <TD numeric>{formatMoney(e.amount, e.currency)}</TD>
                      <TD numeric>{formatMoney(e.amountUsd, 'USD')}</TD>
                      <TD numeric>{formatMoney(e.amountLocal, local)}</TD>
                      <TD>
                        <Badge tone={e.capitalised ? 'success' : 'neutral'}>{e.capitalised ? 'Yes' : 'No — a running cost'}</Badge>
                      </TD>
                      <TD className="text-xs text-ink-muted">
                        {e.payment === 'PAID' ? (e.paidFrom ?? 'Paid') : e.payment === 'PARTIAL' ? `Partly paid${e.paidFrom ? ` · ${e.paidFrom}` : ''}` : 'Unpaid'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
                {sheet.byCategory.length > 0 ? (
                  <TBody>
                    <TR className="bg-surface-sunken/40 hover:bg-surface-sunken/40">
                      <TD colSpan={9} className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                        By category
                      </TD>
                    </TR>
                    {sheet.byCategory.map((row) => (
                      <TR key={`${row.category}-${row.capitalised}`}>
                        <TD />
                        <TD className="font-medium">{row.category}</TD>
                        <TD className="text-xs text-ink-muted">
                          {row.count} {row.count === 1 ? 'entry' : 'entries'}
                        </TD>
                        <TD colSpan={2} />
                        <TD numeric>{formatMoney(row.amountUsd, 'USD')}</TD>
                        <TD numeric>{formatMoney(row.amountLocal, local)}</TD>
                        <TD>
                          <Badge tone={row.capitalised ? 'success' : 'neutral'}>{row.capitalised ? 'Yes' : 'No — a running cost'}</Badge>
                        </TD>
                        <TD />
                      </TR>
                    ))}
                  </TBody>
                ) : null}
                <TFoot>
                  <tr>
                    <TD colSpan={5}>Total expenses</TD>
                    <TD numeric>{formatMoney(sheet.expenseUsd, 'USD')}</TD>
                    <TD numeric>{formatMoney(sheet.expenseLocal, local)}</TD>
                    <TD colSpan={2} />
                  </tr>
                </TFoot>
              </Table>
            </TableWrap>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Costing</h3>
          <TableWrap className="max-w-3xl">
            <Table data-testid="costing-summary">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH />
                  <TH numeric>{local}</TH>
                  <TH numeric>USD</TH>
                </TR>
              </THead>
              <TBody>
                {[
                  ['Coffee, at the contract price', sheet.goodsLocal, sheet.goodsUsd],
                  ['Costs added to the coffee', sheet.capitalisedExpenseLocal, sheet.capitalisedExpenseUsd],
                  ['Total landed cost', sheet.landedLocal, sheet.landedUsd, 'bold'],
                  ['Cost per KG', sheet.costPerKgLocal, sheet.costPerKgUsd],
                  ['Cost per MT', sheet.costPerMtLocal, sheet.costPerMtUsd],
                  ['Sales', sheet.revenueLocal, sheet.revenueUsd],
                  ['Cost of what sold (COGS)', sheet.cogsLocal, sheet.cogsUsd],
                  ['Profit / loss', sheet.grossProfitLocal, sheet.grossProfitUsd, 'profit'],
                  // Only when there are such costs, so an ordinary shipment's
                  // costing stays six lines long.
                  ...(dec(sheet.periodExpenseUsd).isZero()
                    ? []
                    : [
                        ['Costs not added to the coffee', sheet.periodExpenseLocal, sheet.periodExpenseUsd],
                        ['Profit after those costs', sheet.netProfitLocal, sheet.netProfitUsd, 'profit'],
                      ]),
                ].map(([label, localValue, usd, style]) => (
                  <TR key={String(label)}>
                    <TD className={cn(style ? 'font-semibold' : undefined, style === 'profit' ? profitTone : undefined)}>
                      {String(label)}
                    </TD>
                    <TD numeric className={cn(style ? 'font-semibold' : undefined, style === 'profit' ? profitTone : undefined)}>
                      {formatMoney(localValue as never, local)}
                    </TD>
                    <TD numeric className={cn('text-ink-muted', style ? 'font-semibold' : undefined)}>
                      {formatMoney(usd as never, 'USD')}
                    </TD>
                  </TR>
                ))}
                <TR>
                  <TD>Margin</TD>
                  <TD numeric colSpan={2}>{dec(sheet.marginPct).toFixed(1)}%</TD>
                </TR>
                <TR>
                  <TD>Remaining stock</TD>
                  <TD numeric colSpan={2}>
                    {formatQuantityKg(sheet.remainingKg)} · carried at {formatMoney(sheet.remainingValueLocal, local)} ·{' '}
                    {formatMoney(sheet.remainingValueUsd, 'USD')}
                  </TD>
                </TR>
              </TBody>
            </Table>
          </TableWrap>
          <FxSummary sheet={sheet} />
          <p className="mt-2 text-[11px] text-ink-subtle">
            {formatQuantityKg(sheet.receivedKg)} landed of {formatQuantityKg(sheet.orderedKg)} bought. Every {local} figure is
            the sum of each transaction at its own rate. Profit counts only what has been sold; stock still on hand is not
            counted either way until it sells. The landed cost is what the coffee is valued at — the contract price plus the
            costs added to it — so it is the same figure the stock and the cost of sales are drawn from. A cost marked as not
            added to the coffee is taken off the profit here instead, once, and never twice.
          </p>
        </section>
      </div>
    </details>
  );
}

/**
 * FX SUMMARY — one weighted rate per currency pair, from the transactions
 * that make up the figures above, and the transactions themselves on demand.
 * Nothing here is used to convert anything: each transaction was converted
 * at its own rate when it was entered.
 */
function FxSummary({ sheet }: { sheet: OrderCostSheet }) {
  const local = sheet.localCurrency;
  const describe = (pair: OrderCostSheet['costFx'][number], what: string) => (
    <li key={`${what}-${pair.from}`} className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-medium text-ink">
        {pair.from} → {pair.to}
      </span>
      <span className="text-ink-muted">{what}: weighted average</span>
      <span className="tnum font-semibold text-ink">
        1 {pair.from} = {dec(pair.rate).toFixed(4)} {pair.to}
      </span>
      <span className="text-xs text-ink-subtle">
        from {pair.count} {pair.count === 1 ? 'transaction' : 'transactions'}
        {dec(pair.lowest).equals(dec(pair.highest))
          ? ''
          : ` · rates ${dec(pair.lowest).toFixed(4)} to ${dec(pair.highest).toFixed(4)}`}
      </span>
    </li>
  );
  const rows = [...sheet.fxCosts, ...sheet.fxSales];
  if (rows.length === 0) return null;
  const kind = { PURCHASE: 'Purchase', COST: 'Shipment cost', SALE: 'Sale' } as const;

  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-sunken/40 px-3 py-2" data-testid="fx-summary">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">FX summary</p>
      <ul className="mt-1 space-y-0.5 text-sm">
        {sheet.costFx.map((pair) => describe(pair, 'landed cost'))}
        {sheet.salesFx.map((pair) => describe(pair, 'sales'))}
      </ul>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs font-medium text-forest-800 hover:text-gold-700">View FX breakdown</summary>
        <TableWrap className="mt-2">
          <Table data-testid="fx-breakdown">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Date</TH>
                <TH>Type</TH>
                <TH>What</TH>
                <TH numeric>Original amount</TH>
                <TH numeric>FX rate ({local} per USD)</TH>
                <TH numeric>{local} equivalent</TH>
                <TH numeric>USD equivalent</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((t) => (
                <TR key={`${t.kind}-${t.id}`}>
                  <TD className="whitespace-nowrap text-xs">{formatDate(t.date)}</TD>
                  <TD className="text-xs">{kind[t.kind]}</TD>
                  <TD className="text-xs">
                    {t.label}
                    {t.reference ? <span className="block text-ink-subtle">{t.reference}</span> : null}
                  </TD>
                  <TD numeric>{formatMoney(t.amount, t.currency)}</TD>
                  <TD numeric className="text-xs">{dec(t.rateLocalPerUsd).toFixed(4)}</TD>
                  <TD numeric>{formatMoney(t.local, local)}</TD>
                  <TD numeric className="text-ink-muted">{formatMoney(t.usd, 'USD')}</TD>
                </TR>
              ))}
            </TBody>
            <TFoot>
              <tr>
                <TD colSpan={5}>Landed cost — the purchase and the costs added to it</TD>
                <TD numeric>{formatMoney(sum(sheet.fxCosts.map((t) => t.local)), local)}</TD>
                <TD numeric>{formatMoney(sum(sheet.fxCosts.map((t) => t.usd)), 'USD')}</TD>
              </tr>
            </TFoot>
          </Table>
        </TableWrap>
      </details>
    </div>
  );
}
