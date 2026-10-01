import { DOCUMENT_STATUS_META, type BadgeTone } from '@/lib/constants';
import type { ContainerStage } from '@/lib/container-stage';

/**
 * What an order's containers add up to, said the same way on every screen.
 *
 * The loading sheet, the purchase order list and the quick-update panel all
 * summarise the same containers: "2 / 3 Loaded", "1 / 3 Arrived", "0 / 3
 * Received", "2 Complete · 1 Pending", an ETA range. Each used to count for
 * itself; now they all count here, from the same shipment records.
 *
 * A shipment usually carries one container. An older one may carry several,
 * and then it counts as that many — three boxes landing are three arrivals.
 */
export type ContainerFacts = {
  stage: ContainerStage;
  /** Containers on this shipment; never fewer than one. */
  containers: number;
  documentStatus: string;
  /** `2026-10-12`, or null when nobody has set one. */
  etaIso: string | null;
  /** Some coffee received, not all of it. */
  partlyReceived?: boolean;
};

export type ArrivalState = 'NOT_ARRIVED' | 'PARTIALLY_ARRIVED' | 'FULLY_ARRIVED';
export type ReceiptState = 'NOT_RECEIVED' | 'PARTIALLY_RECEIVED' | 'FULLY_RECEIVED';

export const ARRIVAL_STATE_META: Record<ArrivalState, { label: string; tone: BadgeTone }> = {
  NOT_ARRIVED: { label: 'Not arrived', tone: 'neutral' },
  PARTIALLY_ARRIVED: { label: 'Partially arrived', tone: 'warning' },
  FULLY_ARRIVED: { label: 'Fully arrived', tone: 'success' },
};

export const RECEIPT_STATE_META: Record<ReceiptState, { label: string; tone: BadgeTone }> = {
  NOT_RECEIVED: { label: 'Not received', tone: 'neutral' },
  PARTIALLY_RECEIVED: { label: 'Partially received', tone: 'warning' },
  FULLY_RECEIVED: { label: 'Fully received', tone: 'success' },
};

export type ContainerSummary = {
  total: number;
  loaded: number;
  arrived: number;
  received: number;
  /** "2 / 3 Loaded" */
  loadingLabel: string;
  /** "1 / 3 Arrived" */
  arrivalLabel: string;
  arrivalState: ArrivalState;
  /** "0 / 3 Received" */
  receiptLabel: string;
  receiptState: ReceiptState;
  /** Each document position with how many containers are at it, most common first. */
  documents: Array<{ status: string; label: string; tone: BadgeTone; count: number }>;
  /** "2 Complete · 1 Pending", or the one label when every container shares it. */
  documentsLabel: string;
  /** "12 Oct 2026", "12–17 Oct 2026", or "—". */
  etaLabel: string;
  /** More than one ETA among the containers. */
  etaVaries: boolean;
};

const LOADED_STAGES: ContainerStage[] = ['LOADED', 'ARRIVED', 'RECEIVED'];
const ARRIVED_STAGES: ContainerStage[] = ['ARRIVED', 'RECEIVED'];

export function documentLabel(status: string): string {
  return DOCUMENT_STATUS_META[status]?.label ?? status.replaceAll('_', ' ').toLowerCase();
}

/** "22 Sept 2026" when every container shares it, "22–28 Sept 2026" when they differ. */
export function etaRange(isoDates: Array<string | null | undefined>): { label: string; varies: boolean } {
  const dates = [...new Set(isoDates.filter((d): d is string => Boolean(d)))].sort();
  if (dates.length === 0) return { label: '—', varies: false };
  const fmt = (iso: string, parts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...parts, timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  if (dates.length === 1) return { label: fmt(dates[0], { day: '2-digit', month: 'short', year: 'numeric' }), varies: false };
  const [first, last] = [dates[0], dates[dates.length - 1]];
  const sameMonth = first.slice(0, 7) === last.slice(0, 7);
  return {
    label: sameMonth
      ? `${fmt(first, { day: '2-digit' })}–${fmt(last, { day: '2-digit', month: 'short', year: 'numeric' })}`
      : `${fmt(first, { day: '2-digit', month: 'short' })} – ${fmt(last, { day: '2-digit', month: 'short', year: 'numeric' })}`,
    varies: true,
  };
}

export function summariseContainers(facts: ContainerFacts[]): ContainerSummary {
  const weight = (f: ContainerFacts) => Math.max(f.containers, 1);
  const total = facts.reduce((n, f) => n + weight(f), 0);
  const count = (pick: (f: ContainerFacts) => boolean) => facts.filter(pick).reduce((n, f) => n + weight(f), 0);
  const loaded = count((f) => LOADED_STAGES.includes(f.stage));
  const arrived = count((f) => ARRIVED_STAGES.includes(f.stage));
  const received = count((f) => f.stage === 'RECEIVED');
  const partly = count((f) => f.stage !== 'RECEIVED' && Boolean(f.partlyReceived));

  const byStatus = new Map<string, number>();
  for (const f of facts) byStatus.set(f.documentStatus, (byStatus.get(f.documentStatus) ?? 0) + weight(f));
  const documents = [...byStatus.entries()]
    .map(([status, n]) => ({
      status,
      label: documentLabel(status),
      tone: DOCUMENT_STATUS_META[status]?.tone ?? 'neutral',
      count: n,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const eta = etaRange(facts.map((f) => f.etaIso));

  return {
    total,
    loaded,
    arrived,
    received,
    loadingLabel: `${loaded} / ${total} Loaded`,
    arrivalLabel: `${arrived} / ${total} Arrived`,
    arrivalState: arrived === 0 ? 'NOT_ARRIVED' : arrived >= total ? 'FULLY_ARRIVED' : 'PARTIALLY_ARRIVED',
    receiptLabel: `${received} / ${total} Received`,
    receiptState: received >= total && total > 0 ? 'FULLY_RECEIVED' : received > 0 || partly > 0 ? 'PARTIALLY_RECEIVED' : 'NOT_RECEIVED',
    documents,
    documentsLabel: documents.length === 1 ? documents[0].label : documents.map((d) => `${d.count} ${d.label}`).join(' · '),
    etaLabel: eta.label,
    etaVaries: eta.varies,
  };
}
