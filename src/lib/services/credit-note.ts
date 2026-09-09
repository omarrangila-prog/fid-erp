import type { Tx } from '@/lib/db';
import { transaction } from '@/lib/db';
import { Decimal, dec, toMoney, toQuantity, convertToUsd } from '@/lib/money';
import { ACCOUNT_KEYS, DOC_TYPES } from '@/lib/constants';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { postJournalEntry, reverseJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { writeAudit } from '@/lib/services/audit';
import { consumeStock, returnStock } from '@/lib/services/inventory';
import { resolveTaxCode, computeLineTax } from '@/lib/services/tax';
import { resolveSubledgerLeg } from '@/lib/services/subledger';

/**
 * Credit notes, both directions.
 *
 * A credit note is not a reversal. Reversing unwinds a document as though it
 * had never been raised; a credit note is its own document that reduces what is
 * owed while both papers stay in the history — which is what an auditor, and a
 * customer holding the original invoice, both need.
 *
 * A customer credit may also bring coffee back into a warehouse. When it does,
 * the stock returns at the batch's landed cost and the same amount comes back
 * out of cost of sales, so margin is restated rather than quietly overstated.
 */

export type CreditNoteLineInput = {
  description: string;
  /** Present when this line returns coffee to a warehouse. */
  batchId?: string | null;
  warehouseId?: string | null;
  quantityKg?: string | number;
  bags?: number;
  unitPrice?: string | number;
  /** Used when the line is a pure value credit with no stock behind it. */
  amount?: string | number;
  /** Omitted means "use the company default", which is nil when unregistered. */
  taxCodeId?: string | null;
};

export type CreditNoteInput = {
  companyId: string;
  type: 'CUSTOMER' | 'VENDOR';
  creditDate: Date;
  customerId?: string | null;
  vendorId?: string | null;
  salesInvoiceId?: string | null;
  purchaseContractId?: string | null;
  currency: string;
  rateToUsd: string | number;
  rateLocalPerUsd: string | number;
  reason: string;
  reference?: string | null;
  notes?: string | null;
  lines: CreditNoteLineInput[];
};

type ResolvedLine = {
  lineNumber: number;
  description: string;
  batchId: string | null;
  warehouseId: string | null;
  itemId: string | null;
  quantityKg: Decimal;
  bags: number;
  unitPrice: Decimal;
  lineTotal: Decimal;
  lineTotalUsd: Decimal;
  costTotalUsd: Decimal;
  taxCodeId: string | null;
  taxRatePct: Decimal;
  taxAmount: Decimal;
  taxAmountUsd: Decimal;
};

async function resolveLines(tx: Tx, input: CreditNoteInput): Promise<ResolvedLine[]> {
  if (input.lines.length === 0) {
    throw new BusinessRuleError('A credit note needs at least one line.');
  }

  const company = await tx.company.findUniqueOrThrow({
    where: { id: input.companyId },
    select: { taxEnabled: true },
  });

  const resolved: ResolvedLine[] = [];

  for (const [index, line] of input.lines.entries()) {
    const quantityKg = toQuantity(line.quantityKg ?? 0);
    const unitPrice = dec(line.unitPrice ?? 0);

    // Either a quantity at a price, or a flat amount — not a mixture.
    const lineTotal = quantityKg.greaterThan(0)
      ? toMoney(quantityKg.times(unitPrice))
      : toMoney(line.amount ?? 0);

    if (lineTotal.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(`Line ${index + 1} has no value. Enter a quantity and price, or an amount.`);
    }

    let batchId: string | null = null;
    let warehouseId: string | null = null;
    let itemId: string | null = null;
    let costTotalUsd = new Decimal(0);

    if (line.batchId) {
      if (!line.warehouseId) {
        throw new BusinessRuleError(
          `Line ${index + 1} returns stock but names no warehouse. Coffee has to come back somewhere.`,
        );
      }
      if (quantityKg.lessThanOrEqualTo(0)) {
        throw new BusinessRuleError(`Line ${index + 1} returns stock but has no quantity.`);
      }

      const batch = await tx.batch.findFirst({
        where: { id: line.batchId, companyId: input.companyId },
        select: { id: true, itemId: true, landedUnitCostUsd: true, soldQuantityKg: true, batchNumber: true },
      });
      if (!batch) throw new NotFoundError('Batch');

      // You cannot return more than was sold out of the batch.
      if (quantityKg.greaterThan(batch.soldQuantityKg)) {
        throw new BusinessRuleError(
          `Batch ${batch.batchNumber} has only ${dec(batch.soldQuantityKg).toFixed(3)} KG recorded as sold, so ${quantityKg.toFixed(3)} KG cannot be returned.`,
        );
      }

      const warehouse = await tx.warehouse.findFirst({
        where: { id: line.warehouseId, companyId: input.companyId },
        select: { id: true },
      });
      if (!warehouse) throw new NotFoundError('Warehouse');

      batchId = batch.id;
      warehouseId = warehouse.id;
      itemId = batch.itemId;
      costTotalUsd = toMoney(quantityKg.times(batch.landedUnitCostUsd));
    }

    // A credit reverses the tax charged on the original supply, so it uses the
    // same direction of code as the document it credits.
    const taxCode = await resolveTaxCode(tx, {
      companyId: input.companyId,
      taxEnabled: company.taxEnabled,
      taxCodeId: line.taxCodeId,
      appliesTo: input.type === 'CUSTOMER' ? 'SALES' : 'PURCHASE',
    });
    const tax = computeLineTax({
      netAmount: lineTotal,
      ratePct: taxCode.ratePct,
      rateToUsd: input.rateToUsd,
      currency: input.currency,
    });

    resolved.push({
      lineNumber: index + 1,
      description: line.description,
      batchId,
      warehouseId,
      itemId,
      quantityKg,
      bags: line.bags ?? 0,
      unitPrice,
      lineTotal,
      lineTotalUsd: convertToUsd(lineTotal, input.rateToUsd, input.currency),
      costTotalUsd,
      taxCodeId: taxCode.id,
      taxRatePct: taxCode.ratePct,
      taxAmount: tax.taxAmount,
      taxAmountUsd: tax.taxAmountUsd,
    });
  }

  return resolved;
}

export async function createCreditNote(input: CreditNoteInput, userId: string) {
  return transaction(async (tx) => {
    if (input.type === 'CUSTOMER' && !input.customerId) {
      throw new BusinessRuleError('A customer credit note needs a customer.');
    }
    if (input.type === 'VENDOR' && !input.vendorId) {
      throw new BusinessRuleError('A supplier credit note needs a supplier.');
    }
    if (!input.reason.trim()) {
      throw new BusinessRuleError('State why the credit is being raised — it appears on the document and in the audit trail.');
    }

    const lines = await resolveLines(tx, input);
    const subtotalAmount = toMoney(lines.reduce((sum, line) => sum.plus(line.lineTotal), new Decimal(0)));
    const subtotalAmountUsd = toMoney(lines.reduce((sum, line) => sum.plus(line.lineTotalUsd), new Decimal(0)));
    const taxAmount = toMoney(lines.reduce((sum, line) => sum.plus(line.taxAmount), new Decimal(0)));
    const taxAmountUsd = toMoney(lines.reduce((sum, line) => sum.plus(line.taxAmountUsd), new Decimal(0)));
    // Gross, because that is what comes off the customer's or supplier's balance.
    const totalAmount = toMoney(subtotalAmount.plus(taxAmount));
    const totalAmountUsd = toMoney(subtotalAmountUsd.plus(taxAmountUsd));
    const costOfGoodsUsd = lines.reduce((sum, line) => sum.plus(line.costTotalUsd), new Decimal(0));

    // A customer credit cannot exceed what the invoice it references is worth.
    if (input.salesInvoiceId) {
      const invoice = await tx.salesInvoice.findFirst({
        where: { id: input.salesInvoiceId, companyId: input.companyId },
        select: { id: true, invoiceNumber: true, totalAmountUsd: true },
      });
      if (!invoice) throw new NotFoundError('Sales invoice');

      const alreadyCredited = await tx.creditNote.aggregate({
        where: { salesInvoiceId: invoice.id, status: 'POSTED' },
        _sum: { totalAmountUsd: true },
      });
      const headroom = dec(invoice.totalAmountUsd).minus(alreadyCredited._sum.totalAmountUsd ?? 0);
      if (toMoney(totalAmountUsd).greaterThan(headroom)) {
        throw new BusinessRuleError(
          `Invoice ${invoice.invoiceNumber} has only USD ${headroom.toFixed(2)} left to credit, which is less than the USD ${totalAmountUsd.toFixed(2)} on this note.`,
        );
      }
    }

    const creditNoteNumber = await nextReference(tx, {
      companyId: input.companyId,
      docType: input.type === 'CUSTOMER' ? DOC_TYPES.CREDIT_NOTE : DOC_TYPES.DEBIT_NOTE,
    });

    const note = await tx.creditNote.create({
      data: {
        companyId: input.companyId,
        creditNoteNumber,
        type: input.type,
        creditDate: input.creditDate,
        customerId: input.customerId ?? null,
        vendorId: input.vendorId ?? null,
        salesInvoiceId: input.salesInvoiceId ?? null,
        purchaseContractId: input.purchaseContractId ?? null,
        currency: input.currency.toUpperCase(),
        rateToUsd: dec(input.rateToUsd),
        rateLocalPerUsd: dec(input.rateLocalPerUsd),
        subtotalAmount,
        subtotalAmountUsd,
        taxAmount,
        taxAmountUsd,
        totalAmount,
        totalAmountUsd,
        costOfGoodsUsd: toMoney(costOfGoodsUsd),
        reason: input.reason.trim(),
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        status: 'DRAFT',
        createdById: userId,
        lines: {
          create: lines.map((line) => ({
            lineNumber: line.lineNumber,
            description: line.description,
            batchId: line.batchId,
            warehouseId: line.warehouseId,
            itemId: line.itemId,
            quantityKg: line.quantityKg,
            bags: line.bags,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            lineTotalUsd: line.lineTotalUsd,
            costTotalUsd: line.costTotalUsd,
            taxCodeId: line.taxCodeId,
            taxRatePct: line.taxRatePct,
            taxAmount: line.taxAmount,
            taxAmountUsd: line.taxAmountUsd,
          })),
        },
      },
      include: { lines: true },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'CREDIT_NOTE_CREATED',
      entityType: 'CreditNote',
      entityId: note.id,
      after: { number: note.creditNoteNumber, type: note.type, total: note.totalAmount.toString() },
    });

    return note;
  });
}

export async function postCreditNote(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM credit_notes
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('Credit note');
    if (locked[0].status !== 'DRAFT') {
      throw new ConflictError(`This credit note is already ${locked[0].status.toLowerCase()}.`);
    }

    const note = await tx.creditNote.findUniqueOrThrow({
      where: { id: params.id },
      include: { lines: true, customer: true, vendor: true },
    });
    const company = await getCompanyContext(tx, params.companyId);

    // Stock first: if a return cannot be made, nothing should post.
    for (const line of note.lines) {
      if (!line.batchId || !line.warehouseId || dec(line.quantityKg).lessThanOrEqualTo(0)) continue;
      await returnStock(tx, {
        companyId: params.companyId,
        batchId: line.batchId,
        warehouseId: line.warehouseId,
        quantityKg: line.quantityKg,
        bags: line.bags,
        unitCostUsd: dec(line.quantityKg).isZero()
          ? 0
          : dec(line.costTotalUsd).dividedBy(line.quantityKg),
        referenceType: 'CREDIT_NOTE',
        referenceId: note.id,
        transactionDate: note.creditDate,
        createdById: params.userId,
        notes: `Credit note ${note.creditNoteNumber}`,
      });
    }

    const party =
      note.type === 'CUSTOMER'
        ? resolveSubledgerLeg({
            partyCurrency: note.customer!.primaryCurrency,
            voucherCurrency: note.currency,
            voucherAmount: note.totalAmount,
            voucherRateToUsd: note.rateToUsd,
            voucherAmountUsd: note.totalAmountUsd,
            localCurrency: company.localCurrency,
            rateLocalPerUsd: note.rateLocalPerUsd,
            partyLabel: note.customer!.customerName,
          })
        : resolveSubledgerLeg({
            partyCurrency: note.vendor!.primaryCurrency,
            voucherCurrency: note.currency,
            voucherAmount: note.totalAmount,
            voucherRateToUsd: note.rateToUsd,
            voucherAmountUsd: note.totalAmountUsd,
            localCurrency: company.localCurrency,
            rateLocalPerUsd: note.rateLocalPerUsd,
            partyLabel: note.vendor!.vendorName,
          });

    const costUsd = toMoney(note.costOfGoodsUsd);
    const hasReturn = costUsd.greaterThan('0.005');

    const lines =
      note.type === 'CUSTOMER'
        ? [
            // Contra-revenue, so credits stay visible instead of being netted
            // into sales and quietly flattering the top line.
            {
              accountKey: ACCOUNT_KEYS.SALES_RETURNS,
              direction: 'DEBIT' as const,
              currency: note.currency,
              // Net: the tax charged on the original supply is given back to
              // the authority on the line below, not taken out of revenue.
              amount: note.subtotalAmount,
              rateToUsd: note.rateToUsd,
              description: `Credit note ${note.creditNoteNumber} — ${note.reason}`,
              customerId: note.customerId,
            },
            ...(dec(note.taxAmount).greaterThan(0)
              ? [
                  {
                    accountKey: ACCOUNT_KEYS.VAT_OUTPUT,
                    direction: 'DEBIT' as const,
                    currency: note.currency,
                    amount: note.taxAmount,
                    rateToUsd: note.rateToUsd,
                    description: `Output tax credited on ${note.creditNoteNumber}`,
                    customerId: note.customerId,
                  },
                ]
              : []),
            {
              accountKey: ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE,
              direction: 'CREDIT' as const,
              currency: party.currency,
              amount: party.amount,
              rateToUsd: party.rateToUsd,
              description: `Credit to ${note.customer!.customerName}`,
              customerId: note.customerId,
            },
            ...(hasReturn
              ? [
                  {
                    accountKey: ACCOUNT_KEYS.INVENTORY,
                    direction: 'DEBIT' as const,
                    currency: 'USD',
                    amount: costUsd,
                    rateToUsd: 1,
                    description: `Coffee returned on ${note.creditNoteNumber}`,
                  },
                  {
                    accountKey: ACCOUNT_KEYS.COST_OF_GOODS_SOLD,
                    direction: 'CREDIT' as const,
                    currency: 'USD',
                    amount: costUsd,
                    rateToUsd: 1,
                    description: `Cost of sale reversed on ${note.creditNoteNumber}`,
                  },
                ]
              : []),
          ]
        : [
            {
              accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
              direction: 'DEBIT' as const,
              currency: party.currency,
              amount: party.amount,
              rateToUsd: party.rateToUsd,
              description: `Credit from ${note.vendor!.vendorName}`,
              vendorId: note.vendorId,
            },
            {
              accountKey: ACCOUNT_KEYS.PURCHASE_RETURNS,
              direction: 'CREDIT' as const,
              currency: note.currency,
              amount: note.subtotalAmount,
              rateToUsd: note.rateToUsd,
              description: `Supplier credit ${note.creditNoteNumber} — ${note.reason}`,
              vendorId: note.vendorId,
            },
            ...(dec(note.taxAmount).greaterThan(0)
              ? [
                  {
                    accountKey: ACCOUNT_KEYS.VAT_INPUT,
                    direction: 'CREDIT' as const,
                    currency: note.currency,
                    amount: note.taxAmount,
                    rateToUsd: note.rateToUsd,
                    description: `Input tax reversed on ${note.creditNoteNumber}`,
                    vendorId: note.vendorId,
                  },
                ]
              : []),
          ];

    await postJournalEntry(tx, {
      companyId: params.companyId,
      entryDate: note.creditDate,
      description: `Credit note ${note.creditNoteNumber}`,
      sourceType: 'CREDIT_NOTE',
      sourceId: note.id,
      createdById: params.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: note.rateLocalPerUsd,
      lines,
    });

    const posted = await tx.creditNote.update({
      where: { id: note.id },
      data: { status: 'POSTED', postedAt: new Date(), postedById: params.userId },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'CREDIT_NOTE_POSTED',
      entityType: 'CreditNote',
      entityId: note.id,
      before: { status: 'DRAFT' },
      after: { status: 'POSTED', total: note.totalAmount.toString(), returnedCost: costUsd.toString() },
    });

    return posted;
  });
}

