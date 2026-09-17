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
import { supplierGrossPayable } from '@/lib/services/tax';

/**
 * PaymentService — money out to vendors. The mirror image of ReceiptService:
 * payments are allocated against purchase contracts rather than invoices, and
 * the vendor's payable is relieved in the vendor's own ledger currency.
 */

export type PaymentAllocationInput = {
  /**
   * What is being settled. A payment pays down the coffee itself or a cost
   * booked against the supplier — freight, clearing, inspection — and exactly
   * one of these names the document.
   */
  purchaseContractId?: string | null;
  expenseId?: string | null;
  /** Amount in the document's own currency. */
  amount: string | number;
};

export type PaymentInput = {
  companyId: string;
  paymentDate: Date;
  /** Null when the payment settles accrued costs that were never put on a supplier's account. */
  vendorId: string | null;
  currency: string;
  amount: string | number;
  rateToUsd: string | number;
  rateLocalPerUsd: string | number;
  cashBankAccountId?: string | null;
  paymentMethod?: PaymentMethod;
  cheque?: {
    chequeNumber: string;
    chequeDate: Date;
    bankName: string;
    beneficiary?: string | null;
    notes?: string | null;
  } | null;
  shipmentId?: string | null;
  reference?: string | null;
  description?: string | null;
  allocations?: PaymentAllocationInput[];
};

/** Outstanding on one purchase contract, in the contract currency and in USD. */
export async function getContractOutstanding(
  tx: Tx,
  contractId: string,
): Promise<{ amount: Decimal; amountUsd: Decimal; currency: string }> {
  const contract = await tx.purchaseContract.findUniqueOrThrow({
    where: { id: contractId },
    select: {
      totalValue: true,
      totalValueUsd: true,
      taxAmount: true,
      taxAmountUsd: true,
      currency: true,
      status: true,
      vendor: { select: { country: true } },
      company: { select: { country: true } },
    },
  });

  const rows = await tx.$queryRaw<Array<{ amount: string | null; amountUsd: string | null }>>`
    SELECT COALESCE(SUM(pa."amount"), 0)::text AS amount,
           COALESCE(SUM(pa."amountUsd"), 0)::text AS "amountUsd"
    FROM payment_allocations pa
    JOIN payments p ON p."id" = pa."paymentId"
    WHERE pa."purchaseContractId" = ${contractId} AND p."status" = 'POSTED'
      AND NOT EXISTS (
        SELECT 1 FROM cheques ch
        WHERE ch."paymentId" = p."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
      )
  `;

  const credits = await tx.$queryRaw<Array<{ amount: string | null; amountUsd: string | null }>>`
    SELECT COALESCE(SUM(cn."totalAmount"), 0)::text AS amount,
           COALESCE(SUM(cn."totalAmountUsd"), 0)::text AS "amountUsd"
    FROM credit_notes cn
    WHERE cn."purchaseContractId" = ${contractId} AND cn."status" = 'POSTED'
  `;

  const payable = supplierGrossPayable({
    netAmount: contract.totalValue,
    taxAmount: contract.taxAmount,
    netAmountUsd: contract.totalValueUsd,
    taxAmountUsd: contract.taxAmountUsd,
    vendorCountry: contract.vendor.country,
    companyCountry: contract.company.country,
  });
  const gross = contract.status === 'POSTED' ? payable.amount : new Decimal(0);
  const grossUsd = contract.status === 'POSTED' ? payable.amountUsd : new Decimal(0);
  const settled = dec(rows[0]?.amount ?? 0).plus(credits[0]?.amount ?? 0);
  const settledUsd = dec(rows[0]?.amountUsd ?? 0).plus(credits[0]?.amountUsd ?? 0);

  return {
    amount: toMoney(gross.minus(settled)),
    amountUsd: toMoney(grossUsd.minus(settledUsd)),
    currency: contract.currency,
  };
}

