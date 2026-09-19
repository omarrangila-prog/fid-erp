import type { Tx } from '@/lib/db';
import { transaction, prisma } from '@/lib/db';
import { Decimal, dec, sum, toMoney, toQuantity } from '@/lib/money';
import {
  SHIPMENT_STATUS_TRANSITIONS,
  SHIPMENT_STATUS_REQUIREMENTS,
  SHIPMENT_STATUS_META,
  SHIPMENT_STATUSES_IN_TRANSIT,
  SHIPMENT_STATUSES_LANDED,
} from '@/lib/constants';
import { containerStage, type ContainerStage } from '@/lib/container-stage';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';
import type { ShipmentDocumentStatus, ShipmentStatus, SettlementStatus } from '@prisma/client';

/**
 * ShipmentService — loading follow-up, booking, ETA and document status.
 *
 * Physical status and document status are deliberately independent: a container
 * can be on the water while its originals are still with the supplier.
 */

/** Fields that may accompany a status change and are required by some targets. */
export type ShipmentStatusChangeInput = {
  shipmentId: string;
  companyId: string;
  userId: string;
  toStatus: ShipmentStatus;
  bookingNumber?: string | null;
  billOfLading?: string | null;
  vesselName?: string | null;
  voyageNumber?: string | null;
  portOfLoading?: string | null;
  portOfDischarge?: string | null;
  shippingLineId?: string | null;
  etdDate?: Date | null;
  etaDate?: Date | null;
  ataDate?: Date | null;
  loadingDate?: Date | null;
  clearanceDate?: Date | null;
  deliveryDate?: Date | null;
  containers?: number | null;
  notes?: string | null;
};

export function assertTransitionAllowed(from: ShipmentStatus, to: ShipmentStatus): void {
  if (from === to) {
    throw new BusinessRuleError('The shipment is already in that status.');
  }
  const allowed = SHIPMENT_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new BusinessRuleError(
      `A shipment cannot move directly from "${from.replaceAll('_', ' ')}" to "${to.replaceAll('_', ' ')}".`,
    );
  }
}

/**
 * Enforces the data a status implies. "Booked" without a booking number is not
 * a booking, so the transition is refused rather than silently accepted.
 */
export function assertStatusDataComplete(
  toStatus: ShipmentStatus,
  merged: Record<string, unknown>,
): void {
  const required = SHIPMENT_STATUS_REQUIREMENTS[toStatus] ?? [];
  const missing = required
    .filter(({ field }) => {
      const value = merged[field];
      if (value === null || value === undefined) return true;
      if (typeof value === 'string') return value.trim().length === 0;
      return false;
    })
    .map(({ label }) => label);

  if (missing.length > 0) {
    const label = SHIPMENT_STATUS_META[toStatus]?.label ?? toStatus.replaceAll('_', ' ');
    throw new BusinessRuleError(`Cannot set the shipment to "${label}" without: ${missing.join(', ')}.`);
  }
}

export async function changeShipmentStatus(input: ShipmentStatusChangeInput) {
  return transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, companyId: input.companyId },
    });
    if (!shipment) throw new NotFoundError('Shipment');

    assertTransitionAllowed(shipment.status, input.toStatus);

    const merged = {
      bookingNumber: input.bookingNumber ?? shipment.bookingNumber,
      billOfLading: input.billOfLading ?? shipment.billOfLading,
      vesselName: input.vesselName ?? shipment.vesselName,
      voyageNumber: input.voyageNumber ?? shipment.voyageNumber,
      portOfLoading: input.portOfLoading ?? shipment.portOfLoading,
      portOfDischarge: input.portOfDischarge ?? shipment.portOfDischarge,
      shippingLineId: input.shippingLineId ?? shipment.shippingLineId,
      etdDate: input.etdDate ?? shipment.etdDate,
      etaDate: input.etaDate ?? shipment.etaDate,
      ataDate: input.ataDate ?? shipment.ataDate,
      loadingDate: input.loadingDate ?? shipment.loadingDate,
      clearanceDate: input.clearanceDate ?? shipment.clearanceDate,
      deliveryDate: input.deliveryDate ?? shipment.deliveryDate,
    };

    assertStatusDataComplete(input.toStatus, merged);

    if (input.shippingLineId) {
      const line = await tx.shippingLine.findFirst({
        where: { id: input.shippingLineId, companyId: input.companyId },
        select: { id: true },
      });
      if (!line) throw new NotFoundError('Shipping line');
    }

    const updated = await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        status: input.toStatus,
        bookingNumber: merged.bookingNumber,
        billOfLading: merged.billOfLading,
        vesselName: merged.vesselName,
        voyageNumber: merged.voyageNumber,
        portOfLoading: merged.portOfLoading,
        portOfDischarge: merged.portOfDischarge,
        shippingLineId: merged.shippingLineId,
        etdDate: merged.etdDate,
        etaDate: merged.etaDate,
        ataDate: merged.ataDate,
        loadingDate: merged.loadingDate,
        clearanceDate: merged.clearanceDate,
        deliveryDate: merged.deliveryDate,
        containers: input.containers ?? shipment.containers,
        updatedById: input.userId,
      },
    });

    await tx.shipmentStatusHistory.create({
      data: {
        shipmentId: shipment.id,
        fromStatus: shipment.status,
        toStatus: input.toStatus,
        changedById: input.userId,
        notes: input.notes ?? null,
      },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'SHIPMENT_STATUS_CHANGED',
      entityType: 'Shipment',
      entityId: shipment.id,
      before: { status: shipment.status },
      after: {
        status: input.toStatus,
        bookingNumber: merged.bookingNumber,
        etaDate: merged.etaDate,
      },
    });

    return updated;
  });
}

