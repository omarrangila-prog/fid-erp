import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getInventoryValuation, getInventoryValuationSummary, getInventoryValuationDetail } from '@/lib/services/stock';
import { StatementHeader, FavouriteStar } from '@/components/reports/report-statement';
import { formatDate, titleCase } from '@/lib/format';
import { ValuationDetail } from '@/app/(app)/reports/inventory-valuation/detail';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { PrintButton } from '@/components/shared/print-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';
import { dec } from '@/lib/money';

export const metadata: Metadata = { title: 'Inventory Valuation' };
export const dynamic = 'force-dynamic';

/**
 * Three depths of the same figures. Summary: item, quantity, average landed
 * cost, asset value. By warehouse: each batch in each bin. Detail: every
 * movement that changed quantity or value, batch by batch, with the quantity
 * and value after each. All three come from the same stock ledger and add
 * up to the same total.
 */
export default async function InventoryValuationPage({ searchParams }: { searchParams: Promise<{ view?: string; from?: string; to?: string }> }) {
  const query = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);
  const view = query.view === 'summary' || query.view === 'detail' ? query.view : 'warehouse';
  const [rows, summary, detail] = await Promise.all([
    getInventoryValuation(user.activeCompany.id),
    view === 'summary' ? getInventoryValuationSummary(user.activeCompany.id) : Promise.resolve([]),
    view === 'detail'
      ? getInventoryValuationDetail({
          companyId: user.activeCompany.id,
          from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
          to: query.to ? new Date(`${query.to}T00:00:00.000Z`) : undefined,
        })
      : Promise.resolve([]),
  ]);
  const totalKg = rows.reduce((sum, row) => sum.plus(row.onHandKg), dec(0));
  const totalUsd = rows.reduce((sum, row) => sum.plus(row.valueUsd), dec(0));
  const tab = (key: string, label: string) => (
    <Link
      key={key}
      href={`/reports/inventory-valuation?view=${key}`}
      className={`rounded-md px-3 py-1.5 text-sm ${view === key ? 'bg-forest-700 text-white' : 'border border-line text-ink hover:bg-surface-sunken'}`}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory Valuation"
        description="On-hand stock at each batch's landed cost — as a summary by coffee, by warehouse, or movement by movement."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Inventory Valuation' }]}
        actions={
          <>
            <FavouriteStar href="/reports/inventory-valuation" label="Inventory Valuation" />
            {can(user, PERMISSIONS.REPORTS_EXPORT) ? <ExportLinks href={exportHref('inventory-valuation', {})} /> : null}
            <PrintButton />
          </>
        }
      />

      <div className="flex gap-2 print:hidden">
        {tab('summary', 'Summary')}
        {tab('warehouse', 'By warehouse')}
        {tab('detail', 'Detail')}
      </div>

      {view === 'summary' ? (
        <Card>
          <CardContent className="px-2 pb-4 pt-2 sm:px-4">
            <StatementHeader company={user.activeCompany.name} title="Inventory Valuation Summary" period={`As at ${formatDate(new Date())}`} />
            <table className="w-full max-w-3xl border-collapse text-sm">
              <thead>
                <tr className="border-b border-line-strong text-[11px] uppercase tracking-wider text-ink-muted">
                  <th className="px-3 py-2 text-left font-semibold">Item</th>
                  <th className="px-3 py-2 text-right font-semibold">Qty</th>
                  {showCost ? (
                    <>
                      <th className="px-3 py-2 text-right font-semibold">Avg landed cost</th>
                      <th className="px-3 py-2 text-right font-semibold">Asset value</th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {summary.map((row) => (
                  <tr key={row.itemId} className="border-t border-line hover:bg-surface-sunken/40">
                    <td className="px-3 py-2">
                      <Link href={`/items/${row.itemId}`} className="font-medium text-ink hover:text-gold-700 hover:underline">
                        {row.itemName}
                      </Link>
                      <span className="ml-2 text-xs text-ink-subtle">{row.batches} {row.batches === 1 ? 'batch' : 'batches'}</span>
                    </td>
                    <td className="tnum px-3 py-2 text-right">{formatQuantityKg(row.onHandKg)}</td>
                    {showCost ? (
                      <>
                        <td className="tnum px-3 py-2 text-right">{formatMoney(row.averageCostUsd, 'USD')}</td>
                        <td className="tnum px-3 py-2 text-right font-semibold">{formatMoney(row.assetValueUsd, 'USD')}</td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line-strong bg-surface-sunken/40 font-semibold">
                  <td className="px-3 py-2">Total</td>
                  <td className="tnum px-3 py-2 text-right">{formatQuantityKg(totalKg)}</td>
                  {showCost ? (
                    <>
                      <td />
                      <td className="tnum px-3 py-2 text-right">{formatMoney(totalUsd, 'USD')}</td>
                    </>
                  ) : null}
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      ) : null}

      {view === 'detail' ? (
        <Card>
          <CardContent className="px-2 pb-4 pt-2 sm:px-4">
            <StatementHeader company={user.activeCompany.name} title="Inventory Valuation Detail" period="Every movement, batch by batch" />
            <ValuationDetail
              showCost={showCost}
              groups={detail.map((g) => ({
                key: g.batchId,
                heading: `${g.itemName} · ${g.batchNumber}`,
                sub: [g.shipmentReference, g.containerNumber, `Lot ${g.lotNumber}`].filter(Boolean).join(' · '),
                href: `/inventory/batches/${g.batchId}`,
                closingKg: formatQuantityKg(g.closingKg),
                closingValue: formatMoney(g.closingValueUsd, 'USD'),
                movements: g.movements.map((m) => ({
                  key: m.id,
                  date: formatDate(m.date),
                  type: titleCase(m.type.replaceAll('_', ' ')),
                  warehouse: m.warehouseName ?? '—',
                  quantity: formatQuantityKg(m.quantityKg),
                  rate: formatMoney(m.unitCostUsd, 'USD'),
                  cost: formatMoney(m.costUsd, 'USD'),
                  onHand: formatQuantityKg(m.onHandAfterKg),
                  value: formatMoney(m.valueAfterUsd, 'USD'),
                })),
              }))}
            />
          </CardContent>
        </Card>
      ) : null}

      {view !== 'warehouse' ? null : (
      <>
      <PrintHeader
        title="Inventory Valuation"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      <MetricGrid>
        <Metric label="Lines" value={String(rows.length)} />
        <Metric label="On hand" value={formatQuantityKg(totalKg)} />
        {showCost ? <Metric label="Value" value={formatMoney(totalUsd, 'USD')} /> : null}
      </MetricGrid>

      {rows.length === 0 ? (
        <EmptyState title="No stock on hand" description="Receive a purchase order into a warehouse and it will appear here." />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Stock at landed cost</CardTitle>
            <CardDescription>Each row is one batch in one warehouse. Empty bins are omitted.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Warehouse</TH>
                    <TH>Coffee</TH>
                    <TH>Batch</TH>
                    <TH>Lot</TH>
                    <TH>Container</TH>
                    <TH numeric>On hand</TH>
                    <TH numeric>Available</TH>
                    {showCost ? (
                      <>
                        <TH numeric>Landed / KG</TH>
                        <TH numeric>Value USD</TH>
                      </>
                    ) : null}
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={`${row.warehouseId}-${row.batchId}`}>
                      <TD>
                        <span className="block font-medium">{row.warehouseName}</span>
                        <span className="block text-xs text-ink-subtle">{row.warehouseCode}</span>
                      </TD>
                      <TD>
                        <Link href={`/items/${row.itemId}`} className="hover:underline">
                          {row.itemName}
                        </Link>
                      </TD>
                      <TD>
                        <Link href={`/inventory/batches/${row.batchId}`} className="font-medium hover:underline">
                          {row.batchNumber}
                        </Link>
                      </TD>
                      <TD className="text-ink-muted">{row.lotNumber}</TD>
                      <TD className="font-mono text-xs">{row.containerNumber ?? '—'}</TD>
                      <TD numeric>{formatQuantityKg(row.onHandKg)}</TD>
                      <TD numeric className="text-ink-muted">{formatQuantityKg(row.availableKg)}</TD>
                      {showCost ? (
                        <>
                          <TD numeric>{formatMoney(row.landedUnitCostUsd, 'USD')}</TD>
                          <TD numeric className="font-medium">{formatMoney(row.valueUsd, 'USD')}</TD>
                        </>
                      ) : null}
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <tr>
                    <TD colSpan={5}>Total</TD>
                    <TD numeric>{formatQuantityKg(totalKg)}</TD>
                    <TD />
                    {showCost ? (
                      <>
                        <TD />
                        <TD numeric>{formatMoney(totalUsd, 'USD')}</TD>
                      </>
                    ) : null}
                  </tr>
                </TFoot>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>
      )}
      </>
      )}
    </div>
  );
}