import type { Tx } from '@/lib/db';
import { prisma, transaction } from '@/lib/db';
import {
  Decimal,
  dec,
  toMoney,
  sum,
  type EntryUnit,
} from '@/lib/money';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { allocateSalesInvoiceNumber, retireSalesInvoiceNumber } from '@/lib/services/numbering';
import { postJournalEntry, reverseJournalEntry, type JournalLineInput } from '@/lib/services/accounting';
import { consumeStock, releaseReservations, reserveStock, returnStock } from '@/lib/services/inventory';
import { getCompanyContext } from '@/lib/services/company';
import { computeSalesLine } from '@/lib/calc/sales';
import { writeAudit } from '@/lib/services/audit';
import { resolveTaxCode, computeLineTax } from '@/lib/services/tax';
import { createReceiptIn, postReceiptIn, reverseReceiptIn, getInvoiceOutstanding } from '@/lib/services/receipt';

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
  /** Omitted means "use the company default", which is nil when unregistered. */
  taxCodeId?: string | null;
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
  /** The date the money is due, chosen from a calendar on the invoice. */
  dueDate?: Date | null;
  /** CASH settles as the invoice is raised; CREDIT leaves it outstanding. */
  paymentType?: 'CASH' | 'CREDIT';
  /** Where a cash sale's money went. Required when paymentType is CASH. */
  cashBankAccountId?: string | null;
  reference?: string | null;
  notes?: string | null;
  /** Blank means issue the next free number. Typed values stay editable. */
  invoiceNumber?: string | null;
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
  taxCodeId: string | null;
  taxRatePct: Decimal;
  taxAmount: Decimal;
  taxAmountUsd: Decimal;
  notes: string | null;
};

export { computeSalesLine } from '@/lib/calc/sales';

async function resolveLines(tx: Tx, input: SalesInvoiceInput): Promise<ResolvedLine[]> {
  if (input.lines.length === 0) {
    throw new BusinessRuleError('A sales invoice needs at least one line.');
  }

  const company = await tx.company.findUniqueOrThrow({
    where: { id: input.companyId },
    select: { taxEnabled: true },
  });

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

    const taxCode = await resolveTaxCode(tx, {
      companyId: input.companyId,
      taxEnabled: company.taxEnabled,
      taxCodeId: line.taxCodeId,
      appliesTo: 'SALES',
    });
    const tax = computeLineTax({
      netAmount: math.lineTotal,
      ratePct: taxCode.ratePct,
      rateToUsd: input.rateToUsd,
      currency: input.currency,
    });

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
      taxCodeId: taxCode.id,
      taxRatePct: taxCode.ratePct,
      taxAmount: tax.taxAmount,
      taxAmountUsd: tax.taxAmountUsd,
      ...math,
    });
  }

  return resolved;
}

/**
 * Document totals.
 *
 * `subtotal` is the goods value, `taxAmount` is the sum of the per-line tax and
 * `totalAmount` is what the customer owes. The tax total is the sum of amounts
 * already rounded per line, never a fresh rounding of the net total, so the
 * invoice adds up in the customer's hand.
 */
function invoiceTotals(lines: ResolvedLine[]) {
  const subtotal = toMoney(sum(lines.map((l) => l.lineTotal)));
  const subtotalUsd = toMoney(sum(lines.map((l) => l.lineTotalUsd)));
  const taxAmount = toMoney(sum(lines.map((l) => l.taxAmount)));
  const taxAmountUsd = toMoney(sum(lines.map((l) => l.taxAmountUsd)));
  return {
    subtotal,
    subtotalUsd,
    taxAmount,
    taxAmountUsd,
    totalAmount: toMoney(subtotal.plus(taxAmount)),
    totalAmountUsd: toMoney(subtotalUsd.plus(taxAmountUsd)),
  };
}

