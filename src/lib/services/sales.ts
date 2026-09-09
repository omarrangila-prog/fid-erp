import type { Tx } from '@/lib/db';
import { transaction } from '@/lib/db';
import {
  Decimal,
  dec,
  toMoney,
  sum,
  type EntryUnit,
} from '@/lib/money';
import { ACCOUNT_KEYS, DOC_TYPES } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { postJournalEntry, reverseJournalEntry, type JournalLineInput } from '@/lib/services/accounting';
import { consumeStock, releaseReservations, reserveStock, returnStock } from '@/lib/services/inventory';
import { getCompanyContext } from '@/lib/services/company';
import { computeSalesLine } from '@/lib/calc/sales';
import { writeAudit } from '@/lib/services/audit';

/**
 * SalesService.
 *
 * A sale may be raised before or after the goods physically arrive: the client
 * routinely sells cargo that is still on the water. A DRAFT invoice therefore
 * *reserves* batch quantity rather than consuming it, which stops two
 * salespeople promising the same tonnage. Posting converts the reservation into
 * an actual stock movement.
 *
 * Posting performs, atomically:
 *   1. release the invoice's own reservations
 *   2. consume stock from each selected batch (with a row lock and an
 *      availability check that cannot be bypassed from the client)
 *   3. freeze cost of goods on the line at the batch's landed USD cost
 *   4. Dr Accounts Receivable / Cr Sales Revenue
 *      Dr Cost of Goods Sold  / Cr Inventory
 *   5. flip the invoice to POSTED and write the audit trail
 *
 * Receivables, the customer ledger, shipment revenue and shipment
 * profitability are all *derived* from these postings — there is no separate
 * balance to update, so they cannot fall out of step.
 */

export type SalesLineInput = {
  batchId: string;
  /** Which warehouse the coffee physically leaves. Mandatory: stock is held per
   *  warehouse, so a sale has to name the one it depletes. */
  warehouseId: string;
  quantity: string | number;
  unit: EntryUnit;
  unitPrice: string | number;
  bags?: number;
  notes?: string | null;
};

export type SalesInvoiceInput = {
  companyId: string;
  invoiceDate: Date;
  customerId: string;
  shipmentId?: string | null;
  currency: string;
  rateToUsd: string | number;
  rateLocalPerUsd: string | number;
  paymentTermDays?: number;
  reference?: string | null;
  notes?: string | null;
  lines: SalesLineInput[];
};

type ResolvedLine = {
  lineNumber: number;
  batchId: string;
  itemId: string;
  lotId: string;
  containerId: string | null;
  warehouseId: string;
  shipmentId: string;
  bags: number;
  quantity: Decimal;
  unit: EntryUnit;
  quantityKg: Decimal;
  unitPrice: Decimal;
  unitPriceKg: Decimal;
  lineTotal: Decimal;
  lineTotalUsd: Decimal;
  unitCostUsd: Decimal;
  notes: string | null;
};

export { computeSalesLine } from '@/lib/calc/sales';