export async function reverseCreditNote(params: {
  id: string;
  companyId: string;
  userId: string;
  reason: string;
}) {
  return transaction(async (tx) => {
    const note = await tx.creditNote.findFirst({
      where: { id: params.id, companyId: params.companyId },
      include: { lines: true },
    });
    if (!note) throw new NotFoundError('Credit note');
    if (note.status !== 'POSTED') {
      throw new BusinessRuleError('Only a posted credit note can be reversed.');
    }
    if (!params.reason.trim()) {
      throw new BusinessRuleError('A reason is required to reverse a credit note.');
    }

    // Stock first, and before the journal, so a reversal that cannot be made
    // physically is refused before anything moves in the ledger.
    //
    // Reversing a credit note that brought coffee back has to take that coffee
    // out again: leaving it on the shelf while the accounting says it was never
    // returned puts the inventory account and the stock ledger out of step, and
    // the reconciliation report would report it — correctly — as a break.
    //
    // consumeStock rather than a blind adjustment: if the returned coffee has
    // since been sold on, there is nothing left to take back and the reversal
    // must fail loudly rather than drive the batch negative.
    for (const line of note.lines) {
      if (!line.batchId || !line.warehouseId || dec(line.quantityKg).lessThanOrEqualTo(0)) continue;
      await consumeStock(tx, {
        companyId: params.companyId,
        batchId: line.batchId,
        warehouseId: line.warehouseId,
        quantityKg: line.quantityKg,
        bags: line.bags,
        referenceType: 'CREDIT_NOTE_REVERSAL',
        referenceId: note.id,
        transactionDate: new Date(),
        createdById: params.userId,
        notes: `Reversal of credit note ${note.creditNoteNumber}`,
      });
    }

    // One date for both, so the reversal's ledger entry and the `reversedAt`
    // stamp can never land on opposite sides of a period end.
    const reversalDate = new Date();

    await reverseJournalEntry(tx, {
      companyId: params.companyId,
      sourceType: 'CREDIT_NOTE',
      sourceId: note.id,
      entryDate: reversalDate,
      createdById: params.userId,
      reason: params.reason.trim(),
    });

    const updated = await tx.creditNote.update({
      where: { id: note.id },
      data: { status: 'REVERSED', reversedAt: reversalDate, reversalReason: params.reason.trim() },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'CREDIT_NOTE_REVERSED',
      entityType: 'CreditNote',
      entityId: note.id,
      after: { status: 'REVERSED', reason: params.reason },
    });

    return updated;
  });
}
