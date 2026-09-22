import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec, sum, toMoney, toUnitCost, Decimal } from '@/lib/money';
import { formatQuantityKg, formatDate, daysUntil, formatMoney } from '@/lib/format';
import { getShipmentSettlement } from '@/lib/services/shipment';
import { getShipmentCostingIndex, getBatchCostings } from '@/lib/services/landed-cost';
import { getWarehouseLabels } from '@/lib/services/stock';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyAction } from '@/components/shared/empty-action';
import {
  ShipmentsClient,
  type ShipmentGroupRow,
  type ShipmentLineRow,
} from '@/app/(app)/shipments/shipments-client';

export const metadata: Metadata = { title: 'Shipments' };
export const dynamic = 'force-dynamic';

/**
 * One row per shipment of coffee — the order it was bought on — with its
 * containers and items underneath.
 *
 * The loading sheet keeps one shipment record per container so each can
 * carry its own ETA, B/L and arrival. Listing those records one per row made
 * a single consignment read as "Shipment 1 of 3, 2 of 3, 3 of 3". They are
 * grouped here by the purchase order they belong to — the relation in the
 * database, never a similar-looking name — and each container/item line is
 * a child of that row.
 */
export default async function ShipmentsPage() {
  const user = await requirePageAccess(PERMISSIONS.SHIPMENTS_VIEW);
  const companyId = user.activeCompany.id;

  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);
  const [shipments, warehouses, costing] = await Promise.all([
    prisma.shipment.findMany({
      where: { companyId, purchaseContract: { status: 'POSTED' } },
      orderBy: [{ createdAt: 'asc' }, { shipmentNumber: 'asc' }],
      include: {
        purchaseContract: { select: { id: true, contractNumber: true, contractReference: true, createdAt: true } },
        vendor: { select: { vendorName: true } },
        customer: { select: { customerName: true } },
        item: { select: { itemName: true } },
        shippingLine: { select: { name: true } },
        batches: {
          where: { status: 'ACTIVE' },
          orderBy: { batchNumber: 'asc' },
          select: {
            id: true,
            batchNumber: true,
            orderedQuantityKg: true,
            receivedQuantityKg: true,
            soldQuantityKg: true,
            orderedBags: true,
            containerId: true,
            item: { select: { itemName: true } },
            lot: { select: { lotNumber: true } },
            container: { select: { containerNumber: true } },
          },
        },
      },
    }),
    getWarehouseLabels(companyId),
    showCost ? getShipmentCostingIndex(companyId) : Promise.resolve(new Map()),
  ]);

  // The order's shipment records, in the order they were opened.
  const byContract = new Map<string, typeof shipments>();
  for (const shipment of shipments) {
    const list = byContract.get(shipment.purchaseContractId) ?? [];
    list.push(shipment);
    byContract.set(shipment.purchaseContractId, list);
  }

  const groups = [...byContract.values()].sort(
    (a, b) => a[0].purchaseContract.createdAt.getTime() - b[0].purchaseContract.createdAt.getTime(),
  );

  const rows: ShipmentGroupRow[] = await Promise.all(
    groups.map(async (records, groupIndex) => {
      const first = records[0];
      const contract = first.purchaseContract;

      const settlements = await Promise.all(
        records.map((s) => getShipmentSettlement(prisma as never, companyId, s.id)),
      );
      const batchCosts = showCost
        ? new Map(
            (
              await Promise.all(records.map((s) => getBatchCostings({ companyId, shipmentId: s.id })))
            )
              .flat()
              .map((line) => [line.batchId, line]),
          )
        : new Map();

      const lines: ShipmentLineRow[] = records.flatMap((s, recordIndex): ShipmentLineRow[] => {
        const etaIso = s.etaDate ? s.etaDate.toISOString().slice(0, 10) : null;
        const shared = {
          shipmentId: s.id,
          recordLabel: records.length > 1 ? `${recordIndex + 1} of ${records.length}` : null,
          etaDate: formatDate(s.etaDate),
          etaIso,
          etaDays: daysUntil(s.etaDate),
          status: s.status,
          bookingNumber: s.bookingNumber,
          billOfLading: s.billOfLading,
        };
        // A record with no batches yet (not loaded) still shows as one line.
        if (s.batches.length === 0) {
          return [
            {
              ...shared,
              key: s.id,
              itemName: s.item.itemName,
              containerNumber: null,
              lotNumber: null,
              batchNumber: null,
              quantityLabel: formatQuantityKg(s.quantityKg),
              receipt: 'Not received',
              warehouse: warehouses.byShipment.get(s.id) || '—',
              landedUsd: null,
              costPerKg: null,
            },
          ];
        }
        return s.batches.map((b) => {
          const ordered = dec(b.orderedQuantityKg);
          const received = dec(b.receivedQuantityKg);
          const cost = batchCosts.get(b.id);
          return {
            ...shared,
            key: b.id,
            itemName: b.item.itemName,
            containerNumber: b.container?.containerNumber ?? null,
            lotNumber: b.lot.lotNumber,
            batchNumber: b.batchNumber,
            quantityLabel: formatQuantityKg(ordered),
            receipt: received.greaterThanOrEqualTo(ordered) && ordered.greaterThan(0)
              ? 'Received'
              : received.greaterThan(0)
                ? `Part received · ${formatQuantityKg(received)}`
                : 'Not received',
            warehouse: warehouses.byBatch.get(b.id) || '—',
            landedUsd: cost ? formatMoney(cost.landedUsd, 'USD') : null,
            costPerKg: cost ? formatMoney(cost.landedPerKgUsd, 'USD') : null,
          };
        });
      });

      const allBatches = records.flatMap((s) => s.batches);
      const items = [...new Set(allBatches.length ? allBatches.map((b) => b.item.itemName) : records.map((s) => s.item.itemName))];
      const containerIds = new Set(allBatches.map((b) => b.containerId).filter(Boolean));
      const containers = containerIds.size > 0 ? containerIds.size : records.reduce((n, s) => n + s.containers, 0);
      const warehouseNames = [
        ...new Set(
          records
            .flatMap((s) => (warehouses.byShipment.get(s.id) ?? '').split(', '))
            .filter(Boolean),
        ),
      ];

      const kg = sum(records.map((s) => dec(s.quantityKg)));
      const ordered = sum(allBatches.map((b) => dec(b.orderedQuantityKg)));
      const sold = sum(allBatches.map((b) => dec(b.soldQuantityKg)));
      const soldPct = ordered.greaterThan(0) ? Number(sold.dividedBy(ordered).times(100)) : 0;

      const etas = records.map((s) => s.etaDate).filter((d): d is Date => Boolean(d)).sort((a, b) => a.getTime() - b.getTime());
      const earliest = etas[0] ?? null;
      const latest = etas[etas.length - 1] ?? null;

      // The order's costing is the sum of its records', divided by the same
      // quantity each record already uses: received, or ordered until then.
      const costs = records.map((s) => costing.get(s.id)).filter(Boolean) as Array<
        NonNullable<ReturnType<typeof costing.get>>
      >;
      const basisKg = sum(
        records.map((s) => {
          const received = sum(s.batches.map((b) => dec(b.receivedQuantityKg)));
          return received.greaterThan(0) ? received : sum(s.batches.map((b) => dec(b.orderedQuantityKg)));
        }),
      );
      const landedUsd = toMoney(sum(costs.map((c) => dec(c.totalLandedUsd))));
      const landedLocal = toMoney(sum(costs.map((c) => dec(c.totalLandedLocal))));
      const localCurrency = costs[0]?.localCurrency ?? null;
      const perKg = (total: Decimal) => (basisKg.greaterThan(0) ? toUnitCost(total.dividedBy(basisKg)) : dec(0));

      const distinct = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => Boolean(v)))];
      const bookings = distinct(records.map((s) => s.bookingNumber));
      const bls = distinct(records.map((s) => s.billOfLading));
      const lineNames = distinct(records.map((s) => s.shippingLine?.name ?? null));
      const vessels = distinct(records.map((s) => s.vesselName));

      return {
        id: contract.id,
        label: `Shipment ${groupIndex + 1}`,
        sequence: groupIndex + 1,
        firstShipmentId: first.id,
        shipmentIds: records.map((s) => s.id),
        contractNumber: contract.contractNumber,
        contractReference: contract.contractReference,
        vendorName: first.vendor.vendorName,
        customerName: distinct(records.map((s) => s.customer?.customerName ?? null)).join(', ') || null,
        items,
        containers,
        kgLabel: formatQuantityKg(kg),
        kgSort: Number(kg),
        bags: records.reduce((n, s) => n + s.bags, 0),
        warehouse: warehouseNames.length === 0 ? '—' : warehouseNames.length === 1 ? warehouseNames[0] : 'Multiple warehouses',
        warehouseNames: warehouseNames.join(', '),
        etaLabel:
          !earliest || !latest
            ? '—'
            : earliest.getTime() === latest.getTime()
              ? formatDate(earliest)
              : `${formatDate(earliest)} – ${formatDate(latest)}`,
        etaSort: earliest?.getTime() ?? Number.MAX_SAFE_INTEGER,
        etaDays: records.length === 1 ? daysUntil(first.etaDate) : null,
        statuses: records.map((s) => s.status),
        documentStatuses: records.map((s) => s.documentStatus),
        settlements: settlements.map((s) => s.status),
        soldPct,
        soldLabel: sold.greaterThan(0) ? `${soldPct.toFixed(0)}%` : 'Unsold',
        booking: bookings.length > 1 ? `${bookings.length} bookings` : (bookings[0] ?? null),
        billOfLading: bls.length > 1 ? `${bls.length} B/Ls` : (bls[0] ?? null),
        shippingLine: lineNames.join(', ') || null,
        vesselName: vessels.length > 1 ? `${vessels.length} vessels` : (vessels[0] ?? null),
        searchText: [
          contract.contractReference,
          contract.contractNumber,
          first.vendor.vendorName,
          ...items,
          ...records.flatMap((s) => [s.shipmentNumber, s.jobNumber, s.bookingNumber, s.billOfLading, s.vesselName]),
          ...allBatches.flatMap((b) => [b.batchNumber, b.lot.lotNumber, b.container?.containerNumber]),
          ...warehouseNames,
        ]
          .filter(Boolean)
          .join(' '),
        purchaseUsd: costs.length ? formatMoney(toMoney(sum(costs.map((c) => dec(c.goodsUsd)))), 'USD') : null,
        expensesLocal:
          costs.length && localCurrency
            ? formatMoney(toMoney(sum(costs.map((c) => dec(c.expenseLocal)))), localCurrency)
            : null,
        expensesUsd: costs.length ? formatMoney(toMoney(sum(costs.map((c) => dec(c.expenseUsd)))), 'USD') : null,
        landedUsd: costs.length ? formatMoney(landedUsd, 'USD') : null,
        landedLocal: costs.length && localCurrency ? formatMoney(landedLocal, localCurrency) : null,
        costPerKg: costs.length ? formatMoney(perKg(landedUsd), 'USD') : null,
        costPerKgLocal: costs.length && localCurrency ? formatMoney(perKg(landedLocal), localCurrency) : null,
        // Coffee is quoted by the tonne as often as by the kilo, in both
        // currencies, and grouping the list by contract must not lose that.
        costPerMt: costs.length ? formatMoney(perKg(landedUsd).times(1000), 'USD') : null,
        costPerMtLocal:
          costs.length && localCurrency ? formatMoney(perKg(landedLocal).times(1000), localCurrency) : null,
        remainingKg: costs.length ? formatQuantityKg(sum(costs.map((c) => dec(c.remainingKg)))) : null,
        lines,
      };
    }),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shipments"
        description="One row per shipment. Open the arrow to see its containers and items; View opens the full shipment."
        breadcrumbs={[{ label: 'Trading' }, { label: 'Shipments' }]}
      />
      <ShipmentsClient
        rows={rows}
        showCost={showCost}
        canAddExpense={can(user, PERMISSIONS.EXPENSES_CREATE)}
        canUpdateEta={can(user, PERMISSIONS.SHIPMENTS_UPDATE)}
        emptyAction={
          can(user, PERMISSIONS.PURCHASES_VIEW) ? (
            <EmptyAction href="/purchases" label="Open purchase contracts" tone="go" />
          ) : undefined
        }
      />
    </div>
  );
}