export async function changeDocumentStatus(input: {
  shipmentId: string;
  companyId: string;
  userId: string;
  toStatus: ShipmentDocumentStatus;
  notes?: string | null;
}) {
  return transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, companyId: input.companyId },
    });
    if (!shipment) throw new NotFoundError('Shipment');
    if (shipment.documentStatus === input.toStatus) {
      throw new BusinessRuleError('The documents are already in that status.');
    }

    const updated = await tx.shipment.update({
      where: { id: shipment.id },
      data: { documentStatus: input.toStatus, updatedById: input.userId },
    });

    await tx.shipmentDocumentStatusHistory.create({
      data: {
        shipmentId: shipment.id,
        fromStatus: shipment.documentStatus,
        toStatus: input.toStatus,
        changedById: input.userId,
        notes: input.notes ?? null,
      },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'SHIPMENT_DOCUMENT_STATUS_CHANGED',
      entityType: 'Shipment',
      entityId: shipment.id,
      before: { documentStatus: shipment.documentStatus },
      after: { documentStatus: input.toStatus },
    });

    return updated;
  });
}

/** Editable logistics detail that does not move the workflow forward. */
export async function updateShipmentDetails(input: {
  shipmentId: string;
  companyId: string;
  userId: string;
  customerId?: string | null;
  bookingNumber?: string | null;
  billOfLading?: string | null;
  vesselName?: string | null;
  voyageNumber?: string | null;
  portOfLoading?: string | null;
  portOfDischarge?: string | null;
  shippingLineId?: string | null;
  etdDate?: Date | null;
  etaDate?: Date | null;
  loadingDate?: Date | null;
  destination?: string | null;
  containers?: number | null;
  notes?: string | null;
}) {
  return transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, companyId: input.companyId },
    });
    if (!shipment) throw new NotFoundError('Shipment');

    if (input.customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, companyId: input.companyId },
        select: { id: true },
      });
      if (!customer) throw new NotFoundError('Customer');
    }

    const updated = await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        customerId: input.customerId === undefined ? shipment.customerId : input.customerId,
        bookingNumber: input.bookingNumber === undefined ? shipment.bookingNumber : input.bookingNumber,
        billOfLading: input.billOfLading === undefined ? shipment.billOfLading : input.billOfLading,
        vesselName: input.vesselName === undefined ? shipment.vesselName : input.vesselName,
        voyageNumber: input.voyageNumber === undefined ? shipment.voyageNumber : input.voyageNumber,
        portOfLoading: input.portOfLoading === undefined ? shipment.portOfLoading : input.portOfLoading,
        portOfDischarge: input.portOfDischarge === undefined ? shipment.portOfDischarge : input.portOfDischarge,
        shippingLineId: input.shippingLineId === undefined ? shipment.shippingLineId : input.shippingLineId,
        etdDate: input.etdDate === undefined ? shipment.etdDate : input.etdDate,
        etaDate: input.etaDate === undefined ? shipment.etaDate : input.etaDate,
        loadingDate: input.loadingDate === undefined ? shipment.loadingDate : input.loadingDate,
        destination: input.destination === undefined ? shipment.destination : input.destination,
        containers: input.containers ?? shipment.containers,
        notes: input.notes === undefined ? shipment.notes : input.notes,
        updatedById: input.userId,
      },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'SHIPMENT_UPDATED',
      entityType: 'Shipment',
      entityId: shipment.id,
      before: {
        customerId: shipment.customerId,
        bookingNumber: shipment.bookingNumber,
        etaDate: shipment.etaDate,
      },
      after: { customerId: updated.customerId, bookingNumber: updated.bookingNumber, etaDate: updated.etaDate },
    });

    return updated;
  });
}

/**
 * Derived payment status for a shipment: invoiced value versus receipts
 * allocated to those invoices, both in USD. A manual override is honoured but
 * recorded, so nobody can quietly mark an unpaid shipment as paid.
 */
export type ShipmentSettlement = {
  invoicedUsd: Decimal;
  receivedUsd: Decimal;
  outstandingUsd: Decimal;
  status: SettlementStatus;
  isOverridden: boolean;
};

export async function getShipmentSettlement(
  client: Tx | typeof prisma,
  companyId: string,
  shipmentId: string,
): Promise<ShipmentSettlement> {
  const rows = await client.$queryRaw<Array<{ invoiced: string | null; received: string | null }>>`
    SELECT
      COALESCE((
        SELECT SUM(si."subtotalUsd") FROM sales_invoices si
        WHERE si."companyId" = ${companyId} AND si."shipmentId" = ${shipmentId} AND si."status" = 'POSTED'
      ), 0)::text AS invoiced,
      COALESCE((
        SELECT SUM(ra."amountUsd")
        FROM receipt_allocations ra
        JOIN receipts r ON r."id" = ra."receiptId"
        JOIN sales_invoices si2 ON si2."id" = ra."salesInvoiceId"
        WHERE r."companyId" = ${companyId} AND r."status" = 'POSTED'
          AND si2."shipmentId" = ${shipmentId} AND si2."status" = 'POSTED'
      ), 0)::text AS received
  `;

  const invoicedUsd = toMoney(dec(rows[0]?.invoiced ?? 0));
  const receivedUsd = toMoney(dec(rows[0]?.received ?? 0));
  const outstandingUsd = toMoney(invoicedUsd.minus(receivedUsd));

  const shipment = await client.shipment.findFirst({
    where: { id: shipmentId, companyId },
    select: { paymentStatusOverride: true },
  });

  let status: SettlementStatus;
  if (invoicedUsd.isZero()) status = 'UNPAID';
  else if (outstandingUsd.lessThanOrEqualTo(0)) status = 'PAID';
  else if (receivedUsd.greaterThan(0)) status = 'PARTIAL';
  else status = 'UNPAID';

  return {
    invoicedUsd,
    receivedUsd,
    outstandingUsd,
    status: shipment?.paymentStatusOverride ?? status,
    isOverridden: Boolean(shipment?.paymentStatusOverride),
  };
}

export async function overrideShipmentPaymentStatus(input: {
  shipmentId: string;
  companyId: string;
  userId: string;
  status: SettlementStatus | null;
  reason: string;
}) {
  return transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, companyId: input.companyId },
    });
    if (!shipment) throw new NotFoundError('Shipment');
    if (input.status && !input.reason.trim()) {
      throw new BusinessRuleError('A reason is required when overriding the calculated payment status.');
    }

    const updated = await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        paymentStatusOverride: input.status,
        overrideReason: input.status ? input.reason : null,
        updatedById: input.userId,
      },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'SHIPMENT_PAYMENT_STATUS_OVERRIDDEN',
      entityType: 'Shipment',
      entityId: shipment.id,
      before: { override: shipment.paymentStatusOverride },
      after: { override: input.status, reason: input.reason },
    });

    return updated;
  });
}

/**
 * Mark a consignment loaded, and record what makes it loaded.
 *
 * The client's §7. Until this point the contract is a commitment: a quantity,
 * a price and a supplier. None of the shipping information exists yet, which
 * is why the purchase order no longer asks for it. When the supplier actually
 * loads, all of it arrives at once — the date, the vessel's arrival, the line
 * carrying it, the booking and the bill of lading — and this is the single
 * action that takes it.
 *
 * It refuses to move the status without the arrival date, the shipping line,
 * and an identification of the consignment — a booking or B/L number, or the
 * container numbers. A consignment marked loaded that cannot say when it
 * arrives, who is carrying it or which boxes are on the water tells the person
 * reading the loading sheet nothing, and a status that means nothing is worse
 * than no status: it stops them asking.
 *
 * Everything here also reaches the loading sheet, which reads it from the
 * shipment rather than holding a copy.
 */
