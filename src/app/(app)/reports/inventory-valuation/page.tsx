import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getInventoryValuation } from '@/lib/services/stock';
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

export default async function InventoryValuationPage() {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);
  const rows = await getInventoryValuation(user.activeCompany.id);
  const totalKg = rows.reduce((sum, row) => sum.plus(row.onHandKg), dec(0));
  const totalUsd = rows.reduce((sum, row) => sum.plus(row.valueUsd), dec(0));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory Valuation"
        description="On-hand stock at each batch's landed cost, by warehouse."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Inventory Valuation' }]}
        actions={
          <>
            {can(user, PERMISSIONS.REPORTS_EXPORT) ? <ExportLinks href={exportHref('inventory-valuation', {})} /> : null}
            <PrintButton />
          </>
        }
      />
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
    </div>
  );
}
