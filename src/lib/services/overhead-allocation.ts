import { prisma, transaction } from '@/lib/db';
import { Decimal, dec, toMoney, sum, allocateProportionally } from '@/lib/money';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';

/**
 * Management allocation of overheads across shipments.
 *
 * Rent, salaries and fuel are earned by the company as a whole, so they are
 * posted to general expenses and belong on the company profit and loss. But
 * management still wants to ask "what did this shipment really cost once its
 * share of the office is counted?" — and the answer must not disturb the
 * statutory accounts to give it.
 *
 * So this is a view, not a posting. Nothing here writes to the general
 * ledger: the original general expense stays exactly where it was, visible
 * separately, and the Trial Balance, Company P&L and Balance Sheet are
 * untouched. The allocation is recorded beside them and shown on the
 * shipment profitability report as a clearly-labelled management figure.
 *
 * Four bases, as the client's requirements set out: by kilograms, by sales
 * value, by a percentage the user types, or equally across the shipments
 * chosen.
 */

export type OverheadBasis = 'QUANTITY' | 'SALES_VALUE' | 'PERCENTAGE' | 'EQUAL';

export type OverheadCandidate = {
  shipmentId: string;
  reference: string;
  ordinal: number;
  itemName: string;
  receivedKg: Decimal;
  /** What was bought, whether or not it has landed yet. */
  orderedKg: Decimal;
  soldKg: Decimal;
  salesUsd: Decimal;
};

/** The general expenses in a period, and what they come to. */
export async function getAllocatableOverheads(params: { companyId: string; from: Date; to: Date }) {
  const expenses = await prisma.expense.findMany({
    where: {
      companyId: params.companyId,
      kind: 'GENERAL',
      status: 'POSTED',
      expenseDate: { gte: params.from, lte: params.to },
    },
    orderBy: { expenseDate: 'asc' },
    select: {
      id: true,
      expenseDate: true,
      description: true,
      amount: true,
      currency: true,
      amountUsd: true,
      amountLocal: true,
      overheadAllocationId: true,
      expenseCategory: { select: { name: true } },
    },
  });

  return {
    expenses,
    totalUsd: toMoney(sum(expenses.map((e) => dec(e.amountUsd)))),
    totalLocal: toMoney(sum(expenses.map((e) => dec(e.amountLocal)))),
  };
}

/** The shipments an allocation may be spread over, with the weights each basis uses. */
export async function getOverheadCandidates(params: { companyId: string; from: Date; to: Date }): Promise<OverheadCandidate[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      shipmentId: string;
      reference: string;
      itemName: string;
      receivedKg: string;
      orderedKg: string;
      soldKg: string;
      salesUsd: string;
      createdAt: Date;
      contractId: string;
    }>
  >`
    SELECT s."id" AS "shipmentId", pc."contractReference" AS reference, i."itemName",
           s."createdAt", pc."id" AS "contractId",
           COALESCE((SELECT SUM(b."receivedQuantityKg") FROM batches b WHERE b."shipmentId" = s."id" AND b."status" = 'ACTIVE'), 0)::text AS "receivedKg",
           COALESCE((SELECT SUM(b."orderedQuantityKg") FROM batches b WHERE b."shipmentId" = s."id" AND b."status" = 'ACTIVE'), 0)::text AS "orderedKg",
           COALESCE((SELECT SUM(b."soldQuantityKg") FROM batches b WHERE b."shipmentId" = s."id" AND b."status" = 'ACTIVE'), 0)::text AS "soldKg",
           COALESCE((SELECT SUM(sil."lineTotalUsd")
                       FROM sales_invoice_lines sil
                       JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
                       JOIN batches b2 ON b2."id" = sil."batchId"
                      WHERE b2."shipmentId" = s."id" AND si."status" = 'POSTED'
                        AND si."invoiceDate" BETWEEN ${params.from}::date AND ${params.to}::date), 0)::text AS "salesUsd"
    FROM shipments s
    JOIN purchase_contracts pc ON pc."id" = s."purchaseContractId"
    JOIN coffee_items i ON i."id" = s."itemId"
    WHERE s."companyId" = ${params.companyId} AND pc."status" = 'POSTED'
    ORDER BY pc."contractReference", s."createdAt"
  `;

  // "Shipment 2 of 3" numbering, the way every other screen names them.
  const ordinalOf = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const row of rows) {
    const next = (seen.get(row.contractId) ?? 0) + 1;
    seen.set(row.contractId, next);
    ordinalOf.set(row.shipmentId, next);
  }

  return rows.map((row) => ({
    shipmentId: row.shipmentId,
    reference: row.reference,
    ordinal: ordinalOf.get(row.shipmentId) ?? 1,
    itemName: row.itemName,
    receivedKg: dec(row.receivedKg),
    orderedKg: dec(row.orderedKg),
    soldKg: dec(row.soldKg),
    salesUsd: dec(row.salesUsd),
  }));
}

/** The weight one shipment carries under a given basis. */
function weightFor(basis: OverheadBasis, candidate: OverheadCandidate, percentage: Decimal | undefined): Decimal {
  switch (basis) {
    case 'QUANTITY':
      // What has landed, or what was bought when nothing has landed yet: a
      // consignment still at sea is part of the month's work either way.
      return candidate.receivedKg.greaterThan(0) ? candidate.receivedKg : candidate.orderedKg;
    case 'SALES_VALUE':
      return candidate.salesUsd;
    case 'PERCENTAGE':
      return percentage ?? new Decimal(0);
    case 'EQUAL':
      return new Decimal(1);
  }
}