/** Outstanding on one supplier-accrued cost, in its own currency and in USD. */
export async function getExpenseOutstanding(
  tx: Tx,
  expenseId: string,
): Promise<{ amount: Decimal; amountUsd: Decimal; currency: string }> {
  const expense = await tx.expense.findUniqueOrThrow({
    where: { id: expenseId },
    select: {
      amount: true,
      amountUsd: true,
      taxAmount: true,
      taxAmountUsd: true,
      currency: true,
      status: true,
      cashBankAccountId: true,
      payableToAgentId: true,
      vendorId: true,
      vendor: { select: { country: true } },
      company: { select: { country: true } },
    },
  });

  const rows = await tx.$queryRaw<Array<{ amount: string | null; amountUsd: string | null }>>`
    SELECT COALESCE(SUM(pa."amount"), 0)::text AS amount,
           COALESCE(SUM(pa."amountUsd"), 0)::text AS "amountUsd"
    FROM payment_allocations pa
    JOIN payments p ON p."id" = pa."paymentId"
    WHERE pa."expenseId" = ${expenseId} AND p."status" = 'POSTED'
      AND NOT EXISTS (
        SELECT 1 FROM cheques ch
        WHERE ch."paymentId" = p."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
      )
  `;

  const isUnpaidBill =
    expense.status === 'POSTED' && !expense.cashBankAccountId && !expense.payableToAgentId;
  const payable = supplierGrossPayable({
    netAmount: expense.amount,
    taxAmount: expense.taxAmount,
    netAmountUsd: expense.amountUsd,
    taxAmountUsd: expense.taxAmountUsd,
    vendorCountry: expense.vendor?.country,
    companyCountry: expense.company.country,
  });
  const gross = isUnpaidBill ? payable.amount : new Decimal(0);
  const grossUsd = isUnpaidBill ? payable.amountUsd : new Decimal(0);

  return {
    amount: toMoney(gross.minus(dec(rows[0]?.amount ?? 0))),
    amountUsd: toMoney(grossUsd.minus(dec(rows[0]?.amountUsd ?? 0))),
    currency: expense.currency,
  };
}

