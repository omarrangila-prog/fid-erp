'use client';

import { formatBags } from '@/lib/bags';
import * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { formatQuantityKg } from '@/lib/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type ItemWarehouseLineView = {
  batchId: string;
  batchNumber: string;
  lotNumber: string;
  containerNumber: string | null;
  availableKg: string;
  reservedKg: string;
  bags: number;
};

export type ItemWarehouseGroupView = {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  availableKg: string;
  reservedKg: string;
  bags: number;
  lines: ItemWarehouseLineView[];
};

/**
 * Live warehouse split for one coffee.
 *
 * Opening an item should answer "where is it?" before anything else. Each
 * warehouse total comes from inventory movements; expanding a row shows the
 * batch, lot and container that make that total up.
 */
export function ItemWarehouseStock({
  warehouses,
  totalAvailableKg,
}: {
  warehouses: ItemWarehouseGroupView[];
  totalAvailableKg: string;
}) {
  const expandable = warehouses.filter((warehouse) => warehouse.lines.length > 0);
  const [open, setOpen] = React.useState<Set<string>>(
    () => new Set(expandable.map((warehouse) => warehouse.warehouseId)),
  );

  function toggle(warehouseId: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(warehouseId)) next.delete(warehouseId);
      else next.add(warehouseId);
      return next;
    });
  }

  if (warehouses.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Stock by warehouse</CardTitle>
          <CardDescription>Physical stock in each warehouse, in KG.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-muted">
            No warehouses have been set up yet.{' '}
            <Link href="/warehouses" className="font-medium text-forest-800 hover:underline">
              Add a warehouse
            </Link>{' '}
            so receipts have somewhere to land.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stock by warehouse</CardTitle>
        <CardDescription>
          Physical stock in each warehouse. A sale reduces only the warehouse and batch on
          the invoice. A transfer moves quantity between warehouses; company total stays the same.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Warehouse</TH>
                <TH numeric>Available KG</TH>
              </TR>
            </THead>
            <TBody>
              {warehouses.map((warehouse) => {
                const canOpen = warehouse.lines.length > 0;
                const isOpen = canOpen && open.has(warehouse.warehouseId);
                const reserved = Number(warehouse.reservedKg);

                return (
                  <React.Fragment key={warehouse.warehouseId}>
                    <TR className={isOpen ? 'bg-forest-50/60' : undefined}>
                      <TD>
                        {canOpen ? (
                          <button
                            type="button"
                            onClick={() => toggle(warehouse.warehouseId)}
                            aria-expanded={isOpen}
                            className="flex max-w-full items-center gap-1.5 text-left font-medium text-ink"
                          >
                            <ChevronRight
                              className={cn(
                                'size-3.5 shrink-0 text-ink-subtle transition-transform',
                                isOpen && 'rotate-90',
                              )}
                              aria-hidden
                            />
                            <span className="min-w-0">
                              <span className="block truncate">{warehouse.warehouseName}</span>
                              {warehouse.bags > 0 || reserved > 0 ? (
                                <span className="block text-xs font-normal text-ink-subtle">
                                  {warehouse.bags > 0 ? `${formatBags(warehouse.bags)} bags` : null}
                                  {reserved > 0
                                    ? `${warehouse.bags > 0 ? ' · ' : ''}${formatQuantityKg(warehouse.reservedKg)} reserved`
                                    : ''}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        ) : (
                          <span className="block font-medium text-ink">{warehouse.warehouseName}</span>
                        )}
                      </TD>
                      <TD numeric className="font-semibold">
                        {formatQuantityKg(warehouse.availableKg)}
                      </TD>
                    </TR>
                    {isOpen
                      ? warehouse.lines.map((line) => (
                          <TR key={`${warehouse.warehouseId}-${line.batchId}`} className="bg-canvas">
                            <TD className="pl-9">
                              <Link
                                href={`/inventory/batches/${line.batchId}`}
                                className="font-medium text-forest-800 hover:text-gold-700"
                              >
                                {line.batchNumber}
                              </Link>
                              <span className="mt-0.5 block text-xs text-ink-subtle">
                                Lot {line.lotNumber}
                                {line.containerNumber ? ` · ${line.containerNumber}` : ''}
                                {Number(line.reservedKg) > 0
                                  ? ` · ${formatQuantityKg(line.reservedKg)} reserved`
                                  : ''}
                              </span>
                            </TD>
                            <TD numeric>{formatQuantityKg(line.availableKg)}</TD>
                          </TR>
                        ))
                      : null}
                  </React.Fragment>
                );
              })}
            </TBody>
            <TFoot>
              <TR className="hover:bg-transparent">
                <TD>Total available</TD>
                <TD numeric>{formatQuantityKg(totalAvailableKg)}</TD>
              </TR>
            </TFoot>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
