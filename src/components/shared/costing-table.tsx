import Link from 'next/link';
import type { BatchCosting } from '@/lib/services/landed-cost';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import { dec, sum } from '@/lib/money';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';

/**
 * What this coffee cost, wherever the coffee appears.
 *
 * The client asked repeatedly not to have costing hidden inside one page.
 * Every screen that lists batches can drop this in and show the same figures
 * the shipment cost report shows, because all of them come from the same
 * calculation — there is no second definition here that could drift.
 *
 * The table is wide on purpose. It scrolls sideways rather than dropping
 * columns, because the columns are the point.
 */
export function CostingTable({
  rows,
  caption,
  showWarehouse = true,
}: {
  rows: BatchCosting[];
  caption?: string;
  showWarehouse?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-line bg-paper p-6 text-center text-sm text-ink-muted">
        No costing yet — it appears once the coffee is on a contract.
      </p>
    );
  }

  const local = rows[0].localCurrency;
  const totalKg = sum(rows.map((r) => dec(r.orderedKg)));
  const totalPurchase = sum(rows.map((r) => dec(r.purchaseUsd)));
  const totalExpenseLocal = sum(rows.map((r) => dec(r.allocatedExpenseLocal)));
  const totalLandedUsd = sum(rows.map((r) => dec(r.landedUsd)));
  const totalLandedLocal = sum(rows.map((r) => dec(r.landedLocal)));
  const share = rows.length > 0 ? 100 / rows.length : 0;

  return (
    <TableWrap>
      <Table>
        {caption ? (
          <caption className="px-4 py-2 text-left text-xs text-ink-muted">{caption}</caption>
        ) : null}
        <THead>
          <TR className="hover:bg-transparent">
            <TH>Reference</TH>
            <TH>Item</TH>
            <TH>Container</TH>
            <TH>Batch</TH>
            {showWarehouse ? <TH>Warehouse</TH> : null}
            <TH numeric>KG</TH>
            <TH numeric>Purchase USD</TH>
            <TH numeric>Shared expense {local}</TH>
            <TH numeric>Expense USD</TH>
            <TH numeric>Landed {local}</TH>
            <TH numeric>Landed USD</TH>
            <TH numeric>Cost/KG {local}</TH>
            <TH numeric>Cost/KG USD</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR key={row.batchId}>
              <TD className="font-mono text-xs">{row.reference}</TD>
              <TD>{row.itemName}</TD>
              <TD className="font-mono text-xs">{row.containerNumber ?? '—'}</TD>
              <TD>
                <Link
                  href={`/inventory/batches/${row.batchId}`}
                  className="font-medium text-forest-800 hover:text-gold-700"
                >
                  {row.batchNumber}
                </Link>
              </TD>
              {showWarehouse ? (
                <TD className="text-xs text-ink-muted">{row.warehouseName ?? 'Not yet landed'}</TD>
              ) : null}
              <TD numeric>{formatQuantityKg(row.orderedKg)}</TD>
              <TD numeric>{formatMoney(row.purchaseUsd, 'USD')}</TD>
              <TD numeric>
                {formatMoney(row.allocatedExpenseLocal, local)}
                {rows.length > 1 ? (
                  <span className="block text-[11px] text-ink-subtle">{share.toFixed(0)}% of the job</span>
                ) : null}
              </TD>
              <TD numeric>{formatMoney(row.allocatedExpenseUsd, 'USD')}</TD>
              <TD numeric>{formatMoney(row.landedLocal, local)}</TD>
              <TD numeric>{formatMoney(row.landedUsd, 'USD')}</TD>
              <TD numeric className="font-semibold text-forest-800">
                {formatMoney(row.landedPerKgLocal, local)}
              </TD>
              <TD numeric className="font-semibold text-forest-800">
                {formatMoney(row.landedPerKgUsd, 'USD')}
              </TD>
            </TR>
          ))}
        </TBody>
        <TFoot>
          <tr>
            <TD colSpan={showWarehouse ? 5 : 4}>Whole job</TD>
            <TD numeric>{formatQuantityKg(totalKg)}</TD>
            <TD numeric>{formatMoney(totalPurchase, 'USD')}</TD>
            <TD numeric>{formatMoney(totalExpenseLocal, local)}</TD>
            <TD />
            <TD numeric>{formatMoney(totalLandedLocal, local)}</TD>
            <TD numeric>{formatMoney(totalLandedUsd, 'USD')}</TD>
            <TD numeric>
              {totalKg.greaterThan(0) ? formatMoney(totalLandedLocal.dividedBy(totalKg), local) : '—'}
            </TD>
            <TD numeric>
              {totalKg.greaterThan(0) ? formatMoney(totalLandedUsd.dividedBy(totalKg), 'USD') : '—'}
            </TD>
          </tr>
        </TFoot>
      </Table>
    </TableWrap>
  );
}

/** The same figures for one batch, for a page that shows a single lot. */
export function CostingSummary({ row }: { row: BatchCosting }) {
  const local = row.localCurrency;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {[
        { label: 'Purchase cost / KG', value: formatMoney(row.purchasePerKgUsd, 'USD'), sub: 'What the supplier charged' },
        {
          label: `Shared shipment cost`,
          value: formatMoney(row.allocatedExpenseLocal, local),
          sub: `${formatMoney(row.allocatedExpenseUsd, 'USD')} of the job's charges`,
        },
        {
          label: `Landed cost / KG`,
          value: formatMoney(row.landedPerKgLocal, local),
          sub: `${formatMoney(row.landedPerKgUsd, 'USD')} per KG`,
        },
        {
          label: 'Stock value',
          value: formatMoney(row.stockValueLocal, local),
          sub: `${formatQuantityKg(row.availableKg)} at this batch's own cost`,
        },
      ].map((card) => (
        <div key={card.label} className="rounded-xl border border-line bg-surface p-4">
          <p className="text-xs text-ink-muted">{card.label}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{card.value}</p>
          <p className="mt-0.5 text-[11px] text-ink-subtle">{card.sub}</p>
        </div>
      ))}
    </div>
  );
}