export async function markShipmentLoaded(
  input: {
    companyId: string;
    shipmentId: string;
    loadingDate: Date;
    etaDate: Date | null;
    shippingLineId?: string | null;
    bookingNumber?: string | null;
    billOfLading?: string | null;
    /**
     * Every container on the consignment.
     *
     * One booking usually covers several, and the client asked to be able to
     * say "three containers" and then enter three numbers. They are recorded
     * against the shipment and attached to the batches that have none of their
     * own, so the loading sheet shows what actually shipped.
     */
    containerNumbers?: string[];
    vesselName?: string | null;
    voyageNumber?: string | null;
    portOfLoading?: string | null;
    portOfDischarge?: string | null;
    notes?: string | null;
  },
  userId: string,
) {
  return transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, companyId: input.companyId },
      include: { shippingLine: { select: { id: true } } },
    });
    if (!shipment) throw new NotFoundError('Shipment');

    if (shipment.status === 'LOADED') {
      throw new BusinessRuleError('This consignment is already marked loaded.');
    }
    if (!SHIPMENT_STATUSES_IN_TRANSIT.includes(shipment.status)) {
      throw new BusinessRuleError(
        `This consignment is already ${shipment.status.replaceAll('_', ' ').toLowerCase()} and cannot be marked loaded.`,
      );
    }

    const shippingLineId = input.shippingLineId ?? shipment.shippingLineId;
    const etaDate = input.etaDate ?? shipment.etaDate;

    const missing: string[] = [];
    if (!etaDate) missing.push('the estimated arrival date');
    if (!shippingLineId) missing.push('the shipping line');
    if (missing.length > 0) {
      throw new BusinessRuleError(
        `Before this can be marked loaded it needs ${missing.join(' and ')}. ` +
          'Without it the loading sheet cannot tell anyone when the coffee lands or who is carrying it.',
      );
    }

    const bookingNumber = (input.bookingNumber ?? shipment.bookingNumber ?? '').trim();
    const billOfLading = (input.billOfLading ?? shipment.billOfLading ?? '').trim();
    const containerNumbers = [
      ...new Set((input.containerNumbers ?? []).map((n) => n.trim()).filter(Boolean)),
    ];
    if (!bookingNumber && !billOfLading && containerNumbers.length === 0) {
      throw new BusinessRuleError(
        'Before this can be marked loaded it needs a booking or B/L number, or the container numbers. ' +
          'Those are how the consignment is identified on the water.',
      );
    }

    if (input.shippingLineId) {
      const line = await tx.shippingLine.findFirst({
        where: { id: input.shippingLineId, companyId: input.companyId },
        select: { id: true },
      });
      if (!line) throw new NotFoundError('Shipping line');
    }

    /*
     * The containers on the consignment.
     *
     * One booking covers several, so this takes a list. Each becomes a
     * container record against the shipment. Unassigned batches are then
     * paired one-to-one with those records — container 1 to the first batch,
     * container 2 to the second — rather than pinning every batch to the
     * first number, which made two physical containers appear as the same
     * box on the loading sheet.
     *
     * Duplicates within the list are ignored rather than refused: somebody
     * asked for three fields and typed the same number twice is a slip, not a
     * reason to lose the other two.
     */
    if (containerNumbers.length > 0) {
      const ids: string[] = [];

      for (const containerNumber of containerNumbers) {
        ids.push(
          await upsertContainerOnShipment(tx, {
            companyId: input.companyId,
            shipmentId: shipment.id,
            purchaseContractId: shipment.purchaseContractId,
            containerNumber,
          }),
        );
      }

      const unassigned = await tx.batch.findMany({
        where: { shipmentId: shipment.id, containerId: null, status: 'ACTIVE' },
        orderBy: [{ createdAt: 'asc' }, { batchNumber: 'asc' }],
        select: { id: true },
      });

      for (let i = 0; i < unassigned.length; i++) {
        const containerId = ids[i];
        if (!containerId) break;
        await tx.batch.update({ where: { id: unassigned[i].id }, data: { containerId } });
      }

      await tx.shipment.update({
        where: { id: shipment.id },
        data: { containers: Math.max(shipment.containers, containerNumbers.length) },
      });
    }

    const updated = await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        status: 'LOADED',
        loadingDate: input.loadingDate,
        etaDate,
        shippingLineId,
        bookingNumber: input.bookingNumber?.trim() || shipment.bookingNumber,
        billOfLading: input.billOfLading?.trim() || shipment.billOfLading,
        vesselName: input.vesselName?.trim() || shipment.vesselName,
        voyageNumber: input.voyageNumber?.trim() || shipment.voyageNumber,
        portOfLoading: input.portOfLoading?.trim() || shipment.portOfLoading,
        portOfDischarge: input.portOfDischarge?.trim() || shipment.portOfDischarge,
        notes: input.notes?.trim() || shipment.notes,
        updatedById: userId,
      },
    });

    await tx.shipmentStatusHistory.create({
      data: {
        shipmentId: shipment.id,
        fromStatus: shipment.status,
        toStatus: 'LOADED',
        changedById: userId,
        notes: `Loaded ${input.loadingDate.toISOString().slice(0, 10)}${
          input.billOfLading ? ` under B/L ${input.billOfLading}` : ''
        }.`,
      },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'SHIPMENT_LOADED',
      entityType: 'Shipment',
      entityId: shipment.id,
      before: { status: shipment.status, etaDate: shipment.etaDate, billOfLading: shipment.billOfLading },
      after: { status: updated.status, etaDate: updated.etaDate, billOfLading: updated.billOfLading },
    });

    return updated;
  });
}


