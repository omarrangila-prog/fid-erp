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
 * PaymentService — money out to vendors. The mirror image of ReceiptService:
 * payments are allocated against purchase contracts rather than invoices, and
 * the vendor's payable is relieved in the vendor's own ledger currency.
 */

export type PaymentAllocationInput = {
  purchaseContractId: string;
  /** Amount in the contract's own currency. */
  amount: string | number;
};

export type PaymentInput = {
  companyId: string;
  paymentDate: Date;
  vendorId: string;
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
    select: { totalValue: true, totalValueUsd: true, currency: true, status: true },
  });

  const rows = await tx.$queryRaw<Array<{ amount: string | null; amountUsd: string | null }>>`
    SELECT COALESCE(SUM(pa."amount"), 0)::text AS amount,
           COALESCE(SUM(pa."amountUsd"), 0)::text AS "amountUsd"
    FROM payment_allocations pa
    JOIN payments p ON p."id" = pa."paymentId"
    WHERE pa."purchaseContractId" = ${contractId} AND p."status" = 'POSTED'
  `;

  const gross = contract.status === 'POSTED' ? dec(contract.totalValue) : new Decimal(0);
  const grossUsd = contract.status === 'POSTED' ? dec(contract.totalValueUsd) : new Decimal(0);

  return {
    amount: toMoney(gross.minus(dec(rows[0]?.amount ?? 0))),
    amountUsd: toMoney(grossUsd.minus(dec(rows[0]?.amountUsd ?? 0))),
    currency: contract.currency,
  };
}

