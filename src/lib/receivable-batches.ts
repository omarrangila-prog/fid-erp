import type { ReceivableBatch } from '@/app/(app)/purchases/[id]/goods-receipt-dialog';

/** Landed, so the goods receipt is the next thing to do. */
export const LANDED_STATUSES = ['ARRIVED', 'CUSTOMS_CLEARING', 'CLEARED', 'DELIVERED'];

export type ReceivableSource = {
  status: string;
  shipmentOrdinal: number;
  containerNumbers: string[];
  lines: Array<{
    batchId: string;
    batchNumber: string;
    itemName: string;
    lotNumber: string;
    containerNumber: string | null;
    quantityKg: number;
    receivedKg: number;
    bagWeightKg: string;
    traceabilityPending: boolean;
  }>;
};

/**
 * What is still to be received on one shipment, as rows for the goods
 * receipt: one per container. Every container on the shipment is handed to a
 * line — its own where it has one, otherwise the line with the most coffee per
 * container so far — the same rule the purchase order uses, so the loading
 * sheet, Quick Update and the order all offer the same rows.
 */
export function receivableBatches(source: ReceivableSource): ReceivableBatch[] {
  type Line = ReceivableSource['lines'][number];
  const outstanding = (l: Line) => Math.max(0, l.quantityKg - l.receivedKg);
  const lines = source.lines.filter((line) => outstanding(line) > 0.001);

  const containersByBatch = new Map<string, string[]>(lines.map((line) => [line.batchId, []]));
  for (const containerNumber of source.containerNumbers) {
    const owner = lines.find((line) => line.containerNumber === containerNumber);
    const target =
      owner ??
      lines.reduce<Line | null>((best, line) => {
        const perContainer = (l: Line) => l.quantityKg / ((containersByBatch.get(l.batchId)?.length ?? 0) + 1);
        return !best || perContainer(line) > perContainer(best) ? line : best;
      }, null);
    if (target) containersByBatch.get(target.batchId)?.push(containerNumber);
  }

  return lines.map((line) => ({
    batchId: line.batchId,
    batchNumber: line.batchNumber,
    shipmentOrdinal: source.shipmentOrdinal,
    arrived: LANDED_STATUSES.includes(source.status),
    itemName: line.itemName,
    lotNumber: line.lotNumber,
    containerNumber: line.containerNumber,
    containerNumbers: containersByBatch.get(line.batchId) ?? [],
    orderedKg: String(line.quantityKg),
    receivedKg: String(line.receivedKg),
    outstandingKg: outstanding(line).toFixed(3),
    bagWeightKg: line.bagWeightKg,
    traceabilityPending: line.traceabilityPending,
  }));
}