export type AllocateOverheadInput = {
  companyId: string;
  userId: string;
  from: Date;
  to: Date;
  basis: OverheadBasis;
  /** The shipments to share it over; with PERCENTAGE, each carries its own share. */
  shipments: Array<{ shipmentId: string; percentage?: string | number }>;
  notes?: string | null;
};

/**
 * Record an allocation. Supersedes any earlier allocation for the same period,
 * so the period is never counted twice, and leaves every expense where it is.
 */
export async function allocateOverheads(input: AllocateOverheadInput) {
  if (input.shipments.length === 0) throw new BusinessRuleError('Choose at least one shipment to allocate across.');

  return transaction(async (tx) => {
    const company = await tx.company.findFirst({ where: { id: input.companyId }, select: { id: true } });
    if (!company) throw new NotFoundError('Company');

    const { expenses, totalUsd, totalLocal } = await getAllocatableOverheads({
      companyId: input.companyId,
      from: input.from,
      to: input.to,
    });
    if (totalUsd.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError('There are no posted general expenses in that period to allocate.');
    }

    const candidates = await getOverheadCandidates({ companyId: input.companyId, from: input.from, to: input.to });
    const byId = new Map(candidates.map((c) => [c.shipmentId, c]));

    const chosen = input.shipments.map((s) => {
      const candidate = byId.get(s.shipmentId);
      if (!candidate) throw new NotFoundError('Shipment on this allocation');
      return { candidate, percentage: s.percentage === undefined ? undefined : dec(s.percentage) };
    });

    const weights = chosen.map((c) => weightFor(input.basis, c.candidate, c.percentage));
    if (sum(weights).lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(
        input.basis === 'SALES_VALUE'
          ? 'None of the chosen shipments sold anything in this period, so there is nothing to share the overhead on.'
          : 'The chosen shipments carry no weight on this basis, so the overhead cannot be shared.',
      );
    }

    const sharesUsd = allocateProportionally(totalUsd, weights);
    const sharesLocal = allocateProportionally(totalLocal, weights);

    // One allocation per period: the previous view of the same months is
    // withdrawn rather than deleted, so what management saw last time is
    // still readable.
    await tx.overheadAllocation.updateMany({
      where: { companyId: input.companyId, status: 'ACTIVE', fromDate: input.from, toDate: input.to },
      data: { status: 'WITHDRAWN' },
    });

    const allocation = await tx.overheadAllocation.create({
      data: {
        companyId: input.companyId,
        fromDate: input.from,
        toDate: input.to,
        basis: input.basis,
        amountUsd: totalUsd,
        amountLocal: totalLocal,
        notes: input.notes ?? null,
        createdById: input.userId,
        lines: {
          create: chosen.map((c, index) => ({
            shipmentId: c.candidate.shipmentId,
            weight: toMoney(weights[index]),
            amountUsd: sharesUsd[index],
            amountLocal: sharesLocal[index],
          })),
        },
      },
      include: { lines: true },
    });

    // The expenses are marked as counted, and nothing else about them moves:
    // same amount, same account, same place on the company profit and loss.
    await tx.expense.updateMany({
      where: { id: { in: expenses.map((e) => e.id) } },
      data: { overheadAllocationId: allocation.id },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'OVERHEAD_ALLOCATED',
      entityType: 'OverheadAllocation',
      entityId: allocation.id,
      after: {
        basis: input.basis,
        from: input.from,
        to: input.to,
        amountUsd: totalUsd.toString(),
        shipments: allocation.lines.length,
        expenses: expenses.length,
      },
    });

    return allocation;
  });
}

/** Withdraw an allocation. The expenses stay posted; only the view goes. */
export async function withdrawOverheadAllocation(params: { companyId: string; id: string; userId: string }) {
  return transaction(async (tx) => {
    const allocation = await tx.overheadAllocation.findFirst({
      where: { id: params.id, companyId: params.companyId },
      select: { id: true, status: true },
    });
    if (!allocation) throw new NotFoundError('Overhead allocation');
    if (allocation.status !== 'ACTIVE') throw new BusinessRuleError('This allocation has already been withdrawn.');

    await tx.overheadAllocation.update({ where: { id: allocation.id }, data: { status: 'WITHDRAWN' } });
    await tx.expense.updateMany({ where: { overheadAllocationId: allocation.id }, data: { overheadAllocationId: null } });
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'OVERHEAD_ALLOCATION_WITHDRAWN',
      entityType: 'OverheadAllocation',
      entityId: allocation.id,
      before: { status: 'ACTIVE' },
      after: { status: 'WITHDRAWN' },
    });
  });
}

/** What each shipment has been allocated, for the profitability report. */
export async function getOverheadByShipment(params: {
  companyId: string;
  from?: Date;
  to?: Date;
}): Promise<Map<string, Decimal>> {
  const lines = await prisma.overheadAllocationLine.findMany({
    where: {
      allocation: {
        companyId: params.companyId,
        status: 'ACTIVE',
        ...(params.from ? { toDate: { gte: params.from } } : {}),
        ...(params.to ? { fromDate: { lte: params.to } } : {}),
      },
    },
    select: { shipmentId: true, amountUsd: true },
  });

  const byShipment = new Map<string, Decimal>();
  for (const line of lines) {
    byShipment.set(line.shipmentId, (byShipment.get(line.shipmentId) ?? new Decimal(0)).plus(line.amountUsd));
  }
  return byShipment;
}

/** Every allocation made, newest first, for the screen that lists them. */
export async function listOverheadAllocations(companyId: string) {
  return prisma.overheadAllocation.findMany({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: { select: { name: true } },
      lines: {
        include: {
          shipment: {
            select: { id: true, purchaseContract: { select: { contractReference: true } }, item: { select: { itemName: true } } },
          },
        },
      },
    },
  });
}
