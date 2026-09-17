import type { Tx } from '@/lib/db';
import { transaction } from '@/lib/db';
import { Decimal, dec, toMoney, convertToUsd, convertFromUsd, sum } from '@/lib/money';
import { ACCOUNT_KEYS, DOC_TYPES } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { postJournalEntry, reverseJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { resolveSubledgerLeg } from '@/lib/services/subledger';
import type { PaymentMethod } from '@prisma/client';
import { writeAudit } from '@/lib/services/audit';

/**
 * ReceiptService — money in from customers.
 *
 * This is where the multi-currency rules bite hardest. A Dubai customer owes
 * USD but settles in AED. The receipt permanently records all three views:
 *
 *   amount        AED 100,000.0000   what actually landed in the bank
 *   rateToUsd     3.67800000         the rate agreed on the day
 *   amountUsd     USD  27,188.6895   what the customer's ledger is credited
 *
 * Because the rate lives on the voucher, editing the default rate table
 * tomorrow cannot restate this receipt — the historical ledger is immutable.
 */

export type ReceiptAllocationInput = {
  salesInvoiceId: string;
  /** Amount in the invoice's own currency. */
  amount: string | number;
};

export type ChequeDetailsInput = {
  chequeNumber: string;
  chequeDate: Date;
  /** Known for a cheque we are holding; often not for one an agent took. */
  bankName?: string | null;
  beneficiary?: string | null;
  agentId?: string | null;
  receivedDate?: Date | null;
  notes?: string | null;
};

export type ReceiptInput = {
  companyId: string;
  receiptDate: Date;
  customerId: string;
  currency: string;
  amount: string | number;
  rateToUsd?: string | number;
  /**
   * The USD value the parties agreed for this specific receipt. Dubai customers
   * settle USD invoices in AED at a rate negotiated per payment, so the user may
   * enter the USD equivalent directly instead of a rate; the rate is then
   * derived from it and stored on the voucher.
   */
  usdEquivalent?: string | number | null;
  rateLocalPerUsd: string | number;
  paymentMethod?: PaymentMethod;
  /** Required for cash and bank transfers; optional until a cheque is deposited. */
  cashBankAccountId?: string | null;
  /** The collection agent, when the customer paid him rather than the company. */
  agentId?: string | null;
  cheque?: ChequeDetailsInput | null;
  shipmentId?: string | null;
  reference?: string | null;
  description?: string | null;
  allocations?: ReceiptAllocationInput[];
};

/** Outstanding on one invoice, in the invoice currency and in USD. */
export async function getInvoiceOutstanding(
  tx: Tx,
  invoiceId: string,
): Promise<{ amount: Decimal; amountUsd: Decimal; currency: string }> {
  const invoice = await tx.salesInvoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { totalAmount: true, totalAmountUsd: true, currency: true },
  });

  const rows = await tx.$queryRaw<Array<{ amount: string | null; amountUsd: string | null }>>`
    SELECT COALESCE(SUM(ra."amount"), 0)::text AS amount,
           COALESCE(SUM(ra."amountUsd"), 0)::text AS "amountUsd"
    FROM receipt_allocations ra
    JOIN receipts r ON r."id" = ra."receiptId"
    WHERE ra."salesInvoiceId" = ${invoiceId} AND r."status" = 'POSTED'
      AND NOT EXISTS (
        SELECT 1 FROM cheques ch
        WHERE ch."receiptId" = r."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
      )
  `;

  const credits = await tx.$queryRaw<Array<{ amount: string | null; amountUsd: string | null }>>`
    SELECT COALESCE(SUM(cn."totalAmount"), 0)::text AS amount,
           COALESCE(SUM(cn."totalAmountUsd"), 0)::text AS "amountUsd"
    FROM credit_notes cn
    WHERE cn."salesInvoiceId" = ${invoiceId} AND cn."status" = 'POSTED'
  `;

  const settled = dec(rows[0]?.amount ?? 0).plus(credits[0]?.amount ?? 0);
  const settledUsd = dec(rows[0]?.amountUsd ?? 0).plus(credits[0]?.amountUsd ?? 0);

  return {
    amount: toMoney(dec(invoice.totalAmount).minus(settled)),
    amountUsd: toMoney(dec(invoice.totalAmountUsd).minus(settledUsd)),
    currency: invoice.currency,
  };
}

async function buildAllocations(
  tx: Tx,
  params: {
    companyId: string;
    customerId: string;
    receiptAmount: Decimal;
    receiptCurrency: string;
    receiptRateToUsd: Decimal;
    allocations: ReceiptAllocationInput[];
  },
) {
  const rows: Array<{ salesInvoiceId: string; amount: Decimal; amountUsd: Decimal; currency: string }> = [];

  for (const alloc of params.allocations) {
    const invoice = await tx.salesInvoice.findFirst({
      where: { id: alloc.salesInvoiceId, companyId: params.companyId },
      select: { id: true, invoiceNumber: true, customerId: true, status: true, currency: true, rateToUsd: true },
    });
    if (!invoice) throw new NotFoundError('Sales invoice in allocation');
    if (invoice.customerId !== params.customerId) {
      throw new BusinessRuleError(`Invoice ${invoice.invoiceNumber} belongs to a different customer.`);
    }
    if (invoice.status !== 'POSTED') {
      throw new BusinessRuleError(`Invoice ${invoice.invoiceNumber} is not posted and cannot be settled.`);
    }

    const amount = toMoney(alloc.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(`Allocation to ${invoice.invoiceNumber} must be greater than zero.`);
    }

    const outstanding = await getInvoiceOutstanding(tx, invoice.id);
    if (amount.greaterThan(outstanding.amount)) {
      throw new BusinessRuleError(
        `Allocation of ${invoice.currency} ${amount.toFixed(2)} exceeds the ${outstanding.amount.toFixed(2)} still outstanding on ${invoice.invoiceNumber}.`,
      );
    }

    // The allocation is converted to USD at the INVOICE's rate so that settling
    // an invoice in full always clears exactly its USD value, leaving no
    // phantom residue caused by a different rate on the receipt.
    const amountUsd = convertToUsd(amount, invoice.rateToUsd, invoice.currency);
    rows.push({ salesInvoiceId: invoice.id, amount, amountUsd, currency: invoice.currency });
  }

  // Can the money cover what it is put against? Asked in the receipt's own
  // currency. It used to be asked in USD, so a MAD invoice booked at 9.60 and
  // paid in full in MAD on a day the rate was 9.85 was refused — the same
  // dirhams were "worth less" — and the customer could not be marked paid.
  const settledInVoucher = toMoney(
    sum(
      rows.map((r) =>
        r.currency === params.receiptCurrency
          ? r.amount
          : convertFromUsd(r.amountUsd, params.receiptRateToUsd, params.receiptCurrency),
      ),
    ),
  );
  if (settledInVoucher.greaterThan(params.receiptAmount.plus('0.005'))) {
    throw new BusinessRuleError(
      `Allocations total ${params.receiptCurrency} ${settledInVoucher.toFixed(2)} but the receipt is only ${params.receiptCurrency} ${params.receiptAmount.toFixed(2)}.`,
    );
  }

  return rows.map((row) => {
    const { currency, ...rest } = row;
    void currency;
    return rest;
  });
}

export function computeReceiptAmounts(input: {
  amount: string | number;
  currency: string;
  rateToUsd?: string | number;
  usdEquivalent?: string | number | null;
  localCurrency: string;
  rateLocalPerUsd: string | number;
}) {
  const currency = input.currency.toUpperCase();
  const amount = toMoney(input.amount);

  if (amount.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('The receipt amount must be greater than zero.');
  }

  let rateToUsd: Decimal;
  let amountUsd: Decimal;

  const statedUsd =
    input.usdEquivalent === undefined || input.usdEquivalent === null || input.usdEquivalent === ''
      ? null
      : toMoney(input.usdEquivalent);

  if (currency === 'USD') {
    rateToUsd = new Decimal(1);
    amountUsd = amount;
  } else if (statedUsd && statedUsd.greaterThan(0)) {
    // The user stated the USD value for this payment; derive the rate from it
    // so the voucher records exactly what was agreed.
    amountUsd = statedUsd;
    rateToUsd = dec(amount.dividedBy(amountUsd)).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
  } else {
    rateToUsd = dec(input.rateToUsd ?? 0);
    if (rateToUsd.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(
        `Enter either an exchange rate or a USD equivalent for this ${currency} receipt.`,
      );
    }
    amountUsd = convertToUsd(amount, rateToUsd, currency);
  }

  // When the voucher is already in the company's own currency, the local rate
  // must be the voucher's own rate — otherwise the local ledger would show a
  // different figure from the cash that actually moved.
  const effectiveLocalRate = currency === input.localCurrency.toUpperCase() ? rateToUsd : dec(input.rateLocalPerUsd);
  const amountLocal =
    currency === input.localCurrency.toUpperCase()
      ? amount
      : convertFromUsd(amountUsd, effectiveLocalRate, input.localCurrency);

  return { currency, amount, rateToUsd, amountUsd, rateLocalPerUsd: effectiveLocalRate, amountLocal };
}

async function assertAccountCurrencyMatches(tx: Tx, companyId: string, cashBankAccountId: string, currency: string) {
  const account = await tx.cashBankAccount.findFirst({
    where: { id: cashBankAccountId, companyId },
    select: { currency: true, name: true, status: true },
  });
  if (!account) throw new NotFoundError('Cash/bank account');
  if (account.status !== 'ACTIVE') {
    throw new BusinessRuleError(`${account.name} is inactive and cannot be used.`);
  }
  if (account.currency.toUpperCase() !== currency.toUpperCase()) {
    throw new BusinessRuleError(
      `${account.name} is a ${account.currency} account, so it cannot receive a ${currency} amount.`,
    );
  }
  return account;
}

/**
 * Cash and bank transfers must name the account the money landed in. A cheque
 * does not: it is an instrument sitting in the drawer until it is deposited, so
 * the bank account is chosen later, when the cheque is banked.
 */
async function validateSettlement(tx: Tx, input: ReceiptInput) {
  const method = input.paymentMethod ?? 'BANK_TRANSFER';

  if (method === 'CHEQUE') {
    if (!input.cheque?.chequeNumber?.trim()) {
      throw new BusinessRuleError('A cheque number is required for a cheque receipt.');
    }
    if (!input.cheque?.bankName?.trim()) {
      throw new BusinessRuleError('The drawee bank is required for a cheque receipt.');
    }
    return method;
  }

  /*
   * An agent collection names an agent, not an account.
   *
   * The customer has paid; the company has not been paid. The money is with
   * the agent until he hands it over, so there is no cash or bank account to
   * choose — asking for one, and crediting it, would state money the company
   * does not have and would leave nothing anywhere saying who is holding it.
   */
  if (method === 'AGENT_COLLECTION') {
    if (!input.agentId) {
      throw new BusinessRuleError('Choose the agent who collected this money.');
    }
    const agent = await tx.agent.findFirst({
      where: { id: input.agentId, companyId: input.companyId },
      select: { id: true, status: true, agentName: true },
    });
    if (!agent) throw new NotFoundError('Agent');
    if (agent.status !== 'ACTIVE') {
      throw new BusinessRuleError(`${agent.agentName} is inactive and cannot collect on the company's behalf.`);
    }
    return method;
  }

  if (!input.cashBankAccountId) {
    throw new BusinessRuleError('Choose the cash or bank account the money was received into.');
  }
  await assertAccountCurrencyMatches(tx, input.companyId, input.cashBankAccountId, input.currency);
  return method;
}

async function lockSalesInvoices(tx: Tx, invoiceIds: string[]) {
  for (const id of [...new Set(invoiceIds)].sort()) {
    await tx.$queryRaw`SELECT "id" FROM sales_invoices WHERE "id" = ${id} FOR UPDATE`;
  }
}

async function cancelLinkedCheque(tx: Tx, params: { receiptId?: string; paymentId?: string; userId: string }) {
  const existing = await tx.cheque.findFirst({
    where: params.receiptId ? { receiptId: params.receiptId } : { paymentId: params.paymentId },
  });
  if (!existing) return;
  if (existing.status === 'CLEARED' || existing.status === 'CANCELLED') return;
  if (existing.status !== 'RECEIVED' && existing.status !== 'DEPOSITED' && existing.status !== 'BOUNCED') return;

  await tx.cheque.update({
    where: { id: existing.id },
    data: { status: 'CANCELLED' },
  });
  await tx.chequeStatusHistory.create({
    data: {
      chequeId: existing.id,
      fromStatus: existing.status,
      toStatus: 'CANCELLED',
      changedById: params.userId,
      notes: 'Cancelled with the reversed voucher — the journal already unwound Cheques on Hand.',
    },
  });
}

async function syncDraftCheque(
  tx: Tx,
  params: {
    companyId: string;
    receiptId: string;
    customerId: string;
    userId: string;
    method: PaymentMethod;
    /** The agent on the receipt, when he is the one who collected. */
    agentId: string | null;
    cheque: ChequeDetailsInput | null | undefined;
    amounts: {
      amount: Decimal;
      currency: string;
      rateToUsd: Decimal;
      amountUsd: Decimal;
      rateLocalPerUsd: Decimal;
      amountLocal: Decimal;
    };
    cashBankAccountId: string | null;
    receiptDate: Date;
  },
) {
  const existing = await tx.cheque.findFirst({ where: { receiptId: params.receiptId } });

  /*
   * A cheque the agent is holding is still a cheque.
   *
   * The customer hands the agent a cheque in the agent's name; it has a
   * number, a date, a bank and a life of its own, and it can bounce. Recording
   * the collection without recording the instrument lost all of that — there
   * was nothing to mark pending, cleared or bounced, and no way to answer
   * "which cheque was that?". The money still sits in agent clearing rather
   * than in cheques on hand, because it is the agent who is holding it.
   */
  const carriesCheque = params.method === 'CHEQUE' || params.method === 'AGENT_COLLECTION';

  if (!carriesCheque) {
    if (existing && existing.status === 'RECEIVED') {
      await tx.cheque.delete({ where: { id: existing.id } });
    }
    return;
  }

  // An agent collection need not be by cheque — he may have taken cash.
  if (!params.cheque) {
    if (existing && existing.status === 'RECEIVED') {
      await tx.cheque.delete({ where: { id: existing.id } });
    }
    return;
  }

  const data = {
    chequeNumber: params.cheque.chequeNumber.trim(),
    chequeDate: params.cheque.chequeDate,
    bankName: params.cheque.bankName?.trim() || null,
    amount: params.amounts.amount,
    currency: params.amounts.currency,
    rateToUsd: params.amounts.rateToUsd,
    amountUsd: params.amounts.amountUsd,
    rateLocalPerUsd: params.amounts.rateLocalPerUsd,
    amountLocal: params.amounts.amountLocal,
    beneficiary: params.cheque.beneficiary ?? null,
    customerId: params.customerId,
    // Who is holding the paper. On an agent collection it is the agent on
    // the receipt, which is the one the accounting already debits.
    agentId: params.agentId ?? params.cheque.agentId ?? null,
    // An agent's cheque has no bank of ours behind it yet: the money reaches
    // us when he settles, not when the cheque clears.
    cashBankAccountId: params.method === 'AGENT_COLLECTION' ? null : params.cashBankAccountId,
    receivedDate: params.cheque.receivedDate ?? params.receiptDate,
    notes: params.cheque.notes ?? null,
  };

  if (existing) {
    if (existing.status !== 'RECEIVED') {
      throw new BusinessRuleError('This receipt already has a cheque that has moved on from received, so the instrument cannot be rewritten.');
    }
    await tx.cheque.update({ where: { id: existing.id }, data });
    return;
  }

  await tx.cheque.create({
    data: {
      companyId: params.companyId,
      direction: 'INBOUND',
      receiptId: params.receiptId,
      status: 'RECEIVED',
      createdById: params.userId,
      statusHistory: {
        create: { fromStatus: null, toStatus: 'RECEIVED', changedById: params.userId, notes: 'Cheque received' },
      },
      ...data,
    },
  });
}

export async function createReceipt(input: ReceiptInput, userId: string) {
  return transaction((tx) => createReceiptIn(tx, input, userId));
}

/**
 * The body of createReceipt, for a caller that is already inside a
 * transaction — a cash sale raises its receipt in the same transaction as
 * the invoice, so the two post together or not at all.
 */
export async function createReceiptIn(tx: Tx, input: ReceiptInput, userId: string) {
  const company = await getCompanyContext(tx, input.companyId);
  const customer = await tx.customer.findFirst({
    where: { id: input.customerId, companyId: input.companyId },
    select: { id: true, customerName: true },
  });
  if (!customer) throw new NotFoundError('Customer');

  const method = await validateSettlement(tx, input);

  const amounts = computeReceiptAmounts({ ...input, localCurrency: company.localCurrency });
  const allocations = await buildAllocations(tx, {
    companyId: input.companyId,
    customerId: input.customerId,
    receiptAmount: amounts.amount,
    receiptCurrency: amounts.currency,
    receiptRateToUsd: amounts.rateToUsd,
    allocations: input.allocations ?? [],
  });

  const receiptNumber = await nextReference(tx, {
    companyId: input.companyId,
    docType: DOC_TYPES.RECEIPT,
  });

  const receipt = await tx.receipt.create({
    data: {
      companyId: input.companyId,
      receiptNumber,
      receiptDate: input.receiptDate,
      customerId: input.customerId,
      currency: amounts.currency,
      amount: amounts.amount,
      rateToUsd: amounts.rateToUsd,
      amountUsd: amounts.amountUsd,
      rateLocalPerUsd: amounts.rateLocalPerUsd,
      amountLocal: amounts.amountLocal,
      cashBankAccountId: input.cashBankAccountId ?? null,
      agentId: input.agentId ?? null,
      paymentMethod: method,
      shipmentId: input.shipmentId ?? null,
      reference: input.reference ?? null,
      description: input.description ?? null,
      status: 'DRAFT',
      createdById: userId,
      allocations: { create: allocations },
    },
    include: { allocations: true },
  });

  await syncDraftCheque(tx, {
    companyId: input.companyId,
    receiptId: receipt.id,
    customerId: input.customerId,
    userId,
    method,
    agentId: input.agentId ?? null,
    cheque: input.cheque,
    amounts,
    cashBankAccountId: input.cashBankAccountId ?? null,
    receiptDate: input.receiptDate,
  });

  await writeAudit(tx, {
    companyId: input.companyId,
    userId,
    action: 'RECEIPT_CREATED',
    entityType: 'Receipt',
    entityId: receipt.id,
    after: {
      receiptNumber,
      customer: customer.customerName,
      amount: amounts.amount,
      currency: amounts.currency,
      rateToUsd: amounts.rateToUsd,
      amountUsd: amounts.amountUsd,
    },
  });

  return receipt;
}