async function buildAllocations(
  tx: Tx,
  params: {
    companyId: string;
    vendorId: string | null;
    paymentAmount: Decimal;
    paymentCurrency: string;
    paymentRateToUsd: Decimal;
    allocations: PaymentAllocationInput[];
  },
) {
  const rows: Array<{
    purchaseContractId: string | null;
    expenseId: string | null;
    amount: Decimal;
    amountUsd: Decimal;
    currency: string;
  }> = [];

  for (const alloc of params.allocations) {
    if (Boolean(alloc.purchaseContractId) === Boolean(alloc.expenseId)) {
      throw new BusinessRuleError(
        'Each allocation settles one document — either a purchase contract or a cost owed to the supplier.',
      );
    }

    // Both kinds are read the same way: the document, who it belongs to, and
    // what is still owed on it.
    const document = alloc.purchaseContractId
      ? await (async () => {
          const contract = await tx.purchaseContract.findFirst({
            where: { id: alloc.purchaseContractId!, companyId: params.companyId },
            select: { id: true, contractNumber: true, vendorId: true, status: true, currency: true, rateToUsd: true },
          });
          if (!contract) throw new NotFoundError('Purchase contract in allocation');
          return {
            id: contract.id,
            label: `Contract ${contract.contractNumber}`,
            number: contract.contractNumber,
            vendorId: contract.vendorId,
            status: contract.status,
            currency: contract.currency,
            rateToUsd: contract.rateToUsd,
            outstanding: await getContractOutstanding(tx, contract.id),
            isContract: true,
          };
        })()
      : await (async () => {
          const expense = await tx.expense.findFirst({
            where: { id: alloc.expenseId!, companyId: params.companyId },
            select: {
              id: true,
              expenseNumber: true,
              vendorId: true,
              status: true,
              currency: true,
              rateToUsd: true,
              cashBankAccountId: true,
              payableToAgentId: true,
            },
          });
          if (!expense) throw new NotFoundError('Cost in allocation');
          if (expense.cashBankAccountId || expense.payableToAgentId) {
            throw new BusinessRuleError(
              `Cost ${expense.expenseNumber} is not unpaid, so a supplier payment cannot settle it.`,
            );
          }
          return {
            id: expense.id,
            label: `Cost ${expense.expenseNumber}`,
            number: expense.expenseNumber,
            vendorId: expense.vendorId,
            status: expense.status,
            currency: expense.currency,
            rateToUsd: expense.rateToUsd,
            outstanding: await getExpenseOutstanding(tx, expense.id),
            isContract: false,
          };
        })();

    if (document.vendorId && document.vendorId !== params.vendorId) {
      throw new BusinessRuleError(
        params.vendorId
          ? `${document.label} belongs to a different vendor.`
          : `${document.label} is on a supplier's account, so the payment has to name that supplier.`,
      );
    }
    // The other way round: a cost booked to nobody sits in Accrued Expenses,
    // and paying it through a supplier would relieve that supplier's account
    // for a bill that was never on it.
    if (!document.vendorId && params.vendorId && !document.isContract) {
      throw new BusinessRuleError(
        `${document.label} was booked without a supplier. Pay it from the cost itself, not through a supplier payment.`,
      );
    }
    if (document.status !== 'POSTED') {
      throw new BusinessRuleError(`${document.label} is not posted and cannot be settled.`);
    }

    const amount = toMoney(alloc.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(`Allocation to ${document.number} must be greater than zero.`);
    }

    if (amount.greaterThan(document.outstanding.amount)) {
      throw new BusinessRuleError(
        `Allocation of ${document.currency} ${amount.toFixed(2)} exceeds the ${document.outstanding.amount.toFixed(2)} still outstanding on ${document.number}.`,
      );
    }

    rows.push({
      purchaseContractId: document.isContract ? document.id : null,
      expenseId: document.isContract ? null : document.id,
      amount,
      amountUsd: convertToUsd(amount, document.rateToUsd, document.currency),
      currency: document.currency,
    });
  }

  // Can the money cover what it is put against? Asked in the payment's own
  // currency, as for receipts: a rate that moved between the bill and the
  // day it was paid must not make a full payment look short.
  const settledInVoucher = toMoney(
    sum(
      rows.map((r) =>
        r.currency === params.paymentCurrency
          ? r.amount
          : convertFromUsd(r.amountUsd, params.paymentRateToUsd, params.paymentCurrency),
      ),
    ),
  );
  if (settledInVoucher.greaterThan(params.paymentAmount.plus('0.005'))) {
    throw new BusinessRuleError(
      `Allocations total ${params.paymentCurrency} ${settledInVoucher.toFixed(2)} but the payment is only ${params.paymentCurrency} ${params.paymentAmount.toFixed(2)}.`,
    );
  }

  return rows.map((row) => {
    const { currency, ...rest } = row;
    void currency;
    return rest;
  });
}