/**
 * Change the expected arrival date, as often as the line changes it.
 *
 * A shipping line moves an ETA every few days, and staff walk the live
 * consignments updating them — fifteen or twenty at a sitting. There is no
 * limit, no approval and no status attached: it is a date somebody was told,
 * and the only interesting thing about it is what it says now.
 *
 * Every change is written to the audit trail with the date it replaced, so the
 * history is there for anyone who wants to see how a shipment slipped.
 */
export async function updateShipmentEta(
  params: { companyId: string; shipmentId: string; etaDate: Date | null },
  userId: string,
) {
  return transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({
      where: { id: params.shipmentId, companyId: params.companyId },
      select: { id: true, shipmentNumber: true, etaDate: true },
    });
    if (!shipment) throw new NotFoundError('Shipment');

    const updated = await tx.shipment.update({
      where: { id: shipment.id },
      data: { etaDate: params.etaDate, updatedById: userId },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId,
      action: 'SHIPMENT_ETA_CHANGED',
      entityType: 'Shipment',
      entityId: shipment.id,
      before: { etaDate: shipment.etaDate },
      after: { etaDate: updated.etaDate, shipmentNumber: shipment.shipmentNumber },
    });

    return updated;
  });
}

/** Every ETA this shipment has had, newest first, from the audit trail. */
export async function getEtaHistory(companyId: string, shipmentId: string) {
  const rows = await prisma.auditLog.findMany({
    where: { companyId, entityType: 'Shipment', entityId: shipmentId, action: 'SHIPMENT_ETA_CHANGED' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { createdAt: true, before: true, after: true, user: { select: { name: true } } },
  });

  return rows.map((row) => ({
    changedAt: row.createdAt,
    changedBy: row.user?.name ?? 'System',
    from: (row.before as { etaDate?: string | null } | null)?.etaDate ?? null,
    to: (row.after as { etaDate?: string | null } | null)?.etaDate ?? null,
  }));
}

/**
 * Find or create a container number on this shipment.
 *
 * Container numbers are unique per company, so a number already on the books
 * is reused and pointed at this consignment rather than refused.
 */
async function upsertContainerOnShipment(
  tx: Tx,
  params: {
    companyId: string;
    shipmentId: string;
    purchaseContractId: string;
    containerNumber: string;
  },
): Promise<string> {
  const containerNumber = params.containerNumber.trim();
  const existing = await tx.container.findFirst({
    where: { companyId: params.companyId, containerNumber },
    select: { id: true },
  });

  if (existing) {
    await tx.container.update({
      where: { id: existing.id },
      data: { shipmentId: params.shipmentId, purchaseContractId: params.purchaseContractId },
    });
    return existing.id;
  }

  const created = await tx.container.create({
    data: {
      companyId: params.companyId,
      containerNumber,
      shipmentId: params.shipmentId,
      purchaseContractId: params.purchaseContractId,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Corrects the earlier loading-sheet bug: every unassigned batch was pointed
 * at the first container, so two real boxes showed the same number.
 *
 * Safe: it only rewrites `batch.containerId` when several container records
 * exist on the shipment and every batch currently shares a single one. Nothing
 * is deleted.
 */
export async function repairSharedContainerAssignments(
  tx: Tx,
  companyId: string,
  shipmentId?: string,
): Promise<void> {
  const shipments = await tx.shipment.findMany({
    where: { companyId, ...(shipmentId ? { id: shipmentId } : {}) },
    select: {
      id: true,
      containerList: { orderBy: { createdAt: 'asc' }, select: { id: true } },
      batches: {
        where: { status: 'ACTIVE' },
        orderBy: [{ createdAt: 'asc' }, { batchNumber: 'asc' }],
        select: { id: true, containerId: true },
      },
    },
  });

  for (const shipment of shipments) {
    if (shipment.containerList.length < 2 || shipment.batches.length < 2) continue;
    const assigned = [
      ...new Set(shipment.batches.map((batch) => batch.containerId).filter((id): id is string => Boolean(id))),
    ];
    if (assigned.length !== 1) continue;

    for (let i = 0; i < shipment.batches.length; i++) {
      const target = shipment.containerList[i] ?? shipment.containerList[shipment.containerList.length - 1];
      if (shipment.batches[i].containerId === target.id) continue;
      await tx.batch.update({ where: { id: shipment.batches[i].id }, data: { containerId: target.id } });
    }
  }
}

/**
 * Edit each batch's container number independently, without recreating the PO.
 */
export async function saveShipmentContainers(
  input: {
    companyId: string;
    shipmentId: string;
    lines: Array<{ batchId: string; containerNumber?: string | null }>;
  },
  userId: string,
) {
  return transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, companyId: input.companyId },
      include: { batches: { where: { status: 'ACTIVE' }, select: { id: true } } },
    });
    if (!shipment) throw new NotFoundError('Shipment');

    const allowed = new Set(shipment.batches.map((batch) => batch.id));

    for (const line of input.lines) {
      if (!allowed.has(line.batchId)) {
        throw new BusinessRuleError('That coffee line does not belong to this shipment.');
      }

      const number = line.containerNumber?.trim() || '';
      if (!number) {
        await tx.batch.update({ where: { id: line.batchId }, data: { containerId: null } });
        continue;
      }

      const containerId = await upsertContainerOnShipment(tx, {
        companyId: input.companyId,
        shipmentId: shipment.id,
        purchaseContractId: shipment.purchaseContractId,
        containerNumber: number,
      });
      await tx.batch.update({ where: { id: line.batchId }, data: { containerId } });
    }

    const count = await tx.container.count({ where: { shipmentId: shipment.id } });
    await tx.shipment.update({
      where: { id: shipment.id },
      data: { containers: Math.max(shipment.containers, count, input.lines.filter((l) => l.containerNumber?.trim()).length), updatedById: userId },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'SHIPMENT_CONTAINERS_UPDATED',
      entityType: 'Shipment',
      entityId: shipment.id,
      after: { lines: input.lines },
    });

    return shipment;
  });
}

