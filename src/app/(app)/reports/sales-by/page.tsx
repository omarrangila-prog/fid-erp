import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { formatDate, formatMoney, formatPercent, formatQuantityKg } from '@/lib/format';
import { Decimal } from '@/lib/money';
import { getSalesBy, type SalesDimension } from '@/lib/services/reports';
import { PageHeader } from '@/components/shared/page-header';
import { CustomizePanel } from '@/components/reports/customize-panel';
import { DateRangePicker } from '@/components/shared/date-range';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { StatementHeader, FavouriteStar } from '@/components/reports/report-statement';
import { SalesByRows } from '@/app/(app)/reports/sales-by/rows';

export const metadata: Metadata = { title: 'Sales by' };
export const dynamic = 'force-dynamic';

const DIMENSIONS: Array<{ key: SalesDimension; label: string }> = [
  { key: 'customer', label: 'Customer' },
  { key: 'item', label: 'Item' },
  { key: 'shipment', label: 'Shipment' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'batch', label: 'Batch' },
];

/**
 * Sales by customer, by item, by shipment, by warehouse or by batch —
 * summary and detail in one report. Every row is the sum of posted invoice
 * lines and opens into them, so the summary is checkable line by line and
 * the totals agree with the profit and loss.
 */
export default async function SalesByPage({
  searchParams,
}: {
  searchParams: Promise<{ by?: string; from?: string; to?: string }>;
}) {
  const query = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.SALES_VIEW);
  const showCost = can(user, PERMISSIONS.PROFITS_VIEW);
  const by = (DIMENSIONS.some((d) => d.key === query.by) ? query.by : 'customer') as SalesDimension;
  const today = new Date();
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const to = query.to ? new Date(`${query.to}T00:00:00.000Z`) : today;

  const rows = await getSalesBy({ companyId: user.activeCompany.id, from, to, by });
  const sum = (pick: (r: (typeof rows)[number]) => Decimal) => rows.reduce((a, r) => a.plus(pick(r)), new Decimal(0));
  const revenue = sum((r) => r.revenueUsd);
  const cost = sum((r) => r.costUsd);
  const gross = revenue.minus(cost);
  const label = DIMENSIONS.find((d) => d.key === by)!.label;
  const title = `Sales by ${label}`;
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        description="What sold, to whom, from where, and what it cost — summary rows that open into the invoice lines behind them."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: title }]}
        actions={
          <>
            <FavouriteStar href={`/reports/sales-by?by=${by}`} label={title} />
            <CustomizePanel report={title} fields={['period']} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader title={title} companyName={user.activeCompany.name} country={user.activeCompany.country} />

      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <DateRangePicker defaultFrom={fromStr} defaultTo={toStr} />
        <div className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
          Group by
          <div className="flex flex-wrap gap-1">
            {DIMENSIONS.map((d) => (
              <Link
                key={d.key}
                href={`/reports/sales-by?by=${d.key}&from=${fromStr}&to=${toStr}`}
                className={`rounded-md px-3 py-2 text-sm ${d.key === by ? 'bg-forest-700 text-white' : 'border border-line text-ink hover:bg-surface-sunken'}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No sales in this period" description="Nothing was invoiced between these dates." />
      ) : (
        <Card>
          <CardContent className="px-2 pb-4 pt-2 sm:px-4">
            <StatementHeader company={user.activeCompany.name} title={title} period={`${formatDate(from)} – ${formatDate(to)}`} />
            <SalesByRows
              showCost={showCost}
              totals={{
                quantity: formatQuantityKg(sum((r) => r.quantityKg)),
                revenue: formatMoney(revenue, 'USD'),
                cost: formatMoney(cost, 'USD'),
                gross: formatMoney(gross, 'USD'),
                margin: revenue.isZero() ? '—' : formatPercent(gross.dividedBy(revenue).times(100)),
              }}
              rows={rows.map((r) => ({
                key: r.key,
                label: r.label,
                href: r.href,
                invoices: r.invoices,
                quantity: formatQuantityKg(r.quantityKg),
                revenue: formatMoney(r.revenueUsd, 'USD'),
                cost: formatMoney(r.costUsd, 'USD'),
                gross: formatMoney(r.grossProfitUsd, 'USD'),
                margin: r.revenueUsd.isZero() ? '—' : formatPercent(r.marginPct),
                negative: r.grossProfitUsd.isNegative(),
                detail: r.detail.map((d, i) => ({
                  key: `${d.invoiceId}-${i}`,
                  invoice: d.invoiceLabel,
                  href: `/sales/${d.invoiceId}`,
                  date: formatDate(d.invoiceDate),
                  customer: d.customerName,
                  item: d.itemName,
                  warehouse: d.warehouseName ?? '—',
                  batch: d.batchNumber ?? '—',
                  shipment: d.shipmentReference ?? '—',
                  quantity: formatQuantityKg(d.quantityKg),
                  price: formatMoney(d.unitPriceUsd, 'USD'),
                  revenue: formatMoney(d.revenueUsd, 'USD'),
                  cost: formatMoney(d.costUsd, 'USD'),
                })),
              }))}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
