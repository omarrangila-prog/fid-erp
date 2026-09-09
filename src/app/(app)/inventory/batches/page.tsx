import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getBatchStock } from '@/lib/services/stock';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyAction } from '@/components/shared/empty-action';
import { BatchesClient, type BatchRow } from '@/app/(app)/inventory/batches/batches-client';

export const metadata: Metadata = { title: 'Batch / Lot Stock' };
export const dynamic = 'force-dynamic';

export default async function BatchesPage() {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const showValue = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const batches = await getBatchStock({ companyId: user.activeCompany.id, includeEmpty: true });

  const rows: BatchRow[] = batches.map((b) => ({
    id: b.batchId,
    batchNumber: b.batchNumber,
    lotNumber: b.lotNumber,
    itemName: b.itemName,
    origin: b.itemCode,
    containerNumber: b.containerNumber,
    shipmentNumber: b.shipmentNumber,
    shipmentId: b.shipmentId,
    contractNumber: b.contractNumber,
    warehouses: b.warehouseNames,
    orderedLabel: formatQuantityKg(b.orderedKg),
    orderedSort: Number(b.orderedKg),
    receivedLabel: formatQuantityKg(b.receivedKg),
    inTransitLabel: b.inTransitKg.greaterThan(0) ? formatQuantityKg(b.inTransitKg) : '—',
    soldLabel: formatQuantityKg(b.soldKg),
    availableLabel: formatQuantityKg(b.availableKg),
    availableSort: Number(b.availableKg),
    bags: 0,
    landedCostLabel: formatMoney(b.unitCostUsd, 'USD'),
    valueLabel: formatMoney(b.stockValueUsd, 'USD'),
    valueSort: Number(b.stockValueUsd),
    status: b.status,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Batch / Lot Stock"
        description="Full traceability: every batch, its lot, its container, where it is and what is left of it."
        breadcrumbs={[{ label: 'Inventory', href: '/inventory' }, { label: 'Batch / Lot Stock' }]}
      />
      <BatchesClient
        emptyAction={
          can(user, PERMISSIONS.PURCHASES_VIEW) ? (
            <EmptyAction href="/purchases" label="Open purchase contracts" tone="go" />
          ) : undefined
        }
        rows={rows}
        companyCode={user.activeCompany.code}
        showValue={showValue}
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
      />
    </div>
  );
}