async function buildAllocations(
  tx: Tx,
  params: { companyId: string; vendorId: string; paymentAmountUsd: Decimal; allocations: PaymentAllocationInput[] },
) {
  const rows: Array<{ purchaseContractId: string; amount: Decimal; amountUsd: Decimal }> = [];

  for (const alloc of params.allocations) {
    const contract = await tx.purchaseContract.findFirst({
      where: { id: alloc.purchaseContractId, companyId: params.companyId },
      select: { id: true, contractNumber: true, vendorId: true, status: true, currency: true, rateToUsd: true },
    });
    if (!contract) throw new NotFoundError('Purchase contract in allocation');
    if (contract.vendorId !== params.vendorId) {
      throw new BusinessRuleError(`Contract ${contract.contractNumber} belongs to a different vendor.`);
    }
    if (contract.status !== 'POSTED') {
      throw new BusinessRuleError(`Contract ${contract.contractNumber} is not posted and cannot be settled.`);
    }

    const amount = toMoney(alloc.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(`Allocation to ${contract.contractNumber} must be greater than zero.`);
    }

    const outstanding = await getContractOutstanding(tx, contract.id);
    if (amount.greaterThan(outstanding.amount)) {
      throw new BusinessRuleError(
        `Allocation of ${contract.currency} ${amount.toFixed(2)} exceeds the ${outstanding.amount.toFixed(2)} still outstanding on ${contract.contractNumber}.`,
      );
    }

    rows.push({
      purchaseContractId: contract.id,
      amount,
      amountUsd: convertToUsd(amount, contract.rateToUsd, contract.currency),
    });
  }

  const totalAllocatedUsd = toMoney(sum(rows.map((r) => r.amountUsd)));
  if (totalAllocatedUsd.greaterThan(params.paymentAmountUsd)) {
    throw new BusinessRuleError(
      `Allocations total USD ${totalAllocatedUsd.toFixed(2)} but the payment is only worth USD ${params.paymentAmountUsd.toFixed(2)}.`,
    );
  }

  return rows;
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

export async function createPayment(input: PaymentInput, userId: string) {
  return transaction(async (tx) => {
    const company = await getCompanyContext(tx, input.companyId);
    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, companyId: input.companyId },
      select: { id: true, vendorName: true },
    });
    if (!vendor) throw new NotFoundError('Vendor');

    const method = await validateSettlement(tx, input);

    const amounts = computePaymentAmounts({ ...input, localCurrency: company.localCurrency });
    const allocations = await buildAllocations(tx, {
      companyId: input.companyId,
      vendorId: input.vendorId,
      paymentAmountUsd: amounts.amountUsd,
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

    if (method === 'CHEQUE' && input.cheque) {
      await tx.cheque.create({
        data: {
          companyId: input.companyId,
          chequeNumber: input.cheque.chequeNumber.trim(),
          direction: 'OUTBOUND',
          chequeDate: input.cheque.chequeDate,
          bankName: input.cheque.bankName.trim(),
          amount: amounts.amount,
          currency: amounts.currency,
          rateToUsd: amounts.rateToUsd,
          amountUsd: amounts.amountUsd,
          rateLocalPerUsd: amounts.rateLocalPerUsd,
          amountLocal: amounts.amountLocal,
          beneficiary: input.cheque.beneficiary ?? vendor.vendorName,
          vendorId: input.vendorId,
          paymentId: payment.id,
          cashBankAccountId: input.cashBankAccountId ?? null,
          status: 'RECEIVED',
          notes: input.cheque.notes ?? null,
          createdById: userId,
          statusHistory: {
            create: { fromStatus: null, toStatus: 'RECEIVED', changedById: userId, notes: 'Cheque issued' },
          },
        },
      });
    }

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'PAYMENT_CREATED',
      entityType: 'Payment',
      entityId: payment.id,
      after: {
        paymentNumber,
        vendor: vendor.vendorName,
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

    const company = await getCompanyContext(tx, input.companyId);
    const method = await validateSettlement(tx, input);

    const amounts = computePaymentAmounts({ ...input, localCurrency: company.localCurrency });
    const allocations = await buildAllocations(tx, {
      companyId: input.companyId,
      vendorId: input.vendorId,
      paymentAmountUsd: amounts.amountUsd,
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
      include: { vendor: true, cashBankAccount: true, allocations: { include: { purchaseContract: true } } },
    });

    if (payment.paymentMethod !== 'CHEQUE' && !payment.cashBankAccountId) {
      throw new BusinessRuleError('This payment has no cash or bank account and cannot be posted.');
    }
    const company = await getCompanyContext(tx, params.companyId);

    for (const alloc of payment.allocations) {
      const outstanding = await getContractOutstanding(tx, alloc.purchaseContractId);
      if (dec(alloc.amount).greaterThan(outstanding.amount)) {
        throw new BusinessRuleError(
          `Contract ${alloc.purchaseContract.contractNumber} now has only ${outstanding.currency} ${outstanding.amount.toFixed(2)} outstanding, which is less than the ${dec(alloc.amount).toFixed(2)} allocated here.`,
        );
      }
    }

    const ap = resolveSubledgerLeg({
      partyCurrency: payment.vendor.primaryCurrency,
      voucherCurrency: payment.currency,
      voucherAmount: payment.amount,
      voucherRateToUsd: payment.rateToUsd,
      voucherAmountUsd: payment.amountUsd,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: payment.rateLocalPerUsd,
      partyLabel: payment.vendor.vendorName,
    });

    await postJournalEntry(tx, {
      companyId: params.companyId,
      entryDate: payment.paymentDate,
      description: `Payment ${payment.paymentNumber} — ${payment.vendor.vendorName}`,
      sourceType: 'PAYMENT',
      sourceId: payment.id,
      createdById: params.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: payment.rateLocalPerUsd,
      lines: [
        {
          accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
          direction: 'DEBIT',
          currency: ap.currency,
          amount: ap.amount,
          rateToUsd: ap.rateToUsd,
          description: `Settlement to ${payment.vendor.vendorName}`,
          vendorId: payment.vendorId,
          shipmentId: payment.shipmentId,
          purchaseContractId: payment.allocations[0]?.purchaseContractId ?? null,
        },
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
