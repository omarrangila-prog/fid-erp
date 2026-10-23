import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, SHIPMENT_STATUS_META } from '@/lib/constants';
import { getOrderCostSheets, type OrderCostSheet } from '@/lib/services/order-cost';
import { formatMoney, formatDate, formatQuantityKg } from '@/lib/format';
import { dec, sum, toMoney, type Decimal } from '@/lib/money';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/shared/page-header';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';
import { ReportShareButton } from '@/components/share/report-share-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { FavouriteStar } from '@/components/reports/report-statement';
import { PrintHeader } from '@/components/shared/print-header';
import { MemoCell } from '@/components/shared/memo-cell';
import { businessNumber } from '@/lib/short-number';
import { OpenAllForPrint } from '@/app/(app)/reports/shipment-cost/open-for-print';

export const metadata: Metadata = { title: 'Shipment-wise Profitability' };
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
  // What the coffee cost is purchase cost — the Excel version of this page
  // already asked for it, while the page let anyone who sees shipments in.
  // Profit and margin need "View profit" on top, as everywhere else.
  const user = await requirePageAccess(PERMISSIONS.PURCHASE_COST_VIEW);
  const showProfit = can(user, PERMISSIONS.PROFITS_VIEW);
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

  return (
    <div className="print-landscape space-y-6">
      <PageHeader
        title="Shipment-wise Profitability"
        description="Per shipment: sales value and quantity sold, cost of the coffee sold, direct shipment costs, other expenses allocated to the shipment, gross profit, net profit and any unpaid customer or supplier balance — with a consolidated total for all shipments. Click a shipment for its detail."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Shipment-wise Profitability' }]}
        actions={
          <>
            <FavouriteStar href="/reports/shipment-cost" label="Shipment-wise Profitability" />
            <ExportLinks href={exportHref('shipment-cost', {})} />
            <ReportShareButton report="shipment-costing" />
          </>
        }
      />
      <PrintHeader title="Shipment-wise Profitability" companyName={user.activeCompany.name} currency={user.activeCompany.localCurrency} country={user.activeCompany.country} />
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

          <Overview sheets={sheets} local={local} showProfit={showProfit} />

          <div className="space-y-3" data-testid="shipment-costing-list">
            {sheets.map((sheet, index) => (
              <OrderSection
                key={sheet.contractId}
                showProfit={showProfit}
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

/**
 * Every shipment on one line: the figures a trader reads first. Opening a
 * shipment shows every measure the requirements list, per-KG ones included
 * (and the Excel export carries them all on this line). Each order is counted once;
 * the totals are of the lines above them.
 */
/**
 * Gross profit as the owner reads it: sales less the coffee itself. The
 * shipment expenses on the coffee sold come after it, with the operating
 * expenses, as on the profit and loss; net profit is the same either way.
 */
const grossOf = (s: OrderCostSheet) => ({ local: s.revenueLocal.minus(s.coffeeSoldLocal), usd: s.revenueUsd.minus(s.coffeeSoldUsd) });
const marginOf = (s: OrderCostSheet) => (s.revenueLocal.isZero() ? null : grossOf(s).local.dividedBy(s.revenueLocal).times(100));

function Overview({ sheets, local, showProfit }: { sheets: OrderCostSheet[]; local: string; showProfit: boolean }) {
  const total = (pick: (s: OrderCostSheet) => Decimal) => sum(sheets.map(pick));
  const revenue = total((s) => s.revenueLocal);
  const gross = total((s) => grossOf(s).local);
  const money = (v: Decimal) => formatMoney(v, local);
  return (
    <TableWrap data-wide-sheet>
      <Table data-testid="shipment-overview" className="text-xs [&_td]:px-2.5 [&_th]:px-2.5">
        <THead>
          <TR className="hover:bg-transparent">
            <TH>Shipment</TH>
            <TH numeric>Purchased KG</TH>
            <TH numeric>Purchase value</TH>
            <TH numeric>Direct shipment costs</TH>
            <TH numeric>Landed cost</TH>
            <TH numeric>Quantity sold</TH>
            <TH numeric>Sales value</TH>
            <TH numeric>Remaining KG</TH>
            <TH numeric>Closing stock value</TH>
            {showProfit ? (
              <>
                <TH numeric>Cost of the coffee sold</TH>
                <TH numeric>Gross profit</TH>
                <TH numeric>Gross margin</TH>
                <TH numeric>Direct shipment costs on the coffee sold</TH>
                <TH numeric>Other expenses allocated to the shipment</TH>
                <TH numeric>Net profit</TH>
              </>
            ) : null}
            <TH numeric>Unpaid customer balance</TH>
            <TH numeric>Unpaid supplier balance</TH>
          </TR>
        </THead>
        <TBody>
          {sheets.map((s) => (
            <TR key={s.contractId}>
              <TD>
                <a href={`?open=${s.contractId}#order-${s.contractId}`} className="font-medium text-forest-800 hover:text-gold-700">
                  {s.contractReference}
                </a>
                <span className="block text-[11px] text-ink-subtle">{s.vendorName}</span>
              </TD>
              <TD numeric>{formatQuantityKg(s.orderedKg)}</TD>
              <TD numeric>{money(s.goodsLocal)}</TD>
              <TD numeric>{money(s.capitalisedExpenseLocal)}</TD>
              <TD numeric className="font-semibold">{money(s.landedLocal)}</TD>
              <TD numeric>{formatQuantityKg(s.invoicedKg)}</TD>
              <TD numeric>{money(s.revenueLocal)}</TD>
              <TD numeric>{formatQuantityKg(s.remainingKg)}</TD>
              <TD numeric>{money(s.remainingValueLocal)}</TD>
              {showProfit ? (
                <>
                  <TD numeric>{money(s.coffeeSoldLocal)}</TD>
                  <TD numeric className={cn('font-semibold', grossOf(s).local.isNegative() ? 'text-red-600' : 'text-gold-700')}>{money(grossOf(s).local)}</TD>
                  <TD numeric>{marginOf(s) === null ? '—' : `${marginOf(s)!.toFixed(1)}%`}</TD>
                  <TD numeric>{money(s.soldExpenseLocal)}</TD>
                  <TD numeric>{money(s.periodExpenseLocal)}</TD>
                  <TD numeric className={cn('font-semibold', s.netProfitLocal.isNegative() ? 'text-red-600' : 'text-gold-700')}>{money(s.netProfitLocal)}</TD>
                </>
              ) : null}
              <TD numeric>{money(s.customerOutstandingLocal)}</TD>
              <TD numeric>{money(s.supplierOutstandingLocal)}</TD>
            </TR>
          ))}
        </TBody>
        <TFoot>
          <tr>
            <TD>Consolidated total — all {plural(sheets.length, 'shipment', 'shipments')}</TD>
            <TD numeric>{formatQuantityKg(total((s) => s.orderedKg))}</TD>
            <TD numeric>{money(total((s) => s.goodsLocal))}</TD>
            <TD numeric>{money(total((s) => s.capitalisedExpenseLocal))}</TD>
            <TD numeric>{money(total((s) => s.landedLocal))}</TD>
            <TD numeric>{formatQuantityKg(total((s) => s.invoicedKg))}</TD>
            <TD numeric>{money(revenue)}</TD>
            <TD numeric>{formatQuantityKg(total((s) => s.remainingKg))}</TD>
            <TD numeric>{money(total((s) => s.remainingValueLocal))}</TD>
            {showProfit ? (
              <>
                <TD numeric>{money(total((s) => s.coffeeSoldLocal))}</TD>
                <TD numeric>{money(gross)}</TD>
                <TD numeric>{revenue.isZero() ? '—' : `${gross.dividedBy(revenue).times(100).toFixed(1)}%`}</TD>
                <TD numeric>{money(total((s) => s.soldExpenseLocal))}</TD>
                <TD numeric>{money(total((s) => s.periodExpenseLocal))}</TD>
                <TD numeric>{money(total((s) => s.netProfitLocal))}</TD>
              </>
            ) : null}
            <TD numeric>{money(total((s) => s.customerOutstandingLocal))}</TD>
            <TD numeric>{money(total((s) => s.supplierOutstandingLocal))}</TD>
          </tr>
        </TFoot>
      </Table>
    </TableWrap>
  );
}

const STATUS_WORDS = { PAID: 'Settled', PARTIAL: 'Partly settled', UNPAID: 'Outstanding' } as const;

function OrderSection({
  sheet,
  ordinal,
  local,
  defaultOpen,
  showProfit,
}: {
  sheet: OrderCostSheet;
  ordinal: number;
  local: string;
  defaultOpen: boolean;
  showProfit: boolean;
}) {
  const statuses = [...new Set(sheet.statuses)];
  const profitTone = grossOf(sheet).local.greaterThanOrEqualTo(0) ? 'text-gold-700' : 'text-red-600';
  const money = (v: Decimal) => formatMoney(v, local);
  // Every expense under its category, the category's subtotal after it.
  const categories = [...new Set(sheet.expenses.map((e) => e.category))].sort((a, b) => a.localeCompare(b));
  const cogsAndStock = sheet.cogsLocal.plus(sheet.remainingValueLocal);
  // Bought but not yet received: costed, not yet in a warehouse to be sold.
  const transitKg = sheet.orderedKg.minus(sheet.receivedKg);
  const transitLocal = transitKg.greaterThan(0) ? toMoney(transitKg.times(sheet.costPerKgLocal)) : dec(0);
  const unexplained = sheet.landedLocal.minus(cogsAndStock).minus(transitLocal);
  const h3 = 'mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted';
  return (
    <details
      id={`order-${sheet.contractId}`}
      className="group scroll-mt-24 rounded-xl border border-line bg-surface shadow-card open:border-forest-300"
      open={defaultOpen}
      data-testid="shipment-costing-row"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-ink-muted transition-transform group-open:rotate-90" aria-hidden />
        <span className="min-w-[7rem]">
          <span className="block text-sm font-semibold text-ink">{sheet.contractReference}</span>
          <span className="block text-xs text-ink-muted">Shipment {ordinal} · {sheet.vendorName}</span>
        </span>
        <span className="text-xs text-ink-muted">
          {plural(sheet.items.length, 'item', 'items')} · {plural(sheet.containers, 'container', 'containers')}
        </span>
        <span className="tnum text-sm">
          {formatQuantityKg(sheet.orderedKg)}
          <span className="block text-[11px] text-ink-subtle">{formatQuantityKg(sheet.remainingKg)} remaining</span>
        </span>
        <span className="tnum text-sm">
          <span className="block text-[11px] text-ink-subtle">Direct shipment costs</span>
          {money(sheet.capitalisedExpenseLocal)}
        </span>
        <span className="tnum text-sm">
          <span className="block text-[11px] text-ink-subtle">Total landed cost</span>
          {money(sheet.landedLocal)}
          <span className="block text-[11px] text-ink-subtle">{money(sheet.costPerKgLocal)} per KG</span>
        </span>
        {showProfit ? (
          <span className={cn('tnum text-sm font-semibold', profitTone)}>
            <span className="block text-[11px] font-normal text-ink-subtle">Gross profit</span>
            {money(grossOf(sheet).local)}
            <span className="block text-[11px] font-normal text-ink-subtle">{(marginOf(sheet) ?? dec(0)).toFixed(1)}% of sales</span>
          </span>
        ) : null}
        <span className="flex flex-wrap gap-1">
          {statuses.map((s) => (
            <StatusBadge key={s} status={s} meta={SHIPMENT_STATUS_META} />
          ))}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs print:hidden">
          <Link href={`/shipments/${sheet.firstShipmentId}`} className="rounded-md border border-line px-2.5 py-1 font-medium text-forest-800 hover:bg-forest-50">
            View
          </Link>
          <ExportLinks href={exportHref('shipment-cost', { order: sheet.contractId })} />
        </span>
      </summary>

      <div className="space-y-6 border-t border-line px-4 py-4">
        <section>
          <h3 className={h3}>A. Purchase and stock, by container</h3>
          <TableWrap>
            <Table data-testid="costing-lines">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Item</TH>
                  <TH>Container / lot</TH>
                  <TH>Warehouse</TH>
                  <TH numeric>Purchased KG</TH>
                  <TH numeric>Quantity sold</TH>
                  <TH numeric>Remaining KG</TH>
                  <TH numeric>Purchase value (USD)</TH>
                  <TH numeric>Landed cost</TH>
                  <TH numeric>Landed cost / KG</TH>
                  <TH numeric>Stock value</TH>
                </TR>
              </THead>
              <TBody>
                {sheet.lines.map((line) => (
                  <TR key={line.batchId}>
                    <TD className="font-medium">{line.itemName}</TD>
                    <TD className="text-xs">
                      <span className="font-mono">{line.containerNumber ?? '—'}</span>
                      <span className="block text-ink-subtle">Lot {line.lotNumber}</span>
                    </TD>
                    <TD className="text-xs">{line.warehouse ?? '—'}</TD>
                    <TD numeric>{formatQuantityKg(line.receivedKg.greaterThan(0) ? line.receivedKg : line.orderedKg)}</TD>
                    <TD numeric>{formatQuantityKg(line.soldKg)}</TD>
                    <TD numeric>{formatQuantityKg(line.onHandKg)}</TD>
                    <TD numeric>{formatMoney(line.purchaseUsd, 'USD')}</TD>
                    <TD numeric>{money(line.landedLocal)}</TD>
                    <TD numeric>{money(line.landedPerKgLocal)}</TD>
                    <TD numeric>{money(toMoney(line.onHandKg.times(line.landedPerKgLocal)))}</TD>
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <tr>
                  <TD colSpan={3}>Total</TD>
                  <TD numeric>{formatQuantityKg(sheet.receivedKg.greaterThan(0) ? sheet.receivedKg : sheet.orderedKg)}</TD>
                  <TD numeric>{formatQuantityKg(sum(sheet.lines.map((l) => l.soldKg)))}</TD>
                  <TD numeric>{formatQuantityKg(sheet.remainingKg)}</TD>
                  <TD numeric>{formatMoney(sheet.goodsUsd, 'USD')}</TD>
                  <TD numeric>{money(sheet.landedLocal)}</TD>
                  <TD numeric>{money(sheet.costPerKgLocal)}</TD>
                  <TD numeric>{money(sheet.remainingValueLocal)}</TD>
                </tr>
              </TFoot>
            </Table>
          </TableWrap>
        </section>

        <section>
          <h3 className={h3}>B. Direct shipment costs by category (freight, insurance, clearance, handling, port, documents) — cost, settled and outstanding</h3>
          {sheet.expenses.length === 0 ? (
            <p className="text-xs text-ink-subtle">No costs have been booked against this shipment yet.</p>
          ) : (
            <TableWrap>
              <Table data-testid="costing-expenses">
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Category</TH>
                    <TH>Memo</TH>
                    <TH>Container</TH>
                    <TH numeric>Original cost</TH>
                    <TH numeric>Settled</TH>
                    <TH numeric>Outstanding</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                {categories.map((category) => {
                  const rows = sheet.expenses.filter((e) => e.category === category);
                  return (
                    <TBody key={category}>
                      {rows.map((e) => (
                        <TR key={e.expenseId}>
                          <TD className="whitespace-nowrap">{formatDate(e.expenseDate)}</TD>
                          <TD>
                            <Link href={`/finance/expenses/${e.expenseId}`} className="font-medium text-forest-800 hover:text-gold-700">
                              {e.category}
                            </Link>
                            <span className="block text-xs text-ink-subtle">
                              {businessNumber(e.expenseNumber)}
                              {e.currency !== local ? ` · ${formatMoney(e.amount, e.currency)}` : ''}
                              {e.capitalised ? '' : ' · not in the coffee’s cost'}
                            </span>
                          </TD>
                          <TD>
                            <MemoCell memo={e.memo} />
                          </TD>
                          <TD className="font-mono text-xs">{e.containerNumber ?? 'Whole shipment'}</TD>
                          <TD numeric>{money(e.originalLocal)}</TD>
                          <TD numeric>{e.settledLocal.isZero() ? '—' : money(e.settledLocal)}</TD>
                          <TD numeric className={e.outstandingLocal.greaterThan(0) ? 'font-semibold text-red-700' : undefined}>
                            {e.outstandingLocal.isZero() ? '—' : money(e.outstandingLocal)}
                          </TD>
                          <TD className="text-xs text-ink-muted">
                            {STATUS_WORDS[e.payment]}
                            {e.paidFrom ? <span className="block text-ink-subtle">{e.paidFrom}</span> : null}
                          </TD>
                        </TR>
                      ))}
                      <TR className="bg-surface-sunken/50 hover:bg-surface-sunken/50" data-grid-total="">
                        <TD colSpan={4} className="font-semibold">Total {category}</TD>
                        <TD numeric className="font-semibold">{money(sum(rows.map((e) => e.originalLocal)))}</TD>
                        <TD numeric className="font-semibold">{money(sum(rows.map((e) => e.settledLocal)))}</TD>
                        <TD numeric className="font-semibold">{money(sum(rows.map((e) => e.outstandingLocal)))}</TD>
                        <TD />
                      </TR>
                    </TBody>
                  );
                })}
                <TFoot>
                  <tr>
                    <TD colSpan={4}>All direct shipment costs</TD>
                    <TD numeric>{money(sum(sheet.expenses.map((e) => e.originalLocal)))}</TD>
                    <TD numeric>{money(sheet.expenseSettledLocal)}</TD>
                    <TD numeric>{money(sheet.expenseOutstandingLocal)}</TD>
                    <TD />
                  </tr>
                </TFoot>
              </Table>
            </TableWrap>
          )}
          <p className="mt-2 text-[11px] text-ink-subtle">
            Original cost is what the expense cost the shipment and stays in its cost when it is paid. Settled is what has
            been paid or set off against it; outstanding is what is still owed. A settlement never adds a second cost.
          </p>
        </section>

        <section>
          <h3 className={h3}>C. Sales of this shipment’s coffee</h3>
          {sheet.sales.length === 0 ? (
            <p className="text-xs text-ink-subtle">Nothing from this shipment has been sold yet.</p>
          ) : (
            <TableWrap>
              <Table data-testid="costing-sales">
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Invoice</TH>
                    <TH>Customer</TH>
                    <TH numeric>KG from this shipment</TH>
                    <TH numeric>Sales value</TH>
                    <TH numeric>Price / KG</TH>
                    <TH numeric>Unpaid customer balance</TH>
                  </TR>
                </THead>
                <TBody>
                  {sheet.sales.map((sale) => (
                    <TR key={sale.invoiceId}>
                      <TD className="whitespace-nowrap">{formatDate(sale.invoiceDate)}</TD>
                      <TD>
                        <Link href={`/sales/${sale.invoiceId}`} className="font-medium text-forest-800 hover:text-gold-700">
                          {businessNumber(sale.invoiceNumber)}
                        </Link>
                      </TD>
                      <TD>{sale.customerName}</TD>
                      <TD numeric>{formatQuantityKg(sale.quantityKg)}</TD>
                      <TD numeric>{money(sale.revenueLocal)}</TD>
                      <TD numeric>{sale.quantityKg.greaterThan(0) ? money(toMoney(sale.revenueLocal.dividedBy(sale.quantityKg))) : '—'}</TD>
                      <TD numeric className={sale.outstandingLocal.greaterThan(0) ? 'font-medium text-red-600' : 'text-ink-subtle'}>
                        {sale.outstandingLocal.greaterThan(0) ? money(sale.outstandingLocal) : 'Paid'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <tr>
                    <TD colSpan={3}>Total sales</TD>
                    <TD numeric>{formatQuantityKg(sheet.invoicedKg)}</TD>
                    <TD numeric>{money(sheet.revenueLocal)}</TD>
                    <TD numeric>{money(sheet.averageSellingPriceLocal)}</TD>
                    <TD numeric>{money(sheet.customerOutstandingLocal)}</TD>
                  </tr>
                </TFoot>
              </Table>
            </TableWrap>
          )}
        </section>

        <section>
          <h3 className={h3}>D. Shipment-wise Profitability</h3>
          <TableWrap className="max-w-3xl">
            <Table data-testid="costing-summary">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH />
                  <TH numeric>{local}</TH>
                  <TH numeric>≈ USD</TH>
                </TR>
              </THead>
              <TBody>
                {(
                  [
                    ['Purchased quantity', formatQuantityKg(sheet.orderedKg), ''],
                    ['Purchase value (at the order’s rate)', money(sheet.goodsLocal), formatMoney(sheet.goodsUsd, 'USD')],
                    ['Direct shipment costs', money(sheet.capitalisedExpenseLocal), formatMoney(sheet.capitalisedExpenseUsd, 'USD')],
                    ['Total landed cost', money(sheet.landedLocal), formatMoney(sheet.landedUsd, 'USD'), 'bold'],
                    ['Landed cost per KG', money(sheet.costPerKgLocal), formatMoney(sheet.costPerKgUsd, 'USD')],
                    ['Quantity sold', formatQuantityKg(sheet.invoicedKg), ''],
                    ['Sales value', money(sheet.revenueLocal), formatMoney(sheet.revenueUsd, 'USD')],
                    ['Average selling price per KG', money(sheet.averageSellingPriceLocal), formatMoney(sheet.averageSellingPriceUsd, 'USD')],
                    ...(showProfit
                      ? [
                          ['Cost of the coffee sold', money(sheet.coffeeSoldLocal), formatMoney(sheet.coffeeSoldUsd, 'USD')],
                          ['Gross profit', money(grossOf(sheet).local), formatMoney(grossOf(sheet).usd, 'USD'), 'profit'],
                          ['Gross profit %', `${(marginOf(sheet) ?? dec(0)).toFixed(1)}% of sales`, ''],
                          ['Direct shipment costs on the coffee sold', money(sheet.soldExpenseLocal), formatMoney(sheet.soldExpenseUsd, 'USD')],
                        ]
                      : []),
                    ['Quantity remaining', formatQuantityKg(sheet.remainingKg), ''],
                    ['Closing stock value (remaining KG at landed cost)', money(sheet.remainingValueLocal), formatMoney(sheet.remainingValueUsd, 'USD')],
                    ...(transitKg.greaterThan(0)
                      ? [[`In transit — ${formatQuantityKg(transitKg)} not yet received`, money(transitLocal), ''] as [string, string, string]]
                      : []),
                    ...(!showProfit
                      ? []
                      : [
                          ['Other expenses allocated to the shipment', money(sheet.periodExpenseLocal), formatMoney(sheet.periodExpenseUsd, 'USD')],
                          ['Net profit', money(sheet.netProfitLocal), formatMoney(sheet.netProfitUsd, 'USD'), 'profit'],
                        ]),
                    ['Unpaid customer balance', money(sheet.customerOutstandingLocal), ''],
                    [
                      'Unpaid supplier balance',
                      money(sheet.supplierOutstandingLocal),
                      sheet.supplierOutstanding.isZero() ? '' : formatMoney(sheet.supplierOutstanding, sheet.supplierCurrency),
                    ],
                    ['Unpaid shipment expenses', money(sheet.expenseOutstandingLocal), ''],
                  ] as Array<[string, string, string, string?]>
                ).map(([label, value, usd, style]) => (
                  <TR key={label}>
                    <TD className={cn(style ? 'font-semibold' : undefined, style === 'profit' ? profitTone : undefined)}>{label}</TD>
                    <TD numeric className={cn(style ? 'font-semibold' : undefined, style === 'profit' ? profitTone : undefined)}>{value}</TD>
                    <TD numeric className="text-ink-muted">{usd}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
          {showProfit ? (
            <p className="mt-2 max-w-3xl text-[11px] text-ink-subtle" data-testid="costing-reconciliation">
              How the landed cost is used: {money(sheet.cogsLocal)} went with the coffee sold (the coffee and its direct shipment costs, above) and{' '}
              {money(sheet.remainingValueLocal)} is the stock still on hand
              {transitLocal.greaterThan(0) ? `, and ${money(transitLocal)} is coffee bought but not yet received` : ''} ={' '}
              {money(cogsAndStock.plus(transitLocal))}
              {unexplained.abs().lessThan('1')
                ? `, the whole landed cost of ${money(sheet.landedLocal)}. Each direct expense is in the landed cost once, so it is never deducted a second time.`
                : `; ${money(unexplained)} of the landed cost of ${money(sheet.landedLocal)} is in neither (stock written off or adjusted).`}{' '}
              Sold coffee is costed at its container’s landed cost per KG — the policy the client approved; the stock left is
              valued the same way.
            </p>
          ) : null}
          <FxSummary sheet={sheet} />
        </section>
      </div>
    </details>
  );
}

/**
 * FX SUMMARY — the order's purchase rate, and every transaction behind the
 * figures above at the rate it was entered at, on demand. Nothing here
 * converts anything: each transaction was converted when it was entered.
 */
function FxSummary({ sheet }: { sheet: OrderCostSheet }) {
  const local = sheet.localCurrency;
  const rows = [...sheet.fxCosts, ...sheet.fxSales];
  if (rows.length === 0) return null;
  const kind = { PURCHASE: 'Purchase', COST: 'Shipment cost', SALE: 'Sale' } as const;

  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-sunken/40 px-3 py-2" data-testid="fx-summary">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">FX summary</p>
      {/*
        The one rate the coffee is costed at — the order's, actual once
        confirmed. A weighted average of every transaction used to lead here,
        blending the purchase with the rates each dirham expense happened to
        be entered at: 10.1394 on an order bought at 10.30, a rate nobody
        gave. Dirham costs need no rate; their dirham amounts are the cost.
      */}
      <p className="mt-1 text-sm" data-testid="fx-purchase-rate">
        <span className="font-medium text-ink">USD/MAD rate</span>{' '}
        <span className="tnum font-semibold text-ink">
          1 USD = {dec(sheet.rateLocalPerUsd).toString()} {local}
        </span>{' '}
        <span className="text-xs text-ink-subtle">
          from the purchase order. Shipment costs paid in {local} are taken at their {local} amounts.
        </span>
      </p>
      <details className="mt-1" data-print="hide">
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
