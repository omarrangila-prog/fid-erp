import type { ShipmentDocumentStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { NotFoundError, BusinessRuleError } from '@/lib/errors';
import { getLoadingSheet, type LoadingSheetRow } from '@/lib/services/loading-sheet';
import {
  changeDocumentStatus,
  getEtaHistory,
  markShipmentArrived,
  markShipmentLoaded,
  updateShipmentEta,
} from '@/lib/services/shipment';

/**
 * Quick Update: the daily shipment operations, from the list.
 *
 * Loaded, ETA, documents, arrived and received are what the client changes
 * every day, container by container, and opening each shipment to do it was
 * the problem. This is the order's containers read once, and one change
 * applied to as many of them as were ticked.
 *
 * It holds no logic of its own. The containers are the loading sheet's rows
 * for the order; every change goes through the same service the shipment page
 * and the loading sheet's own dialogs use — markShipmentLoaded,
 * updateShipmentEta, changeDocumentStatus, markShipmentArrived — so each
 * container keeps its own history line, audit entry and rules, and every
 * screen reads the result from the one shipment record.
 */

export async function getOrderQuickUpdate(companyId: string, contractId: string) {
  const contract = await prisma.purchaseContract.findFirst({
    where: { id: contractId, companyId },
    select: { id: true, contractReference: true, contractNumber: true, status: true, vendor: { select: { vendorName: true } } },
  });
  if (!contract) throw new NotFoundError('Purchase order');

  const [rows, shippingLines, ports, warehouses] = await Promise.all([
    getLoadingSheet(companyId, { contractId }),
    prisma.shippingLine.findMany({ where: { companyId, status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.port.findMany({ where: { companyId, status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { name: true } }),
    prisma.warehouse.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, isDefault: true },
    }),
  ]);

  return {
    contract: {
      id: contract.id,
      reference: contract.contractReference,
      number: contract.contractNumber,
      supplier: contract.vendor.vendorName,
      approved: contract.status === 'POSTED',
    },
    containers: rows.sort((a, b) => a.shipmentOrdinal - b.shipmentOrdinal),
    shippingLines,
    ports: ports.map((p) => p.name),
    warehouses: warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code })),
    defaultWarehouseId: warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? null,
  };
}

export type QuickUpdateChange =
  | { op: 'eta'; etaDate: Date | null }
  | { op: 'documents'; toStatus: ShipmentDocumentStatus; notes?: string | null }
  | { op: 'arrived'; ataDate: Date }
  | {
      op: 'loaded';
      loadingDate: Date;
      etaDate?: Date | null;
      shippingLineId?: string | null;
      bookingNumber?: string | null;
      billOfLading?: string | null;
      portOfLoading?: string | null;
      portOfDischarge?: string | null;
      notes?: string | null;
    };

export type QuickUpdateResult = { shipmentId: string; ok: boolean; skipped?: boolean; message: string };

const NOT_YET_LOADED = ['CONTRACT_CREATED', 'AWAITING_LOADING'];
const LANDED = ['ARRIVED', 'CUSTOMS_CLEARING', 'CLEARED', 'DELIVERED', 'CLOSED'];

/**
 * One change to every ticked container on one order.
 *
 * Each container is its own transaction through its own service call, so one
 * that cannot take the change — not identified for loading, say — is reported
 * by name and the others still go through. A container already where the
 * change would put it is left alone and said to be.
 */
