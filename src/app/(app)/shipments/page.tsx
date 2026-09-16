import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { formatQuantityKg, formatDate, daysUntil, formatMoney } from '@/lib/format';
import { getShipmentSettlement } from '@/lib/services/shipment';
import { getShipmentCostingIndex } from '@/lib/services/landed-cost';
import { getWarehouseLabels } from '@/lib/services/stock';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyAction } from '@/components/shared/empty-action';
import { ShipmentsClient, type ShipmentRow } from '@/app/(app)/shipments/shipments-client';

export const metadata: Metadata = { title: 'Shipments' };
export const dynamic = 'force-dynamic';

export default async function ShipmentsPage() {
  const user = await requirePageAccess(PERMISSIONS.SHIPMENTS_VIEW);
  const companyId = user.activeCompany.id;

  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);
  const [shipments, warehouses, costing] = await Promise.all([
    prisma.shipment.findMany({
      where: { companyId, purchaseContract: { status: 'POSTED' } },
      orderBy: [{ etaDate: 'asc' }, { shipmentNumber: 'desc' }],
      include: {
        purchaseContract: { select: { contractNumber: true } },
        vendor: { select: { vendorName: true } },
        customer: { select: { customerName: true } },
        item: { select: { itemName: true } },
        shippingLine: { select: { name: true } },
        batches: { select: { orderedQuantityKg: true, soldQuantityKg: true, orderedBags: true } },
      },
    }),
    getWarehouseLabels(companyId),
    showCost ? getShipmentCostingIndex(companyId) : Promise.resolve(new Map()),
  ]);

  const rows: ShipmentRow[] = await Promise.all(
    shipments.map(async (s) => {
      const ordered = s.batches.reduce((a, b) => a.plus(dec(b.orderedQuantityKg)), dec(0));
      const sold = s.batches.reduce((a, b) => a.plus(dec(b.soldQuantityKg)), dec(0));
      const soldPct = ordered.greaterThan(0) ? Number(sold.dividedBy(ordered).times(100)) : 0;
      const settlement = await getShipmentSettlement(prisma as never, companyId, s.id);

      const cost = costing.get(s.id);
      return {
        id: s.id,
        shipmentNumber: s.shipmentNumber,
        jobNumber: s.jobNumber,
        contractNumber: s.purchaseContract.contractNumber,
        vendorName: s.vendor.vendorName,
        customerName: s.customer?.customerName ?? null,
        itemName: s.item.itemName,
        origin: s.origin,
        quantityLabel: formatQuantityKg(s.quantityKg),
        quantitySort: Number(s.quantityKg),
        bags: s.bags,
        containers: s.containers,
        bookingNumber: s.bookingNumber,
        billOfLading: s.billOfLading,
        vesselName: s.vesselName,
        shippingLine: s.shippingLine?.name ?? null,
        etaDate: formatDate(s.etaDate),
        etaSort: s.etaDate?.getTime() ?? Number.MAX_SAFE_INTEGER,
        etaDays: daysUntil(s.etaDate),
        status: s.status,
        documentStatus: s.documentStatus,
        settlement: settlement.status,
        soldPct,
        soldLabel: sold.greaterThan(0) ? `${soldPct.toFixed(0)}%` : 'Unsold',
        warehouseNames: warehouses.byShipment.get(s.id) ?? '',
        purchaseUsd: cost ? formatMoney(cost.goodsUsd, 'USD') : null,
        expensesLocal: cost ? formatMoney(cost.expenseLocal, cost.localCurrency) : null,
        expensesUsd: cost ? formatMoney(cost.expenseUsd, 'USD') : null,
        landedUsd: cost ? formatMoney(cost.totalLandedUsd, 'USD') : null,
        landedLocal: cost ? formatMoney(cost.totalLandedLocal, cost.localCurrency) : null,
        costPerKg: cost ? formatMoney(cost.costPerKgUsd, 'USD') : null,
        costPerMt: cost ? formatMoney(cost.costPerMtUsd, 'USD') : null,
        remainingKg: cost ? formatQuantityKg(cost.remainingKg) : null,
        localCurrency: cost?.localCurrency ?? null,
      };
    }),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shipments"
        description="Every approved contract opens a job. Costs and sales roll up to it, and profitability is measured against it."
        breadcrumbs={[{ label: 'Trading' }, { label: 'Shipments' }]}
      />
      <ShipmentsClient
        rows={rows}
        showCost={showCost}
        canAddExpense={can(user, PERMISSIONS.EXPENSES_CREATE)}
        emptyAction={
          can(user, PERMISSIONS.PURCHASES_VIEW) ? (
            <EmptyAction href="/purchases" label="Open purchase contracts" tone="go" />
          ) : undefined
        }
      />
    </div>
  );
}