/**
 * The date the money is due.
 *
 * The invoice asks for a date, not a term. An invoice dated the 10th may be
 * due on the 15th and a cash sale is due the day it is raised; neither is
 * Net 7, Net 30 or Net 60, and offering only those three made the user pick an
 * answer that was not true.
 *
 * When no date is given it falls back to the customer's standing terms, which
 * is what the master record is for. `paymentTermDays` is still derived and
 * stored, because the receivables ageing is expressed in days — it follows
 * from the dates rather than driving them.
 *
 * Note the deliberate `?? 0` and not `|| 0`: zero-day terms — cash on
 * delivery, routine in trading — are falsy, and an earlier version let them
 * fall through to a null due date, so those invoices could never age.
 */
function resolveDueDate(
  invoiceDate: Date,
  chosen: Date | null | undefined,
  standingTermDays: number | null | undefined,
): { dueDate: Date; termDays: number } {
  if (chosen) {
    const days = Math.max(0, Math.round((chosen.getTime() - invoiceDate.getTime()) / 86_400_000));
    return { dueDate: chosen, termDays: days };
  }

  const days = standingTermDays ?? 0;
  return { dueDate: new Date(invoiceDate.getTime() + days * 86_400_000), termDays: days };
}

/**
 * A cash sale must say where the cash went.
 *
 * Not a nicety: without an account the posting has nowhere to debit, and the
 * sale would silently become a credit sale that nobody is chasing.
 */
async function assertCashSaleIsComplete(tx: Tx, input: SalesInvoiceInput): Promise<void> {
  if (input.paymentType !== 'CASH') return;

  if (!input.cashBankAccountId) {
    throw new BusinessRuleError('A cash sale needs the cash or bank account the money went into.');
  }

  const account = await tx.cashBankAccount.findFirst({
    where: { id: input.cashBankAccountId, companyId: input.companyId },
    select: { id: true, name: true, currency: true, status: true },
  });
  if (!account) throw new NotFoundError('Cash or bank account');
  if (account.status !== 'ACTIVE') {
    throw new BusinessRuleError(`${account.name} is inactive and cannot take the money.`);
  }
  if (account.currency.toUpperCase() !== input.currency.toUpperCase()) {
    throw new BusinessRuleError(
      `${account.name} is held in ${account.currency}, so a ${input.currency.toUpperCase()} cash sale cannot be paid into it.`,
    );
  }
}

function lineCreates(lines: ResolvedLine[]) {
  return lines.map((l) => ({
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
    taxCodeId: l.taxCodeId,
    taxRatePct: l.taxRatePct,
    taxAmount: l.taxAmount,
    taxAmountUsd: l.taxAmountUsd,
    notes: l.notes,
  }));
}

export async function createSalesInvoice(input: SalesInvoiceInput, userId: string) {
  return transaction(async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, companyId: input.companyId },
      select: { id: true, customerName: true, paymentTermDays: true },
    });
    if (!customer) throw new NotFoundError('Customer');

    const { dueDate, termDays } = resolveDueDate(input.invoiceDate, input.dueDate, customer.paymentTermDays);
    await assertCashSaleIsComplete(tx, input);

    const lines = await resolveLines(tx, input);
    const totals = invoiceTotals(lines);

    const invoiceNumber = await allocateSalesInvoiceNumber(tx, {
      companyId: input.companyId,
      requested: input.invoiceNumber,
    });

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
        subtotal: totals.subtotal,
        subtotalUsd: totals.subtotalUsd,
        taxAmount: totals.taxAmount,
        taxAmountUsd: totals.taxAmountUsd,
        totalAmount: totals.totalAmount,
        totalAmountUsd: totals.totalAmountUsd,
        paymentTermDays: termDays,
        dueDate,
        paymentType: input.paymentType ?? 'CREDIT',
        cashBankAccountId: input.paymentType === 'CASH' ? (input.cashBankAccountId ?? null) : null,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        status: 'DRAFT',
        createdById: userId,
        lines: {
          create: lineCreates(lines),
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
      after: { invoiceNumber, customer: customer.customerName, totalAmount: totals.totalAmount, currency: invoice.currency },
    });

    return invoice;
  });
}