export async function applyQuickUpdate(params: {
  companyId: string;
  userId: string;
  contractId: string;
  shipmentIds: string[];
  change: QuickUpdateChange;
}): Promise<QuickUpdateResult[]> {
  const ids = [...new Set(params.shipmentIds)];
  if (ids.length === 0) throw new BusinessRuleError('Tick at least one container.');

  // Only this company's shipments, and only this order's: an id from anywhere
  // else is not found rather than quietly changed.
  const shipments = await prisma.shipment.findMany({
    where: { id: { in: ids }, companyId: params.companyId, purchaseContractId: params.contractId },
    select: {
      id: true,
      status: true,
      documentStatus: true,
      containerList: { select: { containerNumber: true } },
      batches: { where: { status: 'ACTIVE' }, select: { container: { select: { containerNumber: true } } } },
    },
  });
  if (shipments.length !== ids.length) throw new NotFoundError('Container');
  const byId = new Map(shipments.map((s) => [s.id, s]));

  const results: QuickUpdateResult[] = [];
  for (const shipmentId of ids) {
    const shipment = byId.get(shipmentId)!;
    const { change } = params;
    try {
      switch (change.op) {
        case 'eta': {
          await updateShipmentEta({ companyId: params.companyId, shipmentId, etaDate: change.etaDate }, params.userId);
          results.push({ shipmentId, ok: true, message: 'ETA updated.' });
          break;
        }
        case 'documents': {
          if (shipment.documentStatus === change.toStatus && !change.notes?.trim()) {
            results.push({ shipmentId, ok: true, skipped: true, message: 'Documents already at that status.' });
            break;
          }
          await changeDocumentStatus({
            shipmentId,
            companyId: params.companyId,
            userId: params.userId,
            toStatus: change.toStatus,
            notes: change.notes ?? null,
          });
          results.push({ shipmentId, ok: true, message: 'Documents updated.' });
          break;
        }
        case 'arrived': {
          if (LANDED.includes(shipment.status)) {
            results.push({ shipmentId, ok: true, skipped: true, message: 'Already arrived.' });
            break;
          }
          await markShipmentArrived({ companyId: params.companyId, shipmentId, userId: params.userId, ataDate: change.ataDate });
          results.push({ shipmentId, ok: true, message: 'Marked arrived.' });
          break;
        }
        case 'loaded': {
          if (!NOT_YET_LOADED.includes(shipment.status)) {
            results.push({ shipmentId, ok: true, skipped: true, message: 'Already loaded.' });
            break;
          }
          // The containers this shipment already names identify it on the water.
          const containerNumbers = [
            ...new Set(
              [
                ...shipment.containerList.map((c) => c.containerNumber),
                ...shipment.batches.map((b) => b.container?.containerNumber),
              ].filter((n): n is string => Boolean(n)),
            ),
          ];
          await markShipmentLoaded(
            {
              companyId: params.companyId,
              shipmentId,
              loadingDate: change.loadingDate,
              etaDate: change.etaDate ?? null,
              shippingLineId: change.shippingLineId ?? null,
              bookingNumber: change.bookingNumber ?? null,
              billOfLading: change.billOfLading ?? null,
              containerNumbers,
              portOfLoading: change.portOfLoading ?? null,
              portOfDischarge: change.portOfDischarge ?? null,
              notes: change.notes ?? null,
            },
            params.userId,
          );
          results.push({ shipmentId, ok: true, message: 'Marked loaded.' });
          break;
        }
      }
    } catch (error) {
      results.push({ shipmentId, ok: false, message: error instanceof Error ? error.message : 'This container could not be updated.' });
    }
  }
  return results;
}

export type ContainerHistoryEntry = {
  at: Date;
  by: string;
  what: 'Status' | 'Documents' | 'ETA' | 'Received';
  from: string | null;
  to: string | null;
  notes: string | null;
};

/**
 * Everything that happened to one container, newest first: loaded, arrived,
 * every ETA it has had, every document position and note, every receipt —
 * who did it and when. Read from the records each action already writes.
 */
export async function getContainerHistory(companyId: string, shipmentId: string): Promise<ContainerHistoryEntry[]> {
  const shipment = await prisma.shipment.findFirst({
    where: { id: shipmentId, companyId },
    select: {
      id: true,
      statusHistory: { orderBy: { changedAt: 'desc' }, take: 100, select: { changedAt: true, fromStatus: true, toStatus: true, notes: true, changedBy: { select: { name: true } } } },
      docStatusHistory: { orderBy: { changedAt: 'desc' }, take: 100, select: { changedAt: true, fromStatus: true, toStatus: true, notes: true, changedBy: { select: { name: true } } } },
      batches: { select: { id: true } },
    },
  });
  if (!shipment) throw new NotFoundError('Container');

  const [eta, receipts] = await Promise.all([
    getEtaHistory(companyId, shipmentId),
    prisma.goodsReceiptLine.findMany({
      where: { batchId: { in: shipment.batches.map((b) => b.id) }, goodsReceipt: { companyId, status: 'POSTED' } },
      select: {
        quantityKg: true,
        containerNumber: true,
        goodsReceipt: {
          select: { grnNumber: true, receiptDate: true, postedAt: true, createdAt: true, warehouse: { select: { name: true } }, receivedBy: { select: { name: true } } },
        },
      },
    }),
  ]);

  const entries: ContainerHistoryEntry[] = [
    ...shipment.statusHistory.map((h) => ({ at: h.changedAt, by: h.changedBy.name, what: 'Status' as const, from: h.fromStatus, to: h.toStatus, notes: h.notes })),
    ...shipment.docStatusHistory.map((h) => ({ at: h.changedAt, by: h.changedBy.name, what: 'Documents' as const, from: h.fromStatus, to: h.toStatus, notes: h.notes })),
    ...eta.map((h) => ({ at: h.changedAt, by: h.changedBy, what: 'ETA' as const, from: h.from, to: h.to, notes: null })),
    ...receipts.map((r) => ({
      at: r.goodsReceipt.postedAt ?? r.goodsReceipt.createdAt,
      by: r.goodsReceipt.receivedBy?.name ?? 'System',
      what: 'Received' as const,
      from: null,
      to: `${r.quantityKg.toString()} KG into ${r.goodsReceipt.warehouse?.name ?? 'stock'}`,
      notes: [r.goodsReceipt.grnNumber, r.containerNumber].filter(Boolean).join(' · ') || null,
    })),
  ];
  return entries.sort((a, b) => b.at.getTime() - a.at.getTime());
}

export type { LoadingSheetRow };
