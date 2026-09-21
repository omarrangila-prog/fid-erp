'use client';

import { formatBags } from '@/lib/bags';
import * as React from 'react';
import Link from 'next/link';
import { Warehouse as WarehouseIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type WarehouseLot = {
  batchId: string;
  batchNumber: string;
  containerNumber: string;
  reference: string;
  shipment: string;
  lotNumber: string;
  onHandLabel: string;
  availableLabel: string;
  availableKg: number;
  bags: number;
};

export type WarehouseStock = {
  warehouseId: string;
  warehouseName: string;
  totalLabel: string;
  totalKg: number;
  bags: number;
  lots: WarehouseLot[];
};

/**
 * Where this coffee is, one warehouse at a time.
 *
 * The same coffee arrives in several containers, each with its own batch, and
 * the question a trader actually asks is "how much of this do I have in
 * IPSEN, and in which batches". Answering it used to mean opening the item,
 * then each batch in turn.
 *
 * So the warehouse is chosen first and everything below follows from it: the
 * total in that warehouse in large type, then the containers and batches that
 * make it up. Switching warehouse is one click and the numbers change with
 * it.
 */
export function WarehouseStockPanel({ warehouses }: { warehouses: WarehouseStock[] }) {
  const [selectedId, setSelected] = React.useState(warehouses[0]?.warehouseId ?? '');
  const selected = warehouses.find((w) => w.warehouseId === selectedId) ?? warehouses[0];

  if (warehouses.length === 0) {
    return (
      <p className="rounded-xl border border-line bg-paper p-6 text-center text-sm text-ink-muted">
        None of this coffee is in a warehouse right now.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* Every warehouse holding this coffee, with its total, so the choice
          itself answers "where is it". */}
      <div className="flex flex-wrap gap-2">
        {warehouses.map((warehouse) => {
          const active = warehouse.warehouseId === selected?.warehouseId;
          return (
            <button
              key={warehouse.warehouseId}
              type="button"
              onClick={() => setSelected(warehouse.warehouseId)}
              aria-pressed={active}
              className={cn(
                'flex min-w-44 flex-col gap-0.5 rounded-xl border-2 p-3 text-left transition-colors',
                active
                  ? 'border-forest-500 bg-forest-50/60'
                  : 'border-line bg-surface hover:border-forest-300',
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
                <WarehouseIcon className="size-3.5" />
                {warehouse.warehouseName}
              </span>
              <span className="text-lg font-semibold tabular-nums text-ink">{warehouse.totalLabel}</span>
              <span className="text-[11px] text-ink-subtle">
                {warehouse.lots.length} {warehouse.lots.length === 1 ? 'batch' : 'batches'} ·{' '}
                {formatBags(warehouse.bags)} bags
              </span>
            </button>
          );
        })}
      </div>

      {selected ? (
        <div className="rounded-xl border border-line bg-surface">
          <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-muted">
                Total stock in {selected.warehouseName}
              </p>
              <p className="text-2xl font-semibold tabular-nums text-ink">{selected.totalLabel}</p>
            </div>
            <p className="text-xs text-ink-subtle">
              Across {selected.lots.length} {selected.lots.length === 1 ? 'batch' : 'batches'}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th className="px-4 py-2 font-medium">Container</th>
                  <th className="px-4 py-2 font-medium">Lot</th>
                  <th className="px-4 py-2 font-medium">Batch</th>
                  <th className="px-4 py-2 font-medium">Reference</th>
                  <th className="px-4 py-2 text-right font-medium">On hand</th>
                  <th className="px-4 py-2 text-right font-medium">Available</th>
                  <th className="px-4 py-2 text-right font-medium">Bags</th>
                </tr>
              </thead>
              <tbody>
                {selected.lots.map((lot) => (
                  <tr key={lot.batchId} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{lot.containerNumber}</td>
                    <td className="px-4 py-2 font-mono text-xs">{lot.lotNumber}</td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/inventory/batches/${lot.batchId}`}
                        className="font-medium text-forest-800 hover:text-gold-700"
                      >
                        {lot.batchNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-ink-muted">
                      {lot.reference}
                      <span className="block text-[11px] text-ink-subtle">{lot.shipment}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{lot.onHandLabel}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums text-forest-800">
                      {lot.availableLabel}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatBags(lot.bags)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