export async function updateSalesInvoice(id: string, input: SalesInvoiceInput, userId: string) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM sales_invoices
      WHERE "id" = ${id} AND "companyId" = ${input.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Sales invoice');
    if (locked[0].status !== 'DRAFT' && locked[0].status !== 'POSTED') {
      throw new BusinessRuleError('A reversed invoice cannot be edited.');
    }

    const existing = await tx.salesInvoice.findFirst({
      where: { id, companyId: input.companyId },
      include: {
        lines: true,
        allocations: { include: { receipt: { select: { id: true, status: true } } } },
      },
    });
    if (!existing) throw new NotFoundError('Sales invoice');

    const postedCredits = await tx.creditNote.count({
      where: { salesInvoiceId: id, status: 'POSTED' },
    });
    if (postedCredits > 0) {
      throw new BusinessRuleError(
        'This invoice has a posted credit note. Reverse the credit note before changing the invoice.',
      );
    }

    const wasPosted = existing.status === 'POSTED';
    const workingInput: SalesInvoiceInput = wasPosted
      ? {
          ...input,
          paymentType: existing.paymentType,
          cashBankAccountId: existing.cashBankAccountId,
        }
      : input;

    const liveReceipts = existing.allocations.some((allocation) => allocation.receipt.status === 'POSTED');
    if (wasPosted && liveReceipts && existing.paymentType !== 'CASH') {
      if (workingInput.customerId !== existing.customerId) {
        throw new BusinessRuleError(
          'Receipts are allocated to this invoice. Reverse those receipts before changing the customer.',
        );
      }
      if (workingInput.currency.toUpperCase() !== existing.currency) {
        throw new BusinessRuleError(
          'Receipts are allocated to this invoice. Reverse those receipts before changing the currency.',
        );
      }
    }

    if (wasPosted) {
      if (existing.paymentType === 'CASH') {
        await reverseExclusiveReceipts(tx, {
          companyId: input.companyId,
          invoiceId: id,
          userId,
          reason: `Invoice ${existing.invoiceNumber} corrected`,
        });
      }
      await unwindPostedSale(tx, {
        companyId: input.companyId,
        invoice: existing,
        userId,
        reason: `Correction of ${existing.invoiceNumber}`,
      });
    } else {
      await releaseReservations(tx, {
        companyId: input.companyId,
        referenceType: 'SALES_INVOICE',
        referenceId: id,
        createdById: userId,
        transactionDate: input.invoiceDate,
      });
    }

    const customer = await tx.customer.findFirst({
      where: { id: workingInput.customerId, companyId: input.companyId },
      select: { paymentTermDays: true },
    });
    if (!customer) throw new NotFoundError('Customer');

    const lines = await resolveLines(tx, workingInput);
    const totals = invoiceTotals(lines);

    if (wasPosted && existing.paymentType !== 'CASH') {
      const outstanding = await getInvoiceOutstanding(tx, id);
      const allocated = toMoney(dec(existing.totalAmount).minus(outstanding.amount));
      if (allocated.greaterThan(totals.totalAmount)) {
        throw new BusinessRuleError(
          `Receipts of ${existing.currency} ${allocated.toFixed(2)} are already allocated. The corrected invoice cannot be less than that.`,
        );
      }
    }

    const { dueDate, termDays } = resolveDueDate(
      workingInput.invoiceDate,
      workingInput.dueDate,
      customer.paymentTermDays,
    );
    await assertCashSaleIsComplete(tx, workingInput);
    const distinctShipments = [...new Set(lines.map((l) => l.shipmentId))];
    const shipmentId = workingInput.shipmentId ?? (distinctShipments.length === 1 ? distinctShipments[0] : null);

    const invoiceNumber = await allocateSalesInvoiceNumber(tx, {
      companyId: input.companyId,
      requested: workingInput.invoiceNumber ?? existing.invoiceNumber,
      excludeId: id,
    });

    await tx.salesInvoiceLine.deleteMany({ where: { salesInvoiceId: id } });

    const invoice = await tx.salesInvoice.update({
      where: { id },
      data: {
        invoiceNumber,
        invoiceDate: workingInput.invoiceDate,
        customerId: workingInput.customerId,
        shipmentId,
        currency: workingInput.currency.toUpperCase(),
        rateToUsd: dec(workingInput.rateToUsd),
        rateLocalPerUsd: dec(workingInput.rateLocalPerUsd),
        subtotal: totals.subtotal,
        subtotalUsd: totals.subtotalUsd,
        taxAmount: totals.taxAmount,
        taxAmountUsd: totals.taxAmountUsd,
        totalAmount: totals.totalAmount,
        totalAmountUsd: totals.totalAmountUsd,
        paymentTermDays: termDays,
        dueDate,
        paymentType: workingInput.paymentType ?? 'CREDIT',
        cashBankAccountId: workingInput.paymentType === 'CASH' ? (workingInput.cashBankAccountId ?? null) : null,
        reference: workingInput.reference ?? null,
        notes: workingInput.notes ?? null,
        lines: { create: lineCreates(lines) },
      },
      include: { lines: { orderBy: { lineNumber: 'asc' } }, customer: true },
    });

    if (wasPosted) {
      const posted = await recordPostedSale(tx, {
        companyId: input.companyId,
        invoice,
        userId,
        settleCash: existing.paymentType === 'CASH',
        keepPostedAt: existing.postedAt,
      });

      await writeAudit(tx, {
        companyId: input.companyId,
        userId,
        action: 'SALES_INVOICE_UPDATED',
        entityType: 'SalesInvoice',
        entityId: id,
        before: { totalAmount: existing.totalAmount, lines: existing.lines.length, status: existing.status },
        after: { totalAmount: posted.totalAmount, lines: posted.lines.length, status: 'POSTED' },
      });

      return posted;
    }

    for (const line of lines) {
      await reserveStock(tx, {
        companyId: input.companyId,
        batchId: line.batchId,
        warehouseId: line.warehouseId,
        quantityKg: line.quantityKg,
        referenceType: 'SALES_INVOICE',
        referenceId: id,
        transactionDate: workingInput.invoiceDate,
        createdById: userId,
      });
    }

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'SALES_INVOICE_UPDATED',
      entityType: 'SalesInvoice',
      entityId: id,
      before: { totalAmount: existing.totalAmount, lines: existing.lines.length, status: existing.status },
      after: { totalAmount: invoice.totalAmount, lines: invoice.lines.length, status: 'DRAFT' },
    });

    return invoice;
  });
}

