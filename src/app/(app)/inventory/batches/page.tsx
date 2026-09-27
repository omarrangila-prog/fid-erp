import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getBatchStock } from '@/lib/services/stock';
import { getBatchCostings } from '@/lib/services/landed-cost';
import { equivalentText } from '@/lib/dual-currency';
import { getShipmentOrdinals, shipmentOrdinalLabel } from '@/lib/services/shipment';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyAction } from '@/components/shared/empty-action';
import { BatchesClient, type BatchRow } from '@/app/(app)/inventory/batches/batches-client';

export const metadata: Metadata = { title: 'Batch / Lot Stock' };
export const dynamic = 'force-dynamic';

export default async function BatchesPage() {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const showValue = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const [batches, ordinals, costings] = await Promise.all([
    getBatchStock({ companyId: user.activeCompany.id, includeEmpty: true }),
    getShipmentOrdinals(user.activeCompany.id),
    showValue ? getBatchCostings({ companyId: user.activeCompany.id }) : Promise.resolve([]),
  ]);
  // Each batch's landed cost per kilo in the company's currency: the purchase
  // at its own rate and each cost at its own — never one rate for all.
  const localPerKg = new Map(costings.map((c) => [c.batchId, c.landedPerKgLocal]));
  const local = user.activeCompany.localCurrency;

  const rows: BatchRow[] = batches.map((b) => ({
    id: b.batchId,
    batchNumber: b.batchNumber,
    lotNumber: b.lotNumber,
    itemName: b.itemName,
    origin: b.itemCode,
    containerNumber: b.containerNumber,
    shipmentLabel: shipmentOrdinalLabel(ordinals.get(b.shipmentId)),
    shipmentId: b.shipmentId,
    contractNumber: b.contractNumber,
    contractReference: b.contractReference,
    warehouses: b.warehouseNames,
    orderedLabel: formatQuantityKg(b.orderedKg),
    orderedSort: Number(b.orderedKg),
    receivedLabel: formatQuantityKg(b.receivedKg),
    receivedSort: Number(b.receivedKg),
    inTransitLabel: b.inTransitKg.greaterThan(0) ? formatQuantityKg(b.inTransitKg) : '—',
    inTransitSort: Number(b.inTransitKg),
    soldLabel: formatQuantityKg(b.soldKg),
    soldSort: Number(b.soldKg),
    availableLabel: formatQuantityKg(b.availableKg),
    availableSort: Number(b.availableKg),
    bags: b.bags,
    landedCostLabel: formatMoney(b.unitCostUsd, 'USD'),
    landedCostEquivalent: equivalentText({ amount: b.unitCostUsd, currency: 'USD', localCurrency: local, amountLocal: localPerKg.get(b.batchId) ?? null }),
    landedCostSort: Number(b.unitCostUsd),
    valueLabel: formatMoney(b.stockValueUsd, 'USD'),
    valueEquivalent: equivalentText({
      amount: b.stockValueUsd,
      currency: 'USD',
      localCurrency: local,
      amountLocal: localPerKg.has(b.batchId) ? b.availableKg.times(localPerKg.get(b.batchId)!) : null,
    }),
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
        showValue={showValue}
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
      />
    </div>
  );
}