export async function updateReceipt(id: string, input: ReceiptInput, userId: string) {
  return transaction(async (tx) => {
    const existing = await tx.receipt.findFirst({ where: { id, companyId: input.companyId } });
    if (!existing) throw new NotFoundError('Receipt');
    if (existing.status !== 'DRAFT') {
      throw new BusinessRuleError('Only draft receipts can be edited. Reverse the receipt to correct a posted one.');
    }

    const company = await getCompanyContext(tx, input.companyId);
    const method = await validateSettlement(tx, input);

    const amounts = computeReceiptAmounts({ ...input, localCurrency: company.localCurrency });
    const allocations = await buildAllocations(tx, {
      companyId: input.companyId,
      customerId: input.customerId,
      receiptAmount: amounts.amount,
      receiptCurrency: amounts.currency,
      receiptRateToUsd: amounts.rateToUsd,
      allocations: input.allocations ?? [],
    });

    await tx.receiptAllocation.deleteMany({ where: { receiptId: id } });

    const receipt = await tx.receipt.update({
      where: { id },
      data: {
        receiptDate: input.receiptDate,
        customerId: input.customerId,
        currency: amounts.currency,
        amount: amounts.amount,
        rateToUsd: amounts.rateToUsd,
        amountUsd: amounts.amountUsd,
        rateLocalPerUsd: amounts.rateLocalPerUsd,
        amountLocal: amounts.amountLocal,
        cashBankAccountId: input.cashBankAccountId ?? null,
        agentId: input.agentId ?? null,
        paymentMethod: method,
        shipmentId: input.shipmentId ?? null,
        reference: input.reference ?? null,
        description: input.description ?? null,
        allocations: { create: allocations },
      },
      include: { allocations: true },
    });

    await syncDraftCheque(tx, {
      companyId: input.companyId,
      receiptId: id,
      customerId: input.customerId,
      userId,
      method,
      agentId: input.agentId ?? null,
      cheque: input.cheque,
      amounts,
      cashBankAccountId: input.cashBankAccountId ?? null,
      receiptDate: input.receiptDate,
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'RECEIPT_UPDATED',
      entityType: 'Receipt',
      entityId: id,
      before: { amount: existing.amount, currency: existing.currency, rateToUsd: existing.rateToUsd },
      after: { amount: receipt.amount, currency: receipt.currency, rateToUsd: receipt.rateToUsd },
    });

    return receipt;
  });
}

export async function postReceipt(params: { id: string; companyId: string; userId: string }) {
  return transaction((tx) => postReceiptIn(tx, params));
}

