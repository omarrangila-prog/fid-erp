import type { Metadata } from 'next';
import { PrintHeader } from '@/components/shared/print-header';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getBatchStock } from '@/lib/services/stock';
import { getBatchCostings } from '@/lib/services/landed-cost';
import type { Decimal } from '@/lib/money';
import { equivalentText } from '@/lib/dual-currency';
import { getShipmentOrdinals, shipmentOrdinalLabel } from '@/lib/services/shipment';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyAction } from '@/components/shared/empty-action';
import { BatchesClient, type BatchRow } from '@/app/(app)/inventory/batches/batches-client';
import { redirect } from 'next/navigation';
import { warehouseScope } from '@/lib/auth/scope';

export const metadata: Metadata = { title: 'Batch / Lot Stock' };
export const dynamic = 'force-dynamic';

export default async function BatchesPage() {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  // Stock across every warehouse: someone limited to their own warehouses sees those on the stock page.
  if (warehouseScope(user)) redirect('/inventory');
  const showValue = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const [batches, ordinals, costings] = await Promise.all([
    getBatchStock({ companyId: user.activeCompany.id, includeEmpty: true }),
    getShipmentOrdinals(user.activeCompany.id),
    showValue ? getBatchCostings({ companyId: user.activeCompany.id }) : Promise.resolve([]),
  ]);
  /*
   * Each batch from the one shared costing — the purchase at its order's
   * current USD/MAD rate, each shipment cost at its own amount — in the
   * company's currency first, as Stock on Hand and Inventory Valuation state
   * it, with the dollars at the order's rate under it. Not the dollar cost
   * stored on the batch when it was received, which a PO rate edit leaves
   * behind.
   */
  const costingOf = new Map(costings.map((c) => [c.batchId, c]));
  const local = user.activeCompany.localCurrency;
  const atRate = (batchId: string, amount: Decimal) => {
    const rate = costingOf.get(batchId)?.rateLocalPerUsd;
    return rate && rate.greaterThan(0) ? amount.dividedBy(rate) : null;
  };

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
    ...(() => {
      const c = costingOf.get(b.batchId);
      if (!c) {
        return {
          landedCostLabel: formatMoney(b.unitCostUsd, 'USD'),
          landedCostEquivalent: null,
          landedCostSort: Number(b.unitCostUsd),
          valueLabel: formatMoney(b.stockValueUsd, 'USD'),
          valueEquivalent: null,
          valueSort: Number(b.stockValueUsd),
        };
      }
      const perKgUsd = atRate(b.batchId, c.landedPerKgLocal);
      const valueUsd = atRate(b.batchId, c.stockValueLocal);
      return {
        landedCostLabel: formatMoney(c.landedPerKgLocal, local),
        landedCostEquivalent: perKgUsd ? equivalentText({ amount: c.landedPerKgLocal, currency: local, localCurrency: local, amountUsd: perKgUsd }) : null,
        landedCostSort: Number(c.landedPerKgLocal),
        valueLabel: formatMoney(c.stockValueLocal, local),
        valueEquivalent: valueUsd ? equivalentText({ amount: c.stockValueLocal, currency: local, localCurrency: local, amountUsd: valueUsd }) : null,
        valueSort: Number(c.stockValueLocal),
      };
    })(),
    status: b.status,
  }));

  return (
    <div className="print-landscape space-y-6">
      <PageHeader
        title="Batch / Lot Stock"
        description="Full traceability: every batch, its lot, its container, where it is and what is left of it."
        breadcrumbs={[{ label: 'Inventory', href: '/inventory' }, { label: 'Batch / Lot Stock' }]}
      />
      <PrintHeader title="Batch / Lot Stock" companyName={user.activeCompany.name} country={user.activeCompany.country} currency={user.activeCompany.localCurrency} />
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
