import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import { getStockMovementSummary } from '@/lib/services/stock';
import { PageHeader } from '@/components/shared/page-header';
import { ExportLinks } from '@/components/shared/export-links';
import { exportHref } from '@/components/shared/excel-link';
import { CustomizePanel } from '@/components/reports/customize-panel';
import { FavouriteStar } from '@/components/reports/report-statement';
import { ReportSummary } from '@/components/shared/report-summary';
import { DateRangePicker } from '@/components/shared/date-range';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';

export const metadata: Metadata = { title: 'Daily Stock Movement' };
export const dynamic = 'force-dynamic';

/**
 * Opening stock, what moved, closing stock.
 *
 * The question this answers is the warehouse keeper's: does what is on the
 * shelf agree with what the system says should be there? So every column is
 * a movement that really happens — received, transferred in or out, sold,
 * adjusted — and opening plus movements equals closing on every row.
 */
export default async function StockMovementPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; warehouse?: string }>;
}) {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const params = await searchParams;
  const companyId = user.activeCompany.id;

  const today = new Date();
  const from = params.from ? new Date(`${params.from}T00:00:00.000Z`) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const to = params.to ? new Date(`${params.to}T00:00:00.000Z`) : today;

  const [rows, warehouses] = await Promise.all([
    getStockMovementSummary({ companyId, from, to, warehouseId: params.warehouse || undefined }),
    prisma.warehouse.findMany({ where: { companyId, status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);

  const totals = rows.reduce(
    (acc, row) => ({
      opening: acc.opening.plus(row.openingKg),
      receipts: acc.receipts.plus(row.receiptsKg),
      inward: acc.inward.plus(row.transfersInKg),
      outward: acc.outward.plus(row.transfersOutKg),
      sales: acc.sales.plus(row.salesKg),
      adjustments: acc.adjustments.plus(row.adjustmentsKg),
      closing: acc.closing.plus(row.closingKg),
      value: acc.value.plus(row.closingValueUsd),
    }),
    { opening: dec(0), receipts: dec(0), inward: dec(0), outward: dec(0), sales: dec(0), adjustments: dec(0), closing: dec(0), value: dec(0) },
  );

  const movements = totals.receipts.plus(totals.inward).plus(totals.outward).plus(totals.sales).plus(totals.adjustments);
  const tiesOut = totals.opening.plus(movements).minus(totals.closing).abs().lessThan('0.001');
  const warehouseName = warehouses.find((w) => w.id === params.warehouse)?.name;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Daily Stock Movement"
        description="What was on the shelf when the period opened, everything that moved, and what is there now."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Daily Stock Movement' }]}
        actions={
          <>
            <FavouriteStar href="/reports/stock-movement" label="Daily Stock Movement" />
            <ExportLinks
              href={exportHref('stock-movement', {
                from: from.toISOString().slice(0, 10),
                to: to.toISOString().slice(0, 10),
                ...(params.warehouse ? { warehouse: params.warehouse } : {}),
              })}
              print={false}
            />
            <CustomizePanel report="Daily Stock Movement" fields={['period']} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader title="Daily Stock Movement" companyName={user.activeCompany.name} country={user.activeCompany.country} />

      <DateRangePicker defaultFrom={from.toISOString().slice(0, 10)} defaultTo={to.toISOString().slice(0, 10)} />

      <ReportSummary
        figures={[
          { label: 'Opening stock', value: formatQuantityKg(totals.opening) },
          { label: 'Received', value: formatQuantityKg(totals.receipts) },
          { label: 'Sold', value: formatQuantityKg(totals.sales.abs()) },
          { label: 'Closing stock', value: formatQuantityKg(totals.closing), lead: true, hint: can(user, PERMISSIONS.PURCHASE_COST_VIEW) ? formatMoney(totals.value, 'USD') : undefined },
        ]}
        status={{
          label: tiesOut ? 'Opening + movements = closing' : 'Attention required',
          ok: tiesOut,
          detail: tiesOut ? undefined : 'The movements do not add up to the closing balance. Check the stock ledger.',
        }}
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No stock movement in this period"
          description={`Nothing was received, sold, transferred or adjusted${warehouseName ? ` in ${warehouseName}` : ''} between these dates.`}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>By coffee and warehouse</CardTitle>
            <CardDescription>
              Transfers in and out net to nothing across the company: moving coffee between warehouses is not a sale.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Coffee</TH>
                    <TH>Warehouse</TH>
                    <TH numeric>Opening</TH>
                    <TH numeric>Received</TH>
                    <TH numeric>Transfers in</TH>
                    <TH numeric>Transfers out</TH>
                    <TH numeric>Sold</TH>
                    <TH numeric>Adjustments</TH>
                    <TH numeric>Closing</TH>
                    {can(user, PERMISSIONS.PURCHASE_COST_VIEW) ? <TH numeric>Closing value</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={`${row.itemId}:${row.warehouseId ?? 'none'}`}>
                      <TD className="font-medium">{row.itemName}</TD>
                      <TD className="text-xs">{row.warehouseName}</TD>
                      <TD numeric className="text-ink-muted">{formatQuantityKg(row.openingKg)}</TD>
                      <TD numeric>{row.receiptsKg.isZero() ? '—' : formatQuantityKg(row.receiptsKg)}</TD>
                      <TD numeric>{row.transfersInKg.isZero() ? '—' : formatQuantityKg(row.transfersInKg)}</TD>
                      <TD numeric>{row.transfersOutKg.isZero() ? '—' : formatQuantityKg(row.transfersOutKg)}</TD>
                      <TD numeric>{row.salesKg.isZero() ? '—' : formatQuantityKg(row.salesKg)}</TD>
                      <TD numeric>{row.adjustmentsKg.isZero() ? '—' : formatQuantityKg(row.adjustmentsKg)}</TD>
                      <TD numeric className="font-semibold">{formatQuantityKg(row.closingKg)}</TD>
                      {can(user, PERMISSIONS.PURCHASE_COST_VIEW) ? (
                        <TD numeric>{formatMoney(row.closingValueUsd, 'USD')}</TD>
                      ) : null}
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <tr>
                    <TD colSpan={2}>Total</TD>
                    <TD numeric>{formatQuantityKg(totals.opening)}</TD>
                    <TD numeric>{formatQuantityKg(totals.receipts)}</TD>
                    <TD numeric>{formatQuantityKg(totals.inward)}</TD>
                    <TD numeric>{formatQuantityKg(totals.outward)}</TD>
                    <TD numeric>{formatQuantityKg(totals.sales)}</TD>
                    <TD numeric>{formatQuantityKg(totals.adjustments)}</TD>
                    <TD numeric>{formatQuantityKg(totals.closing)}</TD>
                    {can(user, PERMISSIONS.PURCHASE_COST_VIEW) ? <TD numeric>{formatMoney(totals.value, 'USD')}</TD> : null}
                  </tr>
                </TFoot>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
