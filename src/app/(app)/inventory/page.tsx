import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec, toMoney, toQuantity } from '@/lib/money';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import { getWarehouseStock } from '@/lib/services/dashboard';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyAction } from '@/components/shared/empty-action';
import { StockClient, type StockRow } from '@/app/(app)/inventory/stock-client';
import { Boxes, Truck, Package, Warehouse as WarehouseIcon, ArrowLeftRight, History, Layers } from 'lucide-react';

export const metadata: Metadata = { title: 'Current Stock' };
export const dynamic = 'force-dynamic';

export default async function InventoryPage() {
  const user = await requirePageAccess(PERMISSIONS.INVENTORY_VIEW);
  const companyId = user.activeCompany.id;
  const showValue = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const [balances, warehouses, warehouseStock, inTransit] = await Promise.all([
    prisma.inventoryBalance.findMany({
      where: { companyId },
      include: {
        item: { select: { itemName: true, itemCode: true, originCountry: true, region: true } },
        warehouse: { select: { id: true, name: true } },
        batch: { select: { landedUnitCostUsd: true } },
      },
    }),
    prisma.warehouse.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    getWarehouseStock(companyId),
    prisma.batch.aggregate({
      where: { companyId, status: 'ACTIVE' },
      _sum: { inTransitQuantityKg: true },
    }),
  ]);

  // Aggregate to one row per coffee per warehouse.
  const grouped = new Map<string, StockRow>();
  for (const balance of balances) {
    const key = `${balance.itemId}:${balance.warehouseId}`;
    const existing = grouped.get(key);
    const onHand = dec(balance.onHandKg);
    const reserved = dec(balance.reservedKg);
    const available = dec(balance.availableKg);
    const value = toMoney(onHand.times(dec(balance.batch.landedUnitCostUsd)));

    if (existing) {
      existing.onHandSort += Number(onHand);
      existing.availableSort += Number(available);
      existing.bags += balance.bags;
      existing.valueSort += Number(value);
      existing.onHandLabel = formatQuantityKg(existing.onHandSort);
      existing.availableLabel = formatQuantityKg(existing.availableSort);
      existing.reservedLabel = formatQuantityKg(
        dec(existing.reservedLabel.replace(/[^\d.-]/g, '') || 0).plus(reserved),
      );
      existing.valueLabel = formatMoney(existing.valueSort, 'USD');
    } else {
      grouped.set(key, {
        id: key,
        itemName: balance.item.itemName,
        itemCode: balance.item.itemCode,
        origin: balance.item.originCountry,
        category: balance.item.region ?? '',
        warehouse: balance.warehouse.name,
        warehouseId: balance.warehouseId,
        onHandLabel: formatQuantityKg(onHand),
        onHandSort: Number(onHand),
        reservedLabel: formatQuantityKg(reserved),
        availableLabel: formatQuantityKg(available),
        availableSort: Number(available),
        inTransitLabel: '—',
        bags: balance.bags,
        valueLabel: formatMoney(value, 'USD'),
        valueSort: Number(value),
      });
    }
  }

  const rows = [...grouped.values()].filter((r) => r.onHandSort !== 0);
  const totalOnHand = rows.reduce((a, r) => a + r.onHandSort, 0);
  const totalAvailable = rows.reduce((a, r) => a + r.availableSort, 0);
  const totalValue = rows.reduce((a, r) => a + r.valueSort, 0);
  const totalBags = rows.reduce((a, r) => a + r.bags, 0);
  const inTransitKg = toQuantity(inTransit._sum.inTransitQuantityKg ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Current Stock"
        description="Company totals with the warehouse behind them. Every figure comes from the movement ledger."
        breadcrumbs={[{ label: 'Inventory' }, { label: 'Current Stock' }]}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/inventory/movements">
                <History />
                Movements
              </Link>
            </Button>
            {can(user, PERMISSIONS.INVENTORY_TRANSFER) ? (
              <Button asChild>
                <Link href="/inventory/transfers">
                  <ArrowLeftRight />
                  Transfers
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="On hand" value={formatQuantityKg(totalOnHand)} icon={Boxes} />
        <StatCard
          label="Available to sell"
          value={formatQuantityKg(totalAvailable)}
          sublabel={`${totalBags.toLocaleString()} bags`}
          icon={Package}
        />
        <StatCard
          label="In transit"
          value={formatQuantityKg(inTransitKg)}
          sublabel="Owned, not yet landed"
          icon={Truck}
          href="/shipments"
        />
        {showValue ? (
          <StatCard label="Stock value" value={formatMoney(totalValue, 'USD')} icon={WarehouseIcon} />
        ) : (
          <StatCard label="Warehouses" value={String(warehouses.length)} icon={WarehouseIcon} />
        )}
      </div>

      {warehouseStock.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Where the stock is</CardTitle>
            <CardDescription>Company stock split by physical location.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {warehouseStock.map((w) => (
              <div key={w.warehouseId} className="rounded-lg border border-line p-3">
                <p className="truncate text-sm font-medium text-ink">{w.name}</p>
                <p className="tnum mt-1 text-lg font-semibold text-forest-800">{formatQuantityKg(w.onHandKg)}</p>
                <p className="text-xs text-ink-subtle">
                  {w.bags.toLocaleString()} bags
                  {showValue ? ` · ${formatMoney(w.valueUsd, 'USD')}` : ''}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {[
          { href: '/inventory/batches', label: 'Batch / lot stock', icon: Layers },
          { href: '/inventory/shipments', label: 'Shipment stock', icon: Truck },
          { href: '/inventory/movements', label: 'Stock movements', icon: History },
        ].map((link) => (
          <Button key={link.href} variant="outline" size="sm" asChild>
            <Link href={link.href}>
              <link.icon />
              {link.label}
            </Link>
          </Button>
        ))}
      </div>

      <StockClient
        emptyAction={
          can(user, PERMISSIONS.PURCHASES_VIEW) ? (
            <EmptyAction href="/purchases" label="Receive a purchase contract" tone="go" />
          ) : undefined
        }
        rows={rows}
        warehouses={warehouses}
        companyCode={user.activeCompany.code}
        showValue={showValue}
        canExport={can(user, PERMISSIONS.REPORTS_EXPORT)}
      />
    </div>
  );
}
