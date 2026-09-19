import type { BadgeTone } from '@/lib/constants';
import { SHIPMENT_STATUSES_LANDED } from '@/lib/constants';

/**
 * The four stages a container goes through, in the client's words.
 *
 *   Pending loading → Loaded → Arrived → Received
 *
 * The shipment record holds finer statuses underneath (in transit, customs,
 * cleared, delivered); the reader of a purchase order or the loading sheet
 * wants to know which of these four it is at, and every screen should say
 * it the same way.
 */
export type ContainerStage = 'PENDING_LOADING' | 'LOADED' | 'ARRIVED' | 'RECEIVED';

export const CONTAINER_STAGE_META: Record<ContainerStage, { label: string; tone: BadgeTone }> = {
  PENDING_LOADING: { label: 'Pending loading', tone: 'neutral' },
  LOADED: { label: 'Loaded', tone: 'info' },
  ARRIVED: { label: 'Arrived', tone: 'progress' },
  RECEIVED: { label: 'Received', tone: 'success' },
};

const NOT_YET_LOADED = ['CONTRACT_CREATED', 'AWAITING_LOADING'];

export function containerStage(shipmentStatus: string, received: boolean): ContainerStage {
  if (received) return 'RECEIVED';
  if (SHIPMENT_STATUSES_LANDED.includes(shipmentStatus)) return 'ARRIVED';
  if (NOT_YET_LOADED.includes(shipmentStatus)) return 'PENDING_LOADING';
  return 'LOADED';
}