// ---------------------------------------------------------------------------
// A purchase order as the parent of its shipments
// ---------------------------------------------------------------------------

export type OrderArrival = 'NOT_ARRIVED' | 'PARTIALLY_ARRIVED' | 'FULLY_ARRIVED';
export type OrderReceipt = 'NOT_RECEIVED' | 'PARTIALLY_RECEIVED' | 'FULLY_RECEIVED';

export type OrderShipmentLine = {
  shipmentId: string;
  /** "Shipment 1", by position on the order — the way the client refers to it. */
  ordinal: number;
  /**
   * One row per batch. A shipment opened under the current rule carries one;
   * an older job may carry several — two coffees in three containers on one
   * shipment — and each still gets its own row, so nothing on the order is
   * hidden behind the first.
   */
  batchOrdinal: number;
  batchesOnShipment: number;
  status: string;
  /** Pending loading → Loaded → Arrived → Received, for this container. */
  stage: ContainerStage;
  arrived: boolean;
  itemName: string;
  containerNumber: string | null;
  lotNumber: string | null;
  batchNumber: string | null;
  batchId: string | null;
  warehouseName: string | null;
  orderedKg: Decimal;
  receivedKg: Decimal;
  availableKg: Decimal;
  purchaseUsd: Decimal;
  etaDate: Date | null;
  ataDate: Date | null;
  received: boolean;
};

export type OrderOverview = {
  contractId: string;
  reference: string;
  shipments: OrderShipmentLine[];
  totalShipments: number;
  arrivedCount: number;
  receivedCount: number;
  /**
   * Container-wise, which is how the client counts: "3 of 5 containers
   * arrived". One container arriving never counts the others.
   */
  containerCount: number;
  arrivedContainers: number;
  receivedContainers: number;
  totalKg: Decimal;
  receivedKg: Decimal;
  remainingKg: Decimal;
  totalPurchaseUsd: Decimal;
  arrival: OrderArrival;
  receipt: OrderReceipt;
};

/**
 * One order, every shipment under it, and what that adds up to.
 *
 * A contract routinely covers three containers that arrive on three days.
 * The order is "fully arrived" only when the last of them lands, and it says
 * "2 of 3 arrived" until then — the mistake this guards against is the whole
 * order reading arrived as soon as the first container does.
 *
 * Every total here is a sum over the lines, never a figure repeated per line:
 * three containers of 20,000 KG are 60,000 KG, not 180,000.
 */