function computePaymentAmounts(input: {
  amount: string | number;
  currency: string;
  rateToUsd: string | number;
  localCurrency: string;
  rateLocalPerUsd: string | number;
}) {
  const currency = input.currency.toUpperCase();
  const amount = toMoney(input.amount);

  if (amount.lessThanOrEqualTo(0)) throw new BusinessRuleError('The payment amount must be greater than zero.');

  const rateToUsd = dec(input.rateToUsd);
  if (currency === 'USD' && !rateToUsd.equals(1)) {
    throw new BusinessRuleError('The USD exchange rate must be exactly 1.');
  }
  if (rateToUsd.lessThanOrEqualTo(0)) throw new BusinessRuleError(`An exchange rate is required for ${currency}.`);

  const amountUsd = convertToUsd(amount, rateToUsd, currency);

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

/**
 * A cheque payment is a promise, not cash: it credits "Cheques Issued — Not
 * Cleared" until the bank clears it, so the bank account is only named later.
 */
async function validateSettlement(tx: Tx, input: PaymentInput) {
  const method = input.paymentMethod ?? 'BANK_TRANSFER';
  if (method === 'CHEQUE') {
    if (!input.cheque?.chequeNumber?.trim()) {
      throw new BusinessRuleError('A cheque number is required for a cheque payment.');
    }
    if (!input.cheque?.bankName?.trim()) {
      throw new BusinessRuleError('The drawee bank is required for a cheque payment.');
    }
    return method;
  }
  if (!input.cashBankAccountId) {
    throw new BusinessRuleError('Choose the cash or bank account the money was paid from.');
  }
  await assertAccountUsable(tx, input.companyId, input.cashBankAccountId, input.currency);
  return method;
}

async function assertAccountUsable(tx: Tx, companyId: string, cashBankAccountId: string, currency: string) {
  const account = await tx.cashBankAccount.findFirst({
    where: { id: cashBankAccountId, companyId },
    select: { currency: true, name: true, status: true },
  });
  if (!account) throw new NotFoundError('Cash/bank account');
  if (account.status !== 'ACTIVE') throw new BusinessRuleError(`${account.name} is inactive and cannot be used.`);
  if (account.currency.toUpperCase() !== currency.toUpperCase()) {
    throw new BusinessRuleError(`${account.name} is a ${account.currency} account, so it cannot pay out ${currency}.`);
  }
  return account;
}

async function lockPayableDocuments(
  tx: Tx,
  allocations: Array<{ purchaseContractId: string | null; expenseId: string | null }>,
) {
  const contractIds = [...new Set(allocations.map((a) => a.purchaseContractId).filter(Boolean))].sort() as string[];
  const expenseIds = [...new Set(allocations.map((a) => a.expenseId).filter(Boolean))].sort() as string[];
  for (const id of contractIds) {
    await tx.$queryRaw`SELECT "id" FROM purchase_contracts WHERE "id" = ${id} FOR UPDATE`;
  }
  for (const id of expenseIds) {
    await tx.$queryRaw`SELECT "id" FROM expenses WHERE "id" = ${id} FOR UPDATE`;
  }
}

async function cancelPaymentCheque(tx: Tx, paymentId: string, userId: string) {
  const existing = await tx.cheque.findFirst({ where: { paymentId } });
  if (!existing) return;
  if (existing.status === 'CLEARED' || existing.status === 'CANCELLED') return;
  if (existing.status !== 'RECEIVED' && existing.status !== 'DEPOSITED' && existing.status !== 'BOUNCED') return;
  await tx.cheque.update({ where: { id: existing.id }, data: { status: 'CANCELLED' } });
  await tx.chequeStatusHistory.create({
    data: {
      chequeId: existing.id,
      fromStatus: existing.status,
      toStatus: 'CANCELLED',
      changedById: userId,
      notes: 'Cancelled with the reversed voucher — the journal already unwound Cheques Issued.',
    },
  });
}

async function syncDraftPaymentCheque(
  tx: Tx,
  params: {
    companyId: string;
    paymentId: string;
    vendorId: string | null;
    vendorName: string | null;
    userId: string;
    method: PaymentMethod;
    cheque: PaymentInput['cheque'];
    amounts: {
      amount: Decimal;
      currency: string;
      rateToUsd: Decimal;
      amountUsd: Decimal;
      rateLocalPerUsd: Decimal;
      amountLocal: Decimal;
    };
    cashBankAccountId: string | null;
  },
) {
  const existing = await tx.cheque.findFirst({ where: { paymentId: params.paymentId } });

  if (params.method !== 'CHEQUE') {
    if (existing && existing.status === 'RECEIVED') {
      await tx.cheque.delete({ where: { id: existing.id } });
    }
    return;
  }
  if (!params.cheque) return;

  // With no supplier there is no name to fall back on for the payee.
  const beneficiary = params.cheque.beneficiary?.trim() || params.vendorName;
  if (!beneficiary) {
    throw new BusinessRuleError('Say who the cheque is made out to.');
  }

  const data = {
    chequeNumber: params.cheque.chequeNumber.trim(),
    chequeDate: params.cheque.chequeDate,
    bankName: params.cheque.bankName.trim(),
    amount: params.amounts.amount,
    currency: params.amounts.currency,
    rateToUsd: params.amounts.rateToUsd,
    amountUsd: params.amounts.amountUsd,
    rateLocalPerUsd: params.amounts.rateLocalPerUsd,
    amountLocal: params.amounts.amountLocal,
    beneficiary,
    vendorId: params.vendorId,
    cashBankAccountId: params.cashBankAccountId,
    notes: params.cheque.notes ?? null,
  };

  if (existing) {
    if (existing.status !== 'RECEIVED') {
      throw new BusinessRuleError(
        'This payment already has a cheque that has moved on from issued, so the instrument cannot be rewritten.',
      );
    }
    await tx.cheque.update({ where: { id: existing.id }, data });
    return;
  }

  await tx.cheque.create({
    data: {
      companyId: params.companyId,
      direction: 'OUTBOUND',
      paymentId: params.paymentId,
      status: 'RECEIVED',
      createdById: params.userId,
      statusHistory: {
        create: { fromStatus: null, toStatus: 'RECEIVED', changedById: params.userId, notes: 'Cheque issued' },
      },
      ...data,
    },
  });
}

/**
 * The supplier a payment names, when it names one.
 *
 * A payment that settles accrued costs — expenses booked before anyone
 * decided whose bill they were — has no supplier at all, and that is a valid
 * shape, not a missing field. A payment that does name one must name one of
 * this company's.
 */
async function requireVendorIfNamed(tx: Tx, input: { companyId: string; vendorId: string | null }) {
  if (!input.vendorId) return null;
  const vendor = await tx.vendor.findFirst({
    where: { id: input.vendorId, companyId: input.companyId },
    select: { id: true, vendorName: true },
  });
  if (!vendor) throw new NotFoundError('Vendor');
  return vendor;
}

export async function createPayment(input: PaymentInput, userId: string) {
  return transaction(async (tx) => {
    const company = await getCompanyContext(tx, input.companyId);
    const vendor = await requireVendorIfNamed(tx, input);

    const method = await validateSettlement(tx, input);

    const amounts = computePaymentAmounts({ ...input, localCurrency: company.localCurrency });
    const allocations = await buildAllocations(tx, {
      companyId: input.companyId,
      vendorId: input.vendorId,
      paymentAmount: amounts.amount,
      paymentCurrency: amounts.currency,
      paymentRateToUsd: amounts.rateToUsd,
      allocations: input.allocations ?? [],
    });

    const paymentNumber = await nextReference(tx, {
      companyId: input.companyId,
      docType: DOC_TYPES.PAYMENT,
    });

    const payment = await tx.payment.create({
      data: {
        companyId: input.companyId,
        paymentNumber,
        paymentDate: input.paymentDate,
        vendorId: input.vendorId,
        currency: amounts.currency,
        amount: amounts.amount,
        rateToUsd: amounts.rateToUsd,
        amountUsd: amounts.amountUsd,
        rateLocalPerUsd: amounts.rateLocalPerUsd,
        amountLocal: amounts.amountLocal,
        cashBankAccountId: input.cashBankAccountId ?? null,
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

    await syncDraftPaymentCheque(tx, {
      companyId: input.companyId,
      paymentId: payment.id,
      vendorId: input.vendorId,
      vendorName: vendor?.vendorName ?? null,
      userId,
      method,
      cheque: input.cheque,
      amounts,
      cashBankAccountId: input.cashBankAccountId ?? null,
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'PAYMENT_CREATED',
      entityType: 'Payment',
      entityId: payment.id,
      after: {
        paymentNumber,
        vendor: vendor?.vendorName ?? null,
        amount: amounts.amount,
        currency: amounts.currency,
        amountUsd: amounts.amountUsd,
      },
    });

    return payment;
  });
}

export async function updatePayment(id: string, input: PaymentInput, userId: string) {
  return transaction(async (tx) => {
    const existing = await tx.payment.findFirst({ where: { id, companyId: input.companyId } });
    if (!existing) throw new NotFoundError('Payment');
    if (existing.status !== 'DRAFT') {
      throw new BusinessRuleError('Only draft payments can be edited. Reverse the payment to correct a posted one.');
    }

    const vendor = await requireVendorIfNamed(tx, input);

    const company = await getCompanyContext(tx, input.companyId);
    const method = await validateSettlement(tx, input);

    const amounts = computePaymentAmounts({ ...input, localCurrency: company.localCurrency });
    const allocations = await buildAllocations(tx, {
      companyId: input.companyId,
      vendorId: input.vendorId,
      paymentAmount: amounts.amount,
      paymentCurrency: amounts.currency,
      paymentRateToUsd: amounts.rateToUsd,
      allocations: input.allocations ?? [],
    });

    await tx.paymentAllocation.deleteMany({ where: { paymentId: id } });

    const payment = await tx.payment.update({
      where: { id },
      data: {
        paymentDate: input.paymentDate,
        vendorId: input.vendorId,
        currency: amounts.currency,
        amount: amounts.amount,
        rateToUsd: amounts.rateToUsd,
        amountUsd: amounts.amountUsd,
        rateLocalPerUsd: amounts.rateLocalPerUsd,
        amountLocal: amounts.amountLocal,
        cashBankAccountId: input.cashBankAccountId ?? null,
        paymentMethod: method,
        shipmentId: input.shipmentId ?? null,
        reference: input.reference ?? null,
        description: input.description ?? null,
        allocations: { create: allocations },
      },
      include: { allocations: true },
    });

    await syncDraftPaymentCheque(tx, {
      companyId: input.companyId,
      paymentId: id,
      vendorId: input.vendorId,
      vendorName: vendor?.vendorName ?? null,
      userId,
      method,
      cheque: input.cheque,
      amounts,
      cashBankAccountId: input.cashBankAccountId ?? null,
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'PAYMENT_UPDATED',
      entityType: 'Payment',
      entityId: id,
      before: { amount: existing.amount, currency: existing.currency },
      after: { amount: payment.amount, currency: payment.currency },
    });

    return payment;
  });
}

export async function postPayment(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM payments
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Payment');
    if (locked[0].status !== 'DRAFT') {
      throw new BusinessRuleError(`This payment is already ${locked[0].status.toLowerCase()} and cannot be posted again.`);
    }

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: params.id },
      include: {
        vendor: true,
        cashBankAccount: true,
        allocations: { include: { purchaseContract: true, expense: true } },
      },
    });

    if (payment.paymentMethod !== 'CHEQUE' && !payment.cashBankAccountId) {
      throw new BusinessRuleError('This payment has no cash or bank account and cannot be posted.');
    }
    const company = await getCompanyContext(tx, params.companyId);

    await lockPayableDocuments(tx, payment.allocations);

    for (const alloc of payment.allocations) {
      const outstanding = alloc.purchaseContractId
        ? await getContractOutstanding(tx, alloc.purchaseContractId)
        : await getExpenseOutstanding(tx, alloc.expenseId!);
      if (dec(alloc.amount).greaterThan(outstanding.amount)) {
        const label = alloc.purchaseContract
          ? `Contract ${alloc.purchaseContract.contractNumber}`
          : `Cost ${alloc.expense?.expenseNumber ?? ''}`.trim();
        throw new BusinessRuleError(
          `${label} now has only ${outstanding.currency} ${outstanding.amount.toFixed(2)} outstanding, which is less than the ${dec(alloc.amount).toFixed(2)} allocated here.`,
        );
      }
    }

    // Each document is cleared at the value it was booked at — in USD and in
    // the company's own currency — so paying a bill in full always clears it
    // exactly, whatever today's rate says the money is worth. The difference
    // between that and the money line is a realised exchange gain or loss,
    // which the posting engine books on its own.
    const localCode = company.localCurrency.toUpperCase();
    const settlementLines = payment.allocations.map((allocation) => {
      const document = allocation.purchaseContract ?? allocation.expense;
      if (!document) throw new BusinessRuleError('An allocation names neither a contract nor a cost.');
      const bookedUsd = toMoney(allocation.amountUsd);
      const bookedLocal =
        document.currency === localCode
          ? toMoney(allocation.amount)
          : convertFromUsd(bookedUsd, document.rateLocalPerUsd, localCode);
      const label = allocation.purchaseContract
        ? allocation.purchaseContract.contractNumber
        : allocation.expense!.expenseNumber;

      // A cost booked to nobody in particular was accrued, not put on a
      // supplier's account. Paying it clears Accrued Expenses at the value it
      // was booked — no sub-ledger, no party currency to translate into.
      if (!payment.vendor) {
        return {
          accountKey: ACCOUNT_KEYS.ACCRUED_EXPENSES,
          direction: 'DEBIT' as const,
          currency: document.currency,
          amount: toMoney(allocation.amount),
          rateToUsd: document.rateToUsd,
          bookedUsd,
          bookedLocal,
          description: `Settles ${label}`,
          shipmentId: payment.shipmentId,
          purchaseContractId: allocation.purchaseContractId ?? null,
        };
      }

      // In the supplier's ledger currency, at the document's own rate — the
      // same statement the accrual made when the bill was booked.
      const leg = resolveSubledgerLeg({
        partyCurrency: payment.vendor.primaryCurrency,
        voucherCurrency: document.currency,
        voucherAmount: toMoney(allocation.amount),
        voucherRateToUsd: document.rateToUsd,
        voucherAmountUsd: bookedUsd,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: document.rateLocalPerUsd,
        partyLabel: payment.vendor.vendorName,
      });
      return {
        accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
        direction: 'DEBIT' as const,
        currency: leg.currency,
        amount: leg.amount,
        rateToUsd: leg.rateToUsd,
        bookedUsd,
        bookedLocal,
        description: `Settles ${label}`,
        vendorId: payment.vendorId,
        shipmentId: payment.shipmentId,
        purchaseContractId: allocation.purchaseContractId ?? null,
      };
    });

    // Anything not put against a document is an advance the supplier owes
    // back in goods — an asset, not a reduction of payables. Measured in the
    // payment's own currency.
    const settledInVoucher = toMoney(
      sum(
        payment.allocations.map((allocation) => {
          const document = allocation.purchaseContract ?? allocation.expense!;
          return document.currency === payment.currency
            ? dec(allocation.amount)
            : convertFromUsd(allocation.amountUsd, payment.rateToUsd, payment.currency);
        }),
      ),
    );
    const unallocated = toMoney(dec(payment.amount).minus(settledInVoucher));
    const hasAdvance = unallocated.greaterThan('0.005');

    // An advance is money a supplier owes back in goods. With no supplier
    // there is nobody to owe it, so a payment to nobody must be fully allocated.
    if (hasAdvance && !payment.vendor) {
      throw new BusinessRuleError(
        `${payment.currency} ${unallocated.toFixed(2)} of this payment is not put against a cost. A payment with no supplier has to be allocated in full.`,
      );
    }

    const advanceLines = hasAdvance && payment.vendor
      ? (() => {
          const vendor = payment.vendor;
          const advance = resolveSubledgerLeg({
            partyCurrency: vendor.primaryCurrency,
            voucherCurrency: payment.currency,
            voucherAmount: unallocated,
            voucherRateToUsd: payment.rateToUsd,
            voucherAmountUsd: convertToUsd(unallocated, payment.rateToUsd, payment.currency),
            localCurrency: company.localCurrency,
            rateLocalPerUsd: payment.rateLocalPerUsd,
            partyLabel: vendor.vendorName,
          });
          return [
            {
              accountKey: ACCOUNT_KEYS.SUPPLIER_ADVANCES,
              direction: 'DEBIT' as const,
              currency: advance.currency,
              amount: advance.amount,
              rateToUsd: advance.rateToUsd,
              description: `Advance to ${vendor.vendorName}, not yet applied to a contract`,
              vendorId: payment.vendorId,
              shipmentId: payment.shipmentId,
            },
          ];
        })()
      : [];

    const debitLines = [...settlementLines, ...advanceLines];

    await postJournalEntry(tx, {
      companyId: params.companyId,
      entryDate: payment.paymentDate,
      description: `Payment ${payment.paymentNumber} — ${payment.vendor?.vendorName ?? 'accrued cost'}`,
      sourceType: 'PAYMENT',
      sourceId: payment.id,
      createdById: params.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: payment.rateLocalPerUsd,
      lines: [
        // Anything not put against a contract is an advance the supplier owes
        // back in goods, so it is an asset rather than a reduction of payables.
        ...debitLines,
        payment.paymentMethod === 'CHEQUE'
          ? {
              accountKey: ACCOUNT_KEYS.CHEQUES_ISSUED,
              direction: 'CREDIT' as const,
              currency: payment.currency,
              amount: payment.amount,
              rateToUsd: payment.rateToUsd,
              description: 'Cheque issued, not yet cleared',
              vendorId: payment.vendorId,
              shipmentId: payment.shipmentId,
            }
          : {
              cashBankAccountId: payment.cashBankAccountId!,
              direction: 'CREDIT' as const,
              currency: payment.currency,
              amount: payment.amount,
              rateToUsd: payment.rateToUsd,
              description: `Paid from ${payment.cashBankAccount?.name ?? 'cash/bank'}`,
              vendorId: payment.vendorId,
              shipmentId: payment.shipmentId,
            },
      ],
    });

    const posted = await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'POSTED', postedAt: new Date() },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'PAYMENT_POSTED',
      entityType: 'Payment',
      entityId: payment.id,
      before: { status: 'DRAFT' },
      after: { status: 'POSTED', amount: payment.amount, currency: payment.currency, amountUsd: payment.amountUsd },
    });

    return posted;
  });
}