async function resolveLines(tx: Tx, input: SalesInvoiceInput): Promise<ResolvedLine[]> {
  if (input.lines.length === 0) {
    throw new BusinessRuleError('A sales invoice needs at least one line.');
  }

  const resolved: ResolvedLine[] = [];

  for (let i = 0; i < input.lines.length; i += 1) {
    const line = input.lines[i];
    const batch = await tx.batch.findFirst({
      where: { id: line.batchId, companyId: input.companyId },
      select: {
        id: true,
        itemId: true,
        lotId: true,
        containerId: true,
        shipmentId: true,
        unitCostUsd: true,
        landedUnitCostUsd: true,
        status: true,
        batchNumber: true,
        bagWeightKg: true,
      },
    });
    if (!batch) throw new NotFoundError(`Batch on line ${i + 1}`);
    if (batch.status !== 'ACTIVE') {
      throw new BusinessRuleError(`Batch ${batch.batchNumber} is no longer active and cannot be sold.`);
    }

    const warehouse = await tx.warehouse.findFirst({
      where: { id: line.warehouseId, companyId: input.companyId },
      select: { id: true, name: true, status: true },
    });
    if (!warehouse) throw new NotFoundError(`Warehouse on line ${i + 1}`);
    if (warehouse.status !== 'ACTIVE') {
      throw new BusinessRuleError(`${warehouse.name} is inactive and cannot be sold from.`);
    }

    const bagWeight = dec(batch.bagWeightKg);
    const math = computeSalesLine({
      ...line,
      currency: input.currency,
      rateToUsd: input.rateToUsd,
      bagWeightKg: bagWeight,
    });

    // Derive the bag count from the batch's nominal bag weight when the user
    // sells by weight rather than by bag.
    const bags =
      line.bags ??
      (line.unit === 'BAG'
        ? Number(math.quantity.toFixed(0))
        : bagWeight.greaterThan(0)
          ? Number(math.quantityKg.dividedBy(bagWeight).toFixed(0))
          : 0);

    resolved.push({
      lineNumber: i + 1,
      batchId: batch.id,
      itemId: batch.itemId,
      lotId: batch.lotId,
      containerId: batch.containerId,
      warehouseId: warehouse.id,
      shipmentId: batch.shipmentId,
      bags,
      unitCostUsd: dec(batch.landedUnitCostUsd).greaterThan(0)
        ? dec(batch.landedUnitCostUsd)
        : dec(batch.unitCostUsd),
      notes: line.notes ?? null,
      unit: line.unit,
      ...math,
    });
  }

  return resolved;
}

function invoiceTotals(lines: ResolvedLine[]) {
  const totalAmount = toMoney(sum(lines.map((l) => l.lineTotal)));
  const totalAmountUsd = toMoney(sum(lines.map((l) => l.lineTotalUsd)));
  return { totalAmount, totalAmountUsd };
}

export async function createSalesInvoice(input: SalesInvoiceInput, userId: string) {
  return transaction(async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, companyId: input.companyId },
      select: { id: true, customerName: true },
    });
    if (!customer) throw new NotFoundError('Customer');

    const lines = await resolveLines(tx, input);
    const { totalAmount, totalAmountUsd } = invoiceTotals(lines);

    const invoiceNumber = await nextReference(tx, {
      companyId: input.companyId,
      docType: DOC_TYPES.SALES_INVOICE,
    });

    const dueDate = input.paymentTermDays
      ? new Date(input.invoiceDate.getTime() + input.paymentTermDays * 86_400_000)
      : null;

    // A single-shipment invoice gets linked automatically for profitability.
    const distinctShipments = [...new Set(lines.map((l) => l.shipmentId))];
    const shipmentId = input.shipmentId ?? (distinctShipments.length === 1 ? distinctShipments[0] : null);

    const invoice = await tx.salesInvoice.create({
      data: {
        companyId: input.companyId,
        invoiceNumber,
        invoiceDate: input.invoiceDate,
        customerId: input.customerId,
        shipmentId,
        currency: input.currency.toUpperCase(),
        rateToUsd: dec(input.rateToUsd),
        rateLocalPerUsd: dec(input.rateLocalPerUsd),
        subtotal: totalAmount,
        totalAmount,
        totalAmountUsd,
        paymentTermDays: input.paymentTermDays ?? 0,
        dueDate,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        status: 'DRAFT',
        createdById: userId,
        lines: {
          create: lines.map((l) => ({
            lineNumber: l.lineNumber,
            itemId: l.itemId,
            batchId: l.batchId,
            lotId: l.lotId,
            containerId: l.containerId,
            warehouseId: l.warehouseId,
            shipmentId: l.shipmentId,
            quantity: l.quantity,
            unit: l.unit,
            quantityKg: l.quantityKg,
            bags: l.bags,
            unitPrice: l.unitPrice,
            unitPriceKg: l.unitPriceKg,
            lineTotal: l.lineTotal,
            lineTotalUsd: l.lineTotalUsd,
            notes: l.notes,
          })),
        },
      },
      include: { lines: true },
    });

    // Ring-fence the stock so the draft cannot be oversold from elsewhere.
    for (const line of lines) {
      await reserveStock(tx, {
        companyId: input.companyId,
        batchId: line.batchId,
        warehouseId: line.warehouseId,
        quantityKg: line.quantityKg,
        referenceType: 'SALES_INVOICE',
        referenceId: invoice.id,
        transactionDate: input.invoiceDate,
        createdById: userId,
      });
    }

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'SALES_INVOICE_CREATED',
      entityType: 'SalesInvoice',
      entityId: invoice.id,
      after: { invoiceNumber, customer: customer.customerName, totalAmount, currency: invoice.currency },
    });

    return invoice;
  });
}