async function reverseExclusiveReceipts(
  tx: Tx,
  params: { companyId: string; invoiceId: string; userId: string; reason: string },
) {
  const receipts = await tx.receipt.findMany({
    where: {
      companyId: params.companyId,
      status: 'POSTED',
      allocations: { some: { salesInvoiceId: params.invoiceId } },
    },
    include: { allocations: true },
  });

  for (const receipt of receipts) {
    const onlyThis = receipt.allocations.every((allocation) => allocation.salesInvoiceId === params.invoiceId);
    if (!onlyThis) {
      throw new BusinessRuleError(
        'A receipt on this invoice also settles another invoice, so the sale cannot be corrected in place. Reverse the receipt first.',
      );
    }
    await reverseReceiptIn(tx, {
      id: receipt.id,
      companyId: params.companyId,
      userId: params.userId,
      reason: params.reason,
    });
  }
}

async function unwindPostedSale(
  tx: Tx,
  params: {
    companyId: string;
    invoice: { id: string; invoiceNumber: string; lines: Array<{
      batchId: string;
      warehouseId: string | null;
      quantityKg: Decimal;
      bags: number;
      unitCostUsd: Decimal;
    }> };
    userId: string;
    reason: string;
  },
) {
  const reversalDate = new Date();
  for (const line of params.invoice.lines) {
    await returnStock(tx, {
      companyId: params.companyId,
      batchId: line.batchId,
      warehouseId: line.warehouseId ?? '',
      quantityKg: line.quantityKg,
      bags: line.bags,
      unitCostUsd: line.unitCostUsd,
      referenceType: 'SALES_INVOICE_REVERSAL',
      referenceId: params.invoice.id,
      transactionDate: reversalDate,
      createdById: params.userId,
      notes: params.reason,
    });
  }

  await reverseJournalEntry(tx, {
    companyId: params.companyId,
    sourceType: 'SALES_INVOICE',
    sourceId: params.invoice.id,
    createdById: params.userId,
    entryDate: reversalDate,
    reason: params.reason,
  });
}