/** The body of postReceipt, for a caller already inside a transaction. */
export async function postReceiptIn(tx: Tx, params: { id: string; companyId: string; userId: string }) {
  const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status"::text FROM receipts
    WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
    FOR UPDATE
  `;
  if (locked.length === 0) throw new NotFoundError('Receipt');
  if (locked[0].status !== 'DRAFT') {
    throw new BusinessRuleError(`This receipt is already ${locked[0].status.toLowerCase()} and cannot be posted again.`);
  }

  const receipt = await tx.receipt.findUniqueOrThrow({
    where: { id: params.id },
    include: {
      customer: true,
      cashBankAccount: true,
      agent: { select: { agentName: true } },
      allocations: { include: { salesInvoice: true } },
    },
  });

  // A cheque is held, not banked; an agent collection is held by the agent.
  // Neither names an account, and neither should.
  const needsAccount = receipt.paymentMethod !== 'CHEQUE' && receipt.paymentMethod !== 'AGENT_COLLECTION';
  if (needsAccount && !receipt.cashBankAccountId) {
    throw new BusinessRuleError('This receipt has no cash or bank account and cannot be posted.');
  }
  if (receipt.paymentMethod === 'AGENT_COLLECTION' && !receipt.agentId) {
    throw new BusinessRuleError('This receipt was collected by an agent, but no agent is named on it.');
  }
  const company = await getCompanyContext(tx, params.companyId);

  await lockSalesInvoices(tx, receipt.allocations.map((alloc) => alloc.salesInvoiceId));

  // Re-validate allocations under the lock: an invoice may have been settled
  // by another receipt while this one sat in draft.
  for (const alloc of receipt.allocations) {
    const outstanding = await getInvoiceOutstanding(tx, alloc.salesInvoiceId);
    if (dec(alloc.amount).greaterThan(outstanding.amount)) {
      throw new BusinessRuleError(
        `Invoice ${alloc.salesInvoice.invoiceNumber} now has only ${outstanding.currency} ${outstanding.amount.toFixed(2)} outstanding, which is less than the ${dec(alloc.amount).toFixed(2)} allocated here.`,
      );
    }
  }

  // Each invoice is cleared at the value it was booked at — in USD and in the
  // company's own currency — so settling an invoice in full always clears it
  // exactly, whatever today's rate says the money is worth. The difference
  // between that and the money line is a realised exchange gain or loss,
  // which the posting engine books on its own.
  //
  // This replaces a split done in USD, which for a MAD customer paying a MAD
  // invoice on a day the rate had moved credited part of the dirhams to
  // "Customer Advances" and left the rest of the invoice showing as owed.
  // The customer's ledger is kept in one currency — theirs — so the line is
  // stated in that currency at the invoice's own rate, exactly as the invoice
  // was when it was raised. Same rule as the accrual, same rule everywhere.
  const localCode = company.localCurrency.toUpperCase();
  const settlementLines = receipt.allocations.map((allocation) => {
    const invoice = allocation.salesInvoice;
    const bookedUsd = toMoney(allocation.amountUsd);
    const bookedLocal =
      invoice.currency === localCode
        ? toMoney(allocation.amount)
        : convertFromUsd(bookedUsd, invoice.rateLocalPerUsd, localCode);
    const leg = resolveSubledgerLeg({
      partyCurrency: receipt.customer.primaryCurrency,
      voucherCurrency: invoice.currency,
      voucherAmount: toMoney(allocation.amount),
      voucherRateToUsd: invoice.rateToUsd,
      voucherAmountUsd: bookedUsd,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: invoice.rateLocalPerUsd,
      partyLabel: receipt.customer.customerName,
    });
    return {
      accountKey: ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE,
      direction: 'CREDIT' as const,
      currency: leg.currency,
      amount: leg.amount,
      rateToUsd: leg.rateToUsd,
      bookedUsd,
      bookedLocal,
      description: `Settles ${invoice.invoiceNumber}`,
      customerId: receipt.customerId,
      salesInvoiceId: invoice.id,
      shipmentId: receipt.shipmentId,
    };
  });

  // Money that has not been put against an invoice is not a settlement — it
  // is an advance the company owes the customer until it is allocated. Left
  // on Accounts Receivable it would show as a negative debtor, which is both
  // wrong on the balance sheet and invisible as a liability. Measured in the
  // receipt's own currency: dirhams received less dirhams applied.
  const settledInVoucher = toMoney(
    sum(
      receipt.allocations.map((allocation) =>
        allocation.salesInvoice.currency === receipt.currency
          ? dec(allocation.amount)
          : convertFromUsd(allocation.amountUsd, receipt.rateToUsd, receipt.currency),
      ),
    ),
  );
  const unallocated = toMoney(dec(receipt.amount).minus(settledInVoucher));
  const hasAdvance = unallocated.greaterThan('0.005');

  const advanceLines = hasAdvance
    ? (() => {
        const advance = resolveSubledgerLeg({
          partyCurrency: receipt.customer.primaryCurrency,
          voucherCurrency: receipt.currency,
          voucherAmount: unallocated,
          voucherRateToUsd: receipt.rateToUsd,
          voucherAmountUsd: convertToUsd(unallocated, receipt.rateToUsd, receipt.currency),
          localCurrency: company.localCurrency,
          rateLocalPerUsd: receipt.rateLocalPerUsd,
          partyLabel: receipt.customer.customerName,
        });
        return [
          {
            accountKey: ACCOUNT_KEYS.CUSTOMER_ADVANCES,
            direction: 'CREDIT' as const,
            currency: advance.currency,
            amount: advance.amount,
            rateToUsd: advance.rateToUsd,
            description: `Advance from ${receipt.customer.customerName}, not yet applied to an invoice`,
            customerId: receipt.customerId,
            shipmentId: receipt.shipmentId,
          },
        ];
      })()
    : [];

  const creditLines = [...settlementLines, ...advanceLines];

  await postJournalEntry(tx, {
    companyId: params.companyId,
    entryDate: receipt.receiptDate,
    description: `Receipt ${receipt.receiptNumber} — ${receipt.customer.customerName}`,
    sourceType: 'RECEIPT',
    sourceId: receipt.id,
    createdById: params.userId,
    localCurrency: company.localCurrency,
    rateLocalPerUsd: receipt.rateLocalPerUsd,
    lines: [
      receipt.paymentMethod === 'AGENT_COLLECTION'
        ? {
            // Not cash, not bank, and not a cheque the company is holding —
            // the agent is holding it. An asset owed by him until he pays.
            accountKey: ACCOUNT_KEYS.AGENT_CLEARING,
            direction: 'DEBIT' as const,
            currency: receipt.currency,
            amount: receipt.amount,
            rateToUsd: receipt.rateToUsd,
            description: `Collected by ${receipt.agent?.agentName ?? 'agent'}, not yet handed over`,
            customerId: receipt.customerId,
            agentId: receipt.agentId,
            shipmentId: receipt.shipmentId,
          }
        : receipt.paymentMethod === 'CHEQUE'
        ? {
            accountKey: ACCOUNT_KEYS.CHEQUES_ON_HAND,
            direction: 'DEBIT' as const,
            currency: receipt.currency,
            amount: receipt.amount,
            rateToUsd: receipt.rateToUsd,
            description: 'Cheque received, not yet cleared',
            customerId: receipt.customerId,
            shipmentId: receipt.shipmentId,
          }
        : {
            cashBankAccountId: receipt.cashBankAccountId!,
            direction: 'DEBIT' as const,
            currency: receipt.currency,
            amount: receipt.amount,
            rateToUsd: receipt.rateToUsd,
            description: `Received into ${receipt.cashBankAccount?.name ?? 'cash/bank'}`,
            customerId: receipt.customerId,
            shipmentId: receipt.shipmentId,
          },
      ...creditLines,
    ],
  });

  const posted = await tx.receipt.update({
    where: { id: receipt.id },
    data: { status: 'POSTED', postedAt: new Date() },
  });

  await writeAudit(tx, {
    companyId: params.companyId,
    userId: params.userId,
    action: 'RECEIPT_POSTED',
    entityType: 'Receipt',
    entityId: receipt.id,
    before: { status: 'DRAFT' },
    after: {
      status: 'POSTED',
      amount: receipt.amount,
      currency: receipt.currency,
      rateToUsd: receipt.rateToUsd,
      amountUsd: receipt.amountUsd,
    },
  });

  return posted;
}

export async function reverseReceipt(params: { id: string; companyId: string; userId: string; reason: string }) {
  return transaction((tx) => reverseReceiptIn(tx, params));
}

export async function reverseReceiptIn(
  tx: Tx,
  params: { id: string; companyId: string; userId: string; reason: string },
) {
  const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status"::text FROM receipts
    WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
    FOR UPDATE
  `;
  if (locked.length === 0) throw new NotFoundError('Receipt');
  if (locked[0].status !== 'POSTED') throw new BusinessRuleError('Only a posted receipt can be reversed.');

  const reversalDate = new Date();

  await reverseJournalEntry(tx, {
    companyId: params.companyId,
    sourceType: 'RECEIPT',
    sourceId: params.id,
    createdById: params.userId,
    entryDate: reversalDate,
    reason: params.reason,
  });

  await cancelLinkedCheque(tx, { receiptId: params.id, userId: params.userId });

  const reversed = await tx.receipt.update({
    where: { id: params.id },
    data: { status: 'REVERSED', reversedAt: reversalDate, reversalReason: params.reason },
  });

  await writeAudit(tx, {
    companyId: params.companyId,
    userId: params.userId,
    action: 'RECEIPT_REVERSED',
    entityType: 'Receipt',
    entityId: params.id,
    before: { status: 'POSTED' },
    after: { status: 'REVERSED', reason: params.reason },
  });

  return reversed;
}

export async function deleteDraftReceipt(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const receipt = await tx.receipt.findFirst({ where: { id: params.id, companyId: params.companyId } });
    if (!receipt) throw new NotFoundError('Receipt');
    if (receipt.status !== 'DRAFT') {
      throw new BusinessRuleError('Only draft receipts can be deleted. Posted receipts must be reversed.');
    }
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'RECEIPT_DELETED',
      entityType: 'Receipt',
      entityId: receipt.id,
      before: { receiptNumber: receipt.receiptNumber, amount: receipt.amount },
    });
    await tx.receipt.delete({ where: { id: params.id } });
  });
}