export async function updateSalesInvoice(id: string, input: SalesInvoiceInput, userId: string) {
  return transaction(async (tx) => {
    const existing = await tx.salesInvoice.findFirst({
      where: { id, companyId: input.companyId },
      include: { lines: true },
    });
    if (!existing) throw new NotFoundError('Sales invoice');
    if (existing.status !== 'DRAFT') {
      throw new BusinessRuleError('Only draft invoices can be edited. Reverse the invoice to correct a posted one.');
    }

    // Drop the old reservations before re-reserving against the new lines.
    await releaseReservations(tx, {
      companyId: input.companyId,
      referenceType: 'SALES_INVOICE',
      referenceId: id,
      createdById: userId,
      transactionDate: input.invoiceDate,
    });

    const lines = await resolveLines(tx, input);
    const { totalAmount, totalAmountUsd } = invoiceTotals(lines);
    const dueDate = input.paymentTermDays
      ? new Date(input.invoiceDate.getTime() + input.paymentTermDays * 86_400_000)
      : null;
    const distinctShipments = [...new Set(lines.map((l) => l.shipmentId))];
    const shipmentId = input.shipmentId ?? (distinctShipments.length === 1 ? distinctShipments[0] : null);

    await tx.salesInvoiceLine.deleteMany({ where: { salesInvoiceId: id } });

    const invoice = await tx.salesInvoice.update({
      where: { id },
      data: {
        invoiceDate: input.invoiceDate,
        customerId: input.customerId,
        shipmentId,
        currency: input.currency.toUpperCase(),
        rateToUsd: dec(input.rateToUsd),
        rateLocalPerUsd: dec(input.rateLocalPerUsd),
        subtotal: totalAmount,
        totalAmount,
        totalAmountUsd,
        paymentTermDays: input.paymentTermDays ?? 0,
        dueDate,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        lines: {
          create: lines.map((l) => ({
            lineNumber: l.lineNumber,
            itemId: l.itemId,
            batchId: l.batchId,
            lotId: l.lotId,
            containerId: l.containerId,
            warehouseId: l.warehouseId,
            shipmentId: l.shipmentId,
            quantity: l.quantity,
            unit: l.unit,
            quantityKg: l.quantityKg,
            bags: l.bags,
            unitPrice: l.unitPrice,
            unitPriceKg: l.unitPriceKg,
            lineTotal: l.lineTotal,
            lineTotalUsd: l.lineTotalUsd,
            notes: l.notes,
          })),
        },
      },
      include: { lines: true },
    });

    for (const line of lines) {
      await reserveStock(tx, {
        companyId: input.companyId,
        batchId: line.batchId,
        warehouseId: line.warehouseId,
        quantityKg: line.quantityKg,
        referenceType: 'SALES_INVOICE',
        referenceId: id,
        transactionDate: input.invoiceDate,
        createdById: userId,
      });
    }

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'SALES_INVOICE_UPDATED',
      entityType: 'SalesInvoice',
      entityId: id,
      before: { totalAmount: existing.totalAmount, lines: existing.lines.length },
      after: { totalAmount: invoice.totalAmount, lines: invoice.lines.length },
    });

    return invoice;
  });
}