export async function reversePayment(params: { id: string; companyId: string; userId: string; reason: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM payments
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Payment');
    if (locked[0].status !== 'POSTED') throw new BusinessRuleError('Only a posted payment can be reversed.');

    const reversalDate = new Date();

    await reverseJournalEntry(tx, {
      companyId: params.companyId,
      sourceType: 'PAYMENT',
      sourceId: params.id,
      createdById: params.userId,
      entryDate: reversalDate,
      reason: params.reason,
    });

    await cancelPaymentCheque(tx, params.id, params.userId);

    const reversed = await tx.payment.update({
      where: { id: params.id },
      data: { status: 'REVERSED', reversedAt: reversalDate, reversalReason: params.reason },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'PAYMENT_REVERSED',
      entityType: 'Payment',
      entityId: params.id,
      before: { status: 'POSTED' },
      after: { status: 'REVERSED', reason: params.reason },
    });

    return reversed;
  });
}

export async function deleteDraftPayment(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: params.id, companyId: params.companyId } });
    if (!payment) throw new NotFoundError('Payment');
    if (payment.status !== 'DRAFT') {
      throw new BusinessRuleError('Only draft payments can be deleted. Posted payments must be reversed.');
    }
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'PAYMENT_DELETED',
      entityType: 'Payment',
      entityId: payment.id,
      before: { paymentNumber: payment.paymentNumber, amount: payment.amount },
    });
    await tx.payment.delete({ where: { id: params.id } });
  });
}
