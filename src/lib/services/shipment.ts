import type { Tx } from '@/lib/db';
import { transaction, prisma } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';
import { SHIPMENT_STATUS_TRANSITIONS, SHIPMENT_STATUS_REQUIREMENTS, SHIPMENT_STATUS_META } from '@/lib/constants';
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