export async function getOrderOverview(companyId: string, contractId: string): Promise<OrderOverview> {
  const contract = await prisma.purchaseContract.findFirstOrThrow({
    where: { id: contractId, companyId },
    select: {
      id: true,
      contractReference: true,
      shipments: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          etaDate: true,
          ataDate: true,
          item: { select: { itemName: true } },
          containers: true,
          containerList: { select: { containerNumber: true } },
          batches: {
            where: { status: 'ACTIVE' },
            orderBy: [{ createdAt: 'asc' }, { batchNumber: 'asc' }],
            select: {
              id: true,
              batchNumber: true,
              orderedQuantityKg: true,
              receivedQuantityKg: true,
              availableQuantityKg: true,
              purchaseCostUsd: true,
              item: { select: { itemName: true } },
              lot: { select: { lotNumber: true } },
              container: { select: { containerNumber: true } },
              warehouse: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const shipments: OrderShipmentLine[] = contract.shipments.flatMap((shipment, index) => {
    const arrived = SHIPMENT_STATUSES_LANDED.includes(shipment.status);
    // A shipment with no batch yet still exists: it is a row with nothing in it.
    const batches = shipment.batches.length > 0 ? shipment.batches : [null];

    return batches.map((batch, batchIndex) => {
      const orderedKg = toQuantity(batch ? dec(batch.orderedQuantityKg) : dec(0));
      const receivedKg = toQuantity(batch ? dec(batch.receivedQuantityKg) : dec(0));
      const received = orderedKg.greaterThan(0) && receivedKg.greaterThanOrEqualTo(orderedKg);
      return {
        shipmentId: shipment.id,
        ordinal: index + 1,
        batchOrdinal: batchIndex + 1,
        batchesOnShipment: batches.length,
        status: shipment.status,
        stage: containerStage(shipment.status, received),
        arrived,
        itemName: batch?.item.itemName ?? shipment.item.itemName,
        containerNumber: batch?.container?.containerNumber ?? null,
        lotNumber: batch?.lot?.lotNumber ?? null,
        batchNumber: batch?.batchNumber ?? null,
        batchId: batch?.id ?? null,
        warehouseName: batch?.warehouse?.name ?? null,
        orderedKg,
        receivedKg,
        availableKg: toQuantity(batch ? dec(batch.availableQuantityKg) : dec(0)),
        purchaseUsd: toMoney(batch ? dec(batch.purchaseCostUsd) : dec(0)),
        etaDate: shipment.etaDate,
        ataDate: shipment.ataDate,
        received,
      };
    });
  });

  // Counts are of shipments, not rows: a shipment carrying two batches is
  // one shipment, arrived once, and received only when both batches are.
  const shipmentIds = [...new Set(shipments.map((s) => s.shipmentId))];
  const arrivedCount = shipmentIds.filter((id) => shipments.some((s) => s.shipmentId === id && s.arrived)).length;
  const receivedCount = shipmentIds.filter((id) => shipments.filter((s) => s.shipmentId === id).every((s) => s.received)).length;
  const totalKg = toQuantity(sum(shipments.map((s) => s.orderedKg)));
  const receivedKg = toQuantity(sum(shipments.map((s) => s.receivedKg)));

  // Containers per shipment: the numbered ones on its list, the ones its
  // batches sit in, or the count declared on the order — whichever knows most.
  // A job whose three containers were declared but not yet numbered is still
  // three containers.
  const containersOn = (shipment: (typeof contract.shipments)[number]) => {
    const listed = shipment.containerList.length;
    const onBatches = new Set(shipment.batches.map((b) => b.container?.containerNumber).filter(Boolean)).size;
    return Math.max(listed, onBatches, shipment.containers, 1);
  };
  const containerCount = contract.shipments.reduce((count, shipment) => count + containersOn(shipment), 0);
  const arrivedContainers = contract.shipments
    .filter((shipment) => SHIPMENT_STATUSES_LANDED.includes(shipment.status))
    .reduce((count, shipment) => count + containersOn(shipment), 0);
  const receivedContainers = contract.shipments
    .filter((shipment) => shipments.filter((s) => s.shipmentId === shipment.id).every((s) => s.received))
    .reduce((count, shipment) => count + containersOn(shipment), 0);

  const verdict = <T extends string>(count: number, none: T, some: T, all: T): T =>
    shipmentIds.length === 0 || count === 0 ? none : count === shipmentIds.length ? all : some;

  return {
    contractId: contract.id,
    reference: contract.contractReference,
    shipments,
    totalShipments: shipmentIds.length,
    arrivedCount,
    receivedCount,
    containerCount,
    arrivedContainers,
    receivedContainers,
    totalKg,
    receivedKg,
    remainingKg: toQuantity(totalKg.minus(receivedKg)),
    totalPurchaseUsd: toMoney(sum(shipments.map((s) => s.purchaseUsd))),
    arrival: verdict(arrivedCount, 'NOT_ARRIVED', 'PARTIALLY_ARRIVED', 'FULLY_ARRIVED'),
    receipt: verdict(receivedCount, 'NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'),
  };
}

/**
 * Every shipment on the order arrived together.
 *
 * Each one is moved through the same status change the sheet uses, one at a
 * time inside one transaction — so either all of them arrive or none do, and
 * every one keeps its own history line. Shipments already arrived are left
 * alone rather than refused, because "mark all arrived" on an order where two
 * of three already are is a reasonable thing to click.
 */
export async function markOrderArrived(input: {
  companyId: string;
  contractId: string;
  userId: string;
  ataDate: Date;
}) {
  return transaction(async (tx) => {
    const shipments = await tx.shipment.findMany({
      where: { purchaseContractId: input.contractId, companyId: input.companyId },
      select: { id: true, status: true, shipmentNumber: true },
      orderBy: { createdAt: 'asc' },
    });
    if (shipments.length === 0) throw new NotFoundError('Shipments on this order');

    const moved: string[] = [];
    for (const shipment of shipments) {
      if (SHIPMENT_STATUSES_LANDED.includes(shipment.status)) continue;
      await arriveShipmentIn(tx, shipment, input.ataDate, input.userId, 'Marked arrived with the rest of the order');
      moved.push(shipment.shipmentNumber);
    }

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'ORDER_MARKED_ARRIVED',
      entityType: 'PurchaseContract',
      entityId: input.contractId,
      after: { shipmentsMarked: moved.length, of: shipments.length, ataDate: input.ataDate },
    });

    return { marked: moved.length, total: shipments.length };
  });
}

/**
 * One shipment to Arrived, stepping through Loaded first if nobody marked it.
 *
 * Arriving implies it sailed, so a shipment still on the contract is loaded
 * on the same day with the same data the sheet would have asked for, and
 * both steps keep their own history line.
 */
async function arriveShipmentIn(
  tx: Tx,
  shipment: { id: string; status: string },
  ataDate: Date,
  userId: string,
  note: string,
): Promise<void> {
  if (shipment.status === 'CONTRACT_CREATED' || shipment.status === 'AWAITING_LOADING') {
    await tx.shipment.update({
      where: { id: shipment.id },
      data: { status: 'LOADED', loadingDate: ataDate, etaDate: ataDate },
    });
    await tx.shipmentStatusHistory.create({
      data: {
        shipmentId: shipment.id,
        fromStatus: shipment.status,
        toStatus: 'LOADED',
        changedById: userId,
        notes: `${note}; loaded on the same day.`,
      },
    });
  }

  const before = await tx.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: { status: true } });
  await tx.shipment.update({ where: { id: shipment.id }, data: { status: 'ARRIVED', ataDate } });
  await tx.shipmentStatusHistory.create({
    data: { shipmentId: shipment.id, fromStatus: before.status, toStatus: 'ARRIVED', changedById: userId, notes: `${note}.` },
  });
}

/**
 * One container arrived, on its own.
 *
 * The row's own control on the order: this shipment and nothing else. A
 * shipment nobody marked loaded is stepped through Loaded first, the same
 * way "mark all arrived" does it.
 */
export async function markShipmentArrived(input: { companyId: string; shipmentId: string; userId: string; ataDate: Date }) {
  return transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, companyId: input.companyId },
      select: { id: true, status: true, shipmentNumber: true, purchaseContractId: true },
    });
    if (!shipment) throw new NotFoundError('Shipment');
    if (SHIPMENT_STATUSES_LANDED.includes(shipment.status)) return { changed: false };

    await arriveShipmentIn(tx, shipment, input.ataDate, input.userId, 'Marked arrived from the order');
    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'SHIPMENT_STATUS_CHANGED',
      entityType: 'Shipment',
      entityId: shipment.id,
      before: { status: shipment.status },
      after: { status: 'ARRIVED', ataDate: input.ataDate },
    });
    return { changed: true };
  });
}