export async function postSalesInvoice(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM sales_invoices
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Sales invoice');
    if (locked[0].status !== 'DRAFT') {
      throw new BusinessRuleError(`This invoice is already ${locked[0].status.toLowerCase()} and cannot be posted again.`);
    }

    const invoice = await tx.salesInvoice.findUniqueOrThrow({
      where: { id: params.id },
      include: { lines: { orderBy: { lineNumber: 'asc' } }, customer: true },
    });

    if (invoice.lines.length === 0) {
      throw new BusinessRuleError('This invoice has no lines and cannot be posted.');
    }

    const company = await getCompanyContext(tx, params.companyId);

    // 1. Give back our own reservation so the availability check below measures
    //    real stock rather than counting this invoice against itself.
    await releaseReservations(tx, {
      companyId: params.companyId,
      referenceType: 'SALES_INVOICE',
      referenceId: invoice.id,
      createdById: params.userId,
      transactionDate: invoice.invoiceDate,
    });

    // 2 & 3. Consume stock and freeze the cost of goods on each line.
    let costOfGoodsUsd = new Decimal(0);

    for (const line of invoice.lines) {
      if (!line.warehouseId) {
        throw new BusinessRuleError(`Line ${line.lineNumber} has no warehouse. Re-open the draft and choose one.`);
      }

      const { unitCostUsd } = await consumeStock(tx, {
        companyId: params.companyId,
        batchId: line.batchId,
        warehouseId: line.warehouseId,
        quantityKg: line.quantityKg,
        bags: line.bags,
        referenceType: 'SALES_INVOICE',
        referenceId: invoice.id,
        transactionDate: invoice.invoiceDate,
        createdById: params.userId,
        notes: `Sold on ${invoice.invoiceNumber}`,
      });

      const costTotalUsd = toMoney(dec(line.quantityKg).times(unitCostUsd));
      costOfGoodsUsd = costOfGoodsUsd.plus(costTotalUsd);

      await tx.salesInvoiceLine.update({
        where: { id: line.id },
        data: { unitCostUsd, costTotalUsd },
      });
    }

    costOfGoodsUsd = toMoney(costOfGoodsUsd);

    // 4. Accounting. Revenue sits in the invoice currency; cost is USD, which is
    //    the currency inventory is carried in.
    const journalLines: JournalLineInput[] = [
      {
        accountKey: ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE,
        direction: 'DEBIT' as const,
        currency: invoice.currency,
        amount: invoice.totalAmount,
        rateToUsd: invoice.rateToUsd,
        description: `Receivable from ${invoice.customer.customerName}`,
        customerId: invoice.customerId,
        salesInvoiceId: invoice.id,
        shipmentId: invoice.shipmentId,
      },
      {
        accountKey: ACCOUNT_KEYS.SALES_REVENUE,
        direction: 'CREDIT' as const,
        currency: invoice.currency,
        amount: invoice.totalAmount,
        rateToUsd: invoice.rateToUsd,
        description: `Sales invoice ${invoice.invoiceNumber}`,
        customerId: invoice.customerId,
        salesInvoiceId: invoice.id,
        shipmentId: invoice.shipmentId,
      },
    ];

    if (costOfGoodsUsd.greaterThan(0)) {
      journalLines.push(
        {
          accountKey: ACCOUNT_KEYS.COST_OF_GOODS_SOLD,
          direction: 'DEBIT' as const,
          currency: 'USD',
          amount: costOfGoodsUsd,
          rateToUsd: new Decimal(1),
          description: `Cost of goods sold on ${invoice.invoiceNumber}`,
          customerId: invoice.customerId,
          salesInvoiceId: invoice.id,
          shipmentId: invoice.shipmentId,
        },
        {
          accountKey: ACCOUNT_KEYS.INVENTORY,
          direction: 'CREDIT' as const,
          currency: 'USD',
          amount: costOfGoodsUsd,
          rateToUsd: new Decimal(1),
          description: `Stock relieved by ${invoice.invoiceNumber}`,
          customerId: invoice.customerId,
          salesInvoiceId: invoice.id,
          shipmentId: invoice.shipmentId,
        },
      );
    }

    await postJournalEntry(tx, {
      companyId: params.companyId,
      entryDate: invoice.invoiceDate,
      description: `Sales invoice ${invoice.invoiceNumber} — ${invoice.customer.customerName}`,
      sourceType: 'SALES_INVOICE',
      sourceId: invoice.id,
      createdById: params.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: invoice.rateLocalPerUsd,
      lines: journalLines,
    });

    // 5. Flip the status.
    const posted = await tx.salesInvoice.update({
      where: { id: invoice.id },
      data: {
        status: 'POSTED',
        postedAt: new Date(),
        postedById: params.userId,
        costOfGoodsUsd,
      },
      include: { lines: true },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'SALES_INVOICE_POSTED',
      entityType: 'SalesInvoice',
      entityId: invoice.id,
      before: { status: 'DRAFT' },
      after: {
        status: 'POSTED',
        totalAmount: invoice.totalAmount,
        currency: invoice.currency,
        costOfGoodsUsd,
      },
    });

    return posted;
  });
}