async function recordPostedSale(
  tx: Tx,
  params: {
    companyId: string;
    invoice: {
      id: string;
      invoiceNumber: string;
      invoiceDate: Date;
      customerId: string;
      shipmentId: string | null;
      currency: string;
      rateToUsd: Decimal;
      rateLocalPerUsd: Decimal;
      subtotal: Decimal;
      taxAmount: Decimal;
      totalAmount: Decimal;
      paymentType: string;
      cashBankAccountId: string | null;
      customer: { customerName: string };
      lines: Array<{
        id: string;
        lineNumber: number;
        batchId: string;
        warehouseId: string | null;
        quantityKg: Decimal;
        bags: number;
      }>;
    };
    userId: string;
    settleCash: boolean;
    /** Keep the original posting time when restating a posted invoice. */
    keepPostedAt?: Date | null;
  },
) {
  const { invoice } = params;
  if (invoice.lines.length === 0) {
    throw new BusinessRuleError('This invoice has no lines and cannot be posted.');
  }

  const company = await getCompanyContext(tx, params.companyId);
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
      amount: invoice.subtotal,
      rateToUsd: invoice.rateToUsd,
      description: `Sales invoice ${invoice.invoiceNumber}`,
      customerId: invoice.customerId,
      salesInvoiceId: invoice.id,
      shipmentId: invoice.shipmentId,
    },
  ];

  if (dec(invoice.taxAmount).greaterThan(0)) {
    journalLines.push({
      accountKey: ACCOUNT_KEYS.VAT_OUTPUT,
      direction: 'CREDIT' as const,
      currency: invoice.currency,
      amount: invoice.taxAmount,
      rateToUsd: invoice.rateToUsd,
      description: `Output tax on ${invoice.invoiceNumber}`,
      customerId: invoice.customerId,
      salesInvoiceId: invoice.id,
    });
  }

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

  const posted = await tx.salesInvoice.update({
    where: { id: invoice.id },
    data: {
      status: 'POSTED',
      postedAt: params.keepPostedAt ?? new Date(),
      postedById: params.userId,
      costOfGoodsUsd,
    },
    include: { lines: true },
  });

  if (params.settleCash) {
    if (!invoice.cashBankAccountId) {
      throw new BusinessRuleError(
        'This is a cash sale but no cash account is named. Re-open the draft and choose where the money went.',
      );
    }
    const receipt = await createReceiptIn(
      tx,
      {
        companyId: params.companyId,
        receiptDate: invoice.invoiceDate,
        customerId: invoice.customerId,
        currency: invoice.currency,
        amount: invoice.totalAmount.toString(),
        rateToUsd: invoice.rateToUsd.toString(),
        rateLocalPerUsd: invoice.rateLocalPerUsd.toString(),
        paymentMethod: 'CASH',
        cashBankAccountId: invoice.cashBankAccountId,
        reference: invoice.invoiceNumber,
        description: `Cash sale ${invoice.invoiceNumber}`,
        allocations: [{ salesInvoiceId: invoice.id, amount: invoice.totalAmount.toString() }],
      },
      params.userId,
    );
    await postReceiptIn(tx, { id: receipt.id, companyId: params.companyId, userId: params.userId });
  }

  return posted;
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

    await releaseReservations(tx, {
      companyId: params.companyId,
      referenceType: 'SALES_INVOICE',
      referenceId: invoice.id,
      createdById: params.userId,
      transactionDate: invoice.invoiceDate,
    });

    const posted = await recordPostedSale(tx, {
      companyId: params.companyId,
      invoice,
      userId: params.userId,
      settleCash: invoice.paymentType === 'CASH',
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
        costOfGoodsUsd: posted.costOfGoodsUsd,
      },
    });

    return posted;
  });
}

