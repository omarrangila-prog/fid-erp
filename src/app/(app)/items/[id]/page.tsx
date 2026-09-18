import type { Metadata } from 'next';
import { CostingTable } from '@/components/shared/costing-table';
import { getBatchCostings } from '@/lib/services/landed-cost';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import {
  PERMISSIONS,
  COFFEE_TYPE_LABELS,
  COFFEE_PROCESS_LABELS,
  PACKAGING_LABELS,
  SHIPMENT_STATUS_META,
} from '@/lib/constants';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { getBatchStock, getItemWarehouseStock } from '@/lib/services/stock';
import {
  WarehouseStockPanel,
  type WarehouseStock,
} from '@/app/(app)/items/[id]/warehouse-stock';
import { formatDate, formatMoney, formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent, TabCount } from '@/components/ui/tabs';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { StatCard, DetailRow } from '@/components/shared/stat-card';
import { ItemWarehouseStock } from '@/app/(app)/items/[id]/item-warehouse-stock';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const item = await prisma.coffeeItem.findUnique({ where: { id }, select: { itemName: true } });
  return { title: item?.itemName ?? 'Coffee' };
}

export default async function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.ITEMS_VIEW);
  const companyId = user.activeCompany.id;
  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const item = await prisma.coffeeItem.findFirst({
    where: { id, companyId },
    include: {
      lots: { orderBy: { createdAt: 'desc' }, select: { id: true, lotNumber: true, cropYear: true, originCountry: true } },
      shipments: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { vendor: { select: { vendorName: true } } },
      },
    },
  });

  if (!item) notFound();

  const [batches, warehouseStock, balances] = await Promise.all([
    getBatchStock({ companyId, itemId: id, includeEmpty: true }),
    getItemWarehouseStock(companyId, id),
    /*
     * Where this coffee physically sits, warehouse by warehouse and batch by
     * batch. The same coffee arrives in several containers with a batch each,
     * so the only useful shape is one row per batch per warehouse.
     */
    prisma.inventoryBalance.findMany({
      where: { companyId, itemId: id, onHandKg: { not: 0 } },
      select: {
        batchId: true,
        onHandKg: true,
        availableKg: true,
        bags: true,
        warehouse: { select: { id: true, name: true } },
        batch: {
          select: {
            batchNumber: true,
            container: { select: { containerNumber: true } },
            purchaseContract: { select: { contractReference: true } },
            shipment: { select: { jobNumber: true } },
          },
        },
      },
    }),
  ]);

  // Grouped by warehouse, largest first, so the busiest store leads.
  const byWarehouse = new Map<string, WarehouseStock>();
  for (const balance of balances) {
    const entry = byWarehouse.get(balance.warehouse.id) ?? {
      warehouseId: balance.warehouse.id,
      warehouseName: balance.warehouse.name,
      totalLabel: '',
      totalKg: 0,
      bags: 0,
      lots: [],
    };
    entry.totalKg += Number(balance.onHandKg);
    entry.bags += balance.bags;
    entry.lots.push({
      batchId: balance.batchId,
      batchNumber: balance.batch.batchNumber,
      containerNumber: balance.batch.container?.containerNumber ?? '—',
      reference: balance.batch.purchaseContract?.contractReference ?? '—',
      jobNumber: balance.batch.shipment?.jobNumber ?? '—',
      onHandLabel: formatQuantityKg(balance.onHandKg),
      availableLabel: formatQuantityKg(balance.availableKg),
      availableKg: Number(balance.availableKg),
      bags: balance.bags,
    });
    byWarehouse.set(balance.warehouse.id, entry);
  }
  const warehouseBreakdown = [...byWarehouse.values()]
    .map((w) => ({ ...w, totalLabel: formatQuantityKg(w.totalKg) }))
    .sort((a, b) => b.totalKg - a.totalKg);

  const availableKg = warehouseStock.totalAvailableKg;
  const soldKg = batches.reduce((a, b) => a.plus(b.soldKg), dec(0));
  const receivedKg = batches.reduce((a, b) => a.plus(b.receivedKg), dec(0));
  const stockValueUsd = batches.reduce((a, b) => a.plus(b.stockValueUsd), dec(0));

  // §15: stock and cost on the same screen.
  const costing = await getBatchCostings({ companyId, itemId: id });

  return (
    <div className="space-y-6">
      <PageHeader
        title={item.itemName}
        description={[item.itemCode, item.originCountry, item.region].filter(Boolean).join(' · ')}
        breadcrumbs={[{ label: 'Trading' }, { label: 'Items', href: '/items' }, { label: item.itemName }]}
        meta={
          <>
            <Badge tone={item.coffeeType === 'ARABICA' ? 'success' : item.coffeeType === 'ROBUSTA' ? 'info' : 'neutral'}>
              {COFFEE_TYPE_LABELS[item.coffeeType]}
            </Badge>
            <Badge tone="neutral">{COFFEE_PROCESS_LABELS[item.process]}</Badge>
            {item.grade ? <Badge tone="neutral">Grade {item.grade}</Badge> : null}
            {item.cropYear ? <Badge tone="neutral">Crop {item.cropYear}</Badge> : null}
          </>
        }
      />

      <ItemWarehouseStock
        totalAvailableKg={warehouseStock.totalAvailableKg.toString()}
        warehouses={warehouseStock.warehouses.map((warehouse) => ({
          warehouseId: warehouse.warehouseId,
          warehouseName: warehouse.warehouseName,
          warehouseCode: warehouse.warehouseCode,
          availableKg: warehouse.availableKg.toString(),
          reservedKg: warehouse.reservedKg.toString(),
          bags: warehouse.bags,
          lines: warehouse.lines.map((line) => ({
            batchId: line.batchId,
            batchNumber: line.batchNumber,
            lotNumber: line.lotNumber,
            containerNumber: line.containerNumber,
            availableKg: line.availableKg.toString(),
            reservedKg: line.reservedKg.toString(),
            bags: line.bags,
          })),
        }))}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Available" value={formatQuantityKg(availableKg)} tone={availableKg.greaterThan(0) ? 'positive' : 'default'} />
        <StatCard label="Received to date" value={formatQuantityKg(receivedKg)} />
        <StatCard label="Sold to date" value={formatQuantityKg(soldKg)} />
        {showCost ? (
          <StatCard label="Stock value" value={formatMoney(stockValueUsd, 'USD')} sublabel="At landed cost" />
        ) : (
          <StatCard label="Bag weight" value={`${item.bagWeightKg.toString()} KG`} />
        )}
      </div>

      <Tabs defaultValue="specification">
        <TabsList>
          <TabsTrigger value="specification">Specification</TabsTrigger>
          <TabsTrigger value="stock">
            Batches
            <TabCount value={batches.length} />
          </TabsTrigger>
          <TabsTrigger value="lots">
            Lots
            <TabCount value={item.lots.length} />
          </TabsTrigger>
          <TabsTrigger value="shipments">
            Shipments
            <TabCount value={item.shipments.length} />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="specification">
          <div className="grid gap-4 lg:grid-cols-2">
            {costing.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>What this coffee cost</CardTitle>
            <CardDescription>
              Each lot at its own landed cost — the supplier&rsquo;s price plus that container&rsquo;s share of the
              job&rsquo;s local charges. Stock and cost on one screen, so neither has to be looked up elsewhere.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <CostingTable rows={costing} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
              <CardHeader>
                <CardTitle>Origin and quality</CardTitle>
              </CardHeader>
              <CardContent>
                <dl>
                  <DetailRow label="Type">{COFFEE_TYPE_LABELS[item.coffeeType]}</DetailRow>
                  <DetailRow label="Origin country">{item.originCountry}</DetailRow>
                  <DetailRow label="Region">{item.region ?? '—'}</DetailRow>
                  <DetailRow label="Farm / estate">{item.farmEstate ?? '—'}</DetailRow>
                  <DetailRow label="Variety">{item.variety ?? '—'}</DetailRow>
                  <DetailRow label="Process">{COFFEE_PROCESS_LABELS[item.process]}</DetailRow>
                  <DetailRow label="Grade">{item.grade ?? '—'}</DetailRow>
                  <DetailRow label="Screen size">{item.screenSize ?? '—'}</DetailRow>
                  <DetailRow label="Crop year">{item.cropYear ?? '—'}</DetailRow>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Physical and packaging</CardTitle>
              </CardHeader>
              <CardContent>
                <dl>
                  <DetailRow label="Moisture">{item.moisturePct ? `${item.moisturePct.toString()}%` : '—'}</DetailRow>
                  <DetailRow label="Density">
                    {item.densityGPerL ? `${item.densityGPerL.toString()} g/L` : '—'}
                  </DetailRow>
                  <DetailRow label="Packaging">{PACKAGING_LABELS[item.packagingType]}</DetailRow>
                  <DetailRow label="Bag weight">{item.bagWeightKg.toString()} KG</DetailRow>
                  <DetailRow label="Default entry unit">{item.defaultUnit}</DetailRow>
                  <DetailRow label="Status">
                    <Badge tone={item.status === 'ACTIVE' ? 'success' : 'neutral'}>
                      {item.status === 'ACTIVE' ? 'Active' : 'Inactive'}
                    </Badge>
                  </DetailRow>
                </dl>
                {item.description || item.notes ? (
                  <p className="mt-4 rounded-lg bg-forest-50 p-3 text-xs leading-relaxed text-ink-muted">
                    {[item.description, item.notes].filter(Boolean).join('\n\n')}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="stock">
          {/*
            Warehouse first: pick where, see the total, then the containers
            and batches that make it up. The batch table below keeps the
            fuller picture, including batches still in transit.
          */}
          <div className="mb-6">
            <WarehouseStockPanel warehouses={warehouseBreakdown} />
          </div>

          {batches.length === 0 ? (
            <EmptyState title="No batches yet" description="Batches are created when a purchase contract is approved." />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Batch</TH>
                    <TH>Warehouse</TH>
                    <TH>Shipment</TH>
                    <TH numeric>Received</TH>
                    <TH numeric>Sold</TH>
                    <TH numeric>Reserved</TH>
                    <TH numeric>Available</TH>
                    {showCost ? <TH numeric>Cost / KG</TH> : null}
                    {showCost ? <TH numeric>Value</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {batches.map((batch) => (
                    <TR key={batch.batchId}>
                      <TD>
                        <Link
                          href={`/inventory/batches/${batch.batchId}`}
                          className="font-medium text-forest-800 hover:text-gold-700"
                        >
                          {batch.batchNumber}
                        </Link>
                      </TD>
                      <TD>{batch.warehouseNames || '—'}</TD>
                      <TD className="font-mono text-xs">{batch.lotNumber}</TD>
                      <TD numeric>{formatQuantityKg(batch.receivedKg)}</TD>
                      <TD numeric>{formatQuantityKg(batch.soldKg)}</TD>
                      <TD numeric>{formatQuantityKg(batch.allocatedKg)}</TD>
                      <TD numeric className="font-semibold">
                        {formatQuantityKg(batch.availableKg)}
                      </TD>
                      {showCost ? <TD numeric>{formatMoney(batch.unitCostUsd, 'USD')}</TD> : null}
                      {showCost ? <TD numeric>{formatMoney(batch.stockValueUsd, 'USD')}</TD> : null}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </TabsContent>

        <TabsContent value="lots">
          {item.lots.length === 0 ? (
            <EmptyState title="No lots yet" description="Lots are created from the lot numbers on purchase contracts." />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Lot</TH>
                    <TH>Origin</TH>
                    <TH>Crop year</TH>
                  </TR>
                </THead>
                <TBody>
                  {item.lots.map((lot) => (
                    <TR key={lot.id}>
                      <TD className="font-medium">{lot.lotNumber}</TD>
                      <TD>{lot.originCountry ?? '—'}</TD>
                      <TD>{lot.cropYear ?? '—'}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </TabsContent>

        <TabsContent value="shipments">
          {item.shipments.length === 0 ? (
            <EmptyState title="No shipments yet" description="Jobs carrying this coffee appear here." />
          ) : (
            <TableWrap>
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Shipment</TH>
                    <TH>Supplier</TH>
                    <TH numeric>Quantity</TH>
                    <TH>ETA</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {item.shipments.map((shipment) => (
                    <TR key={shipment.id}>
                      <TD>
                        <Link href={`/shipments/${shipment.id}`} className="font-medium text-forest-800 hover:text-gold-700">
                          {shipment.shipmentNumber}
                        </Link>
                      </TD>
                      <TD>{shipment.vendor.vendorName}</TD>
                      <TD numeric>{formatQuantityKg(shipment.quantityKg)}</TD>
                      <TD>{formatDate(shipment.etaDate)}</TD>
                      <TD>
                        <StatusBadge status={shipment.status} meta={SHIPMENT_STATUS_META} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