export type ShipmentOrdinal = { ordinal: number; total: number };

/**
 * "Shipment 2 of 3" for every shipment in the company, keyed by shipment id.
 *
 * Stock, batch and receipt screens name a shipment by its place on the order,
 * because that is how the client refers to it. Computing it here, from all
 * shipments, means shipment 3 is still "3 of 3" on a screen where 1 and 2
 * happen not to appear.
 */
export async function getShipmentOrdinals(companyId: string): Promise<Map<string, ShipmentOrdinal>> {
  const shipments = await prisma.shipment.findMany({
    where: { companyId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, purchaseContractId: true },
  });
  const byContract = new Map<string, string[]>();
  for (const shipment of shipments) {
    const list = byContract.get(shipment.purchaseContractId) ?? [];
    list.push(shipment.id);
    byContract.set(shipment.purchaseContractId, list);
  }
  const result = new Map<string, ShipmentOrdinal>();
  for (const ids of byContract.values()) {
    ids.forEach((id, index) => result.set(id, { ordinal: index + 1, total: ids.length }));
  }
  return result;
}

/** "Shipment 2 of 3", or "Shipment 1" when the order has only one. */
export function shipmentOrdinalLabel(entry: ShipmentOrdinal | undefined): string {
  if (!entry) return '—';
  return entry.total > 1 ? `Shipment ${entry.ordinal} of ${entry.total}` : 'Shipment 1';
}