/**
 * Reverse a posted invoice. This is the only writer of SalesInvoice.status =
 * REVERSED. Refresh, edit, failed post and payment do not call it.
 */
export async function reverseSalesInvoice(params: {
  id: string;
  companyId: string;
  userId: string;
  reason: string;
}) {
  return transaction((tx) => reverseSalesInvoiceIn(tx, params));
}

async function reverseSalesInvoiceIn(
  tx: Tx,
  params: { id: string; companyId: string; userId: string; reason: string },
) {
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
    include: {
      lines: true,
      allocations: { include: { receipt: true } },
      creditNotes: { select: { id: true, status: true, creditNoteNumber: true } },
    },
  });

  const liveAllocations = invoice.allocations.filter((a) => a.receipt.status === 'POSTED');
  if (liveAllocations.length > 0) {
    throw new BusinessRuleError(
      'Receipts are allocated to this invoice. Reverse those receipts before reversing the invoice.',
    );
  }

  const draftAllocations = invoice.allocations.filter((a) => a.receipt.status === 'DRAFT');
  if (draftAllocations.length > 0) {
    throw new BusinessRuleError(
      `Draft receipt ${draftAllocations[0].receipt.receiptNumber} is still allocated. Delete that draft before cancelling the invoice.`,
    );
  }

  const liveCredits = invoice.creditNotes.filter((note) => note.status === 'POSTED');
  if (liveCredits.length > 0) {
    throw new BusinessRuleError(
      `Credit note ${liveCredits[0].creditNoteNumber} is still posted against this invoice.`,
    );
  }

  const reversalDate = new Date();

  // Put the stock back at the cost it left at.
  for (const line of invoice.lines) {
    if (!line.warehouseId) {
      throw new BusinessRuleError(
        'This invoice has a line without a warehouse and cannot be cancelled without corrupting stock.',
      );
    }
    await returnStock(tx, {
      companyId: params.companyId,
      batchId: line.batchId,
      warehouseId: line.warehouseId,
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

  const retiredNumber = await retireSalesInvoiceNumber(tx, {
    id: invoice.id,
    companyId: params.companyId,
    invoiceNumber: invoice.invoiceNumber,
  });

  await writeAudit(tx, {
    companyId: params.companyId,
    userId: params.userId,
    action: 'SALES_INVOICE_REVERSED',
    entityType: 'SalesInvoice',
    entityId: invoice.id,
    before: { status: 'POSTED', invoiceNumber: invoice.invoiceNumber },
    after: { status: 'REVERSED', reason: params.reason, invoiceNumber: retiredNumber },
  });

  return { ...reversed, invoiceNumber: retiredNumber };
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

export async function cancelSalesInvoice(params: {
  id: string;
  companyId: string;
  userId: string;
  reason?: string;
}): Promise<{ status: 'DELETED' | 'REVERSED' }> {
  const invoice = await prisma.salesInvoice.findFirst({
    where: { id: params.id, companyId: params.companyId },
    select: { id: true, status: true },
  });
  if (!invoice) throw new NotFoundError('Sales invoice');

  // A draft has touched nothing but a reservation, so it can go. A posted
  // invoice has moved stock, a receivable and the ledger; the only honest
  // way to take it back is a reversal, and the reversed document stays —
  // it is what every journal line and receipt allocation still points at.
  // The cancelled invoice used to be deleted physically after reversal,
  // which nulled its journal lines' source and removed the allocations of
  // posted receipts, so the ledger had lines with no document behind them
  // and receipts that no longer said what they had settled.
  if (invoice.status === 'DRAFT') {
    await deleteDraftSalesInvoice(params);
    return { status: 'DELETED' };
  }

  if (invoice.status === 'POSTED') {
    const reason = params.reason?.trim() || 'Invoice cancelled';
    await reverseSalesInvoice({ ...params, reason });
    return { status: 'REVERSED' };
  }

  if (invoice.status === 'REVERSED') {
    return { status: 'REVERSED' };
  }

  throw new BusinessRuleError(`This invoice cannot be cancelled from status ${invoice.status}.`);
}