export async function reverseSalesInvoice(params: {
  id: string;
  companyId: string;
  userId: string;
  reason: string;
}) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM sales_invoices
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Sales invoice');
    if (locked[0].status !== 'POSTED') {
      throw new BusinessRuleError('Only a posted invoice can be reversed.');
    }

    const invoice = await tx.salesInvoice.findUniqueOrThrow({
      where: { id: params.id },
      include: { lines: true, allocations: { include: { receipt: true } } },
    });

    const liveAllocations = invoice.allocations.filter((a) => a.receipt.status === 'POSTED');
    if (liveAllocations.length > 0) {
      throw new BusinessRuleError(
        'Receipts are allocated to this invoice. Reverse those receipts before reversing the invoice.',
      );
    }

    const reversalDate = new Date();

    // Put the stock back at the cost it left at.
    for (const line of invoice.lines) {
      await returnStock(tx, {
        companyId: params.companyId,
        batchId: line.batchId,
        warehouseId: line.warehouseId ?? '',
        quantityKg: line.quantityKg,
        bags: line.bags,
        unitCostUsd: line.unitCostUsd,
        referenceType: 'SALES_INVOICE_REVERSAL',
        referenceId: invoice.id,
        transactionDate: reversalDate,
        createdById: params.userId,
        notes: `Reversal of ${invoice.invoiceNumber}: ${params.reason}`,
      });
    }

    await reverseJournalEntry(tx, {
      companyId: params.companyId,
      sourceType: 'SALES_INVOICE',
      sourceId: invoice.id,
      createdById: params.userId,
      entryDate: reversalDate,
      reason: params.reason,
    });

    const reversed = await tx.salesInvoice.update({
      where: { id: invoice.id },
      data: { status: 'REVERSED', reversedAt: reversalDate, reversalReason: params.reason },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'SALES_INVOICE_REVERSED',
      entityType: 'SalesInvoice',
      entityId: invoice.id,
      before: { status: 'POSTED' },
      after: { status: 'REVERSED', reason: params.reason },
    });

    return reversed;
  });
}

export async function deleteDraftSalesInvoice(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const invoice = await tx.salesInvoice.findFirst({
      where: { id: params.id, companyId: params.companyId },
    });
    if (!invoice) throw new NotFoundError('Sales invoice');
    if (invoice.status !== 'DRAFT') {
      throw new BusinessRuleError('Only draft invoices can be deleted. Posted invoices must be reversed.');
    }

    await releaseReservations(tx, {
      companyId: params.companyId,
      referenceType: 'SALES_INVOICE',
      referenceId: invoice.id,
      createdById: params.userId,
      transactionDate: new Date(),
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'SALES_INVOICE_DELETED',
      entityType: 'SalesInvoice',
      entityId: invoice.id,
      before: { invoiceNumber: invoice.invoiceNumber, totalAmount: invoice.totalAmount },
    });

    // Reservation movements reference the invoice only by id (not a foreign
    // key), so they survive as an audit trail of the released reservation.
    await tx.salesInvoice.delete({ where: { id: params.id } });
  });
}
