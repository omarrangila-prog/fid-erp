import type { Tx } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';

/**
 * A shipment named on a document, checked to be this company's.
 *
 * Forms only offer the company's own shipments, but the server must not take
 * that on trust: a document carrying the other company's shipment would show
 * up in that shipment's costing and payments. Missing is "not found", never a
 * silent write.
 */
export async function ownShipmentId(tx: Tx, companyId: string, shipmentId: string | null | undefined): Promise<string | null> {
  if (!shipmentId) return null;
  const found = await tx.shipment.findFirst({ where: { id: shipmentId, companyId }, select: { id: true } });
  if (!found) throw new NotFoundError('Shipment');
  return found.id;
}
