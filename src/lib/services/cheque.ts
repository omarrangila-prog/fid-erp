import { transaction } from '@/lib/db';
import type { Tx } from '@/lib/db';
import { dec } from '@/lib/money';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { postJournalEntry, type JournalLineInput } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { resolveSubledgerLeg } from '@/lib/services/subledger';
import { writeAudit } from '@/lib/services/audit';
import type { ChequeStatus } from '@prisma/client';

/**
 * ChequeService.
 *
 * A cheque is an instrument with a life of its own, not a note on a payment.
 * Treating one as cash the day it arrives overstates the bank and understates
 * the receivable, and makes a bounce impossible to unwind cleanly. So:
 *
 *   INBOUND (from a customer)
 *     RECEIVED   Dr Cheques on Hand      Cr Accounts Receivable   (by the receipt)
 *     DEPOSITED  no entry — the asset has not changed, only its location
 *     CLEARED    Dr Bank                 Cr Cheques on Hand
 *     BOUNCED    Dr Accounts Receivable  Cr Cheques on Hand       (debt reinstated)
 *     CANCELLED  Dr Accounts Receivable  Cr Cheques on Hand
 *
 *   OUTBOUND (to a supplier)
 *     ISSUED     Dr Accounts Payable     Cr Cheques Issued        (by the payment)
 *     CLEARED    Dr Cheques Issued       Cr Bank
 *     BOUNCED    Dr Cheques Issued       Cr Accounts Payable
 *     CANCELLED  Dr Cheques Issued       Cr Accounts Payable
 *
 * A bounced cheque can therefore never be mistaken for cleared cash.
 */

const ALLOWED_TRANSITIONS: Record<ChequeStatus, ChequeStatus[]> = {
  RECEIVED: ['DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED'],
  DEPOSITED: ['CLEARED', 'BOUNCED', 'CANCELLED'],
  CLEARED: [],
  BOUNCED: ['DEPOSITED'],
  CANCELLED: [],
};

function assertTransition(from: ChequeStatus, to: ChequeStatus) {
  if (from === to) throw new BusinessRuleError('The cheque is already in that status.');
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new BusinessRuleError(
      `A cheque cannot move from "${from.toLowerCase()}" to "${to.toLowerCase()}".`,
    );
  }
}

async function loadCheque(tx: Tx, companyId: string, chequeId: string) {
  const cheque = await tx.cheque.findFirst({
    where: { id: chequeId, companyId },
    include: { customer: true, vendor: true, cashBankAccount: true },
  });
  if (!cheque) throw new NotFoundError('Cheque');
  return cheque;
}

export type ChequeStatusChangeInput = {
  chequeId: string;
  companyId: string;
  userId: string;
  toStatus: ChequeStatus;
  /** Required when clearing: the bank account the funds settled through. */
  cashBankAccountId?: string | null;
  effectiveDate?: Date;
  reason?: string | null;
  notes?: string | null;
};

export async function changeChequeStatus(input: ChequeStatusChangeInput) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM cheques
      WHERE "id" = ${input.chequeId} AND "companyId" = ${input.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Cheque');

    const fromStatus = locked[0].status as ChequeStatus;
    assertTransition(fromStatus, input.toStatus);

    const cheque = await loadCheque(tx, input.companyId, input.chequeId);
    const company = await getCompanyContext(tx, input.companyId);
    const effectiveDate = input.effectiveDate ?? new Date();
    const isInbound = cheque.direction === 'INBOUND';

    if (input.toStatus === 'BOUNCED' && !input.reason?.trim()) {
      throw new BusinessRuleError('A reason is required when marking a cheque as bounced.');
    }

    // --- Resolve the settlement bank account where one is needed ------------
    const cashBankAccountId = input.cashBankAccountId ?? cheque.cashBankAccountId;
    if (input.toStatus === 'CLEARED') {
      if (!cashBankAccountId) {
        throw new BusinessRuleError('Choose the bank account this cheque cleared through.');
      }
      const account = await tx.cashBankAccount.findFirst({
        where: { id: cashBankAccountId, companyId: input.companyId },
        select: { currency: true, name: true, status: true },
      });
      if (!account) throw new NotFoundError('Bank account');
      if (account.status !== 'ACTIVE') {
        throw new BusinessRuleError(`${account.name} is inactive and cannot be used.`);
      }
      if (account.currency.toUpperCase() !== cheque.currency.toUpperCase()) {
        throw new BusinessRuleError(
          `${account.name} is a ${account.currency} account, so a ${cheque.currency} cheque cannot clear through it.`,
        );
      }
    }

    // --- Build the accounting entry for this transition --------------------
    let lines: JournalLineInput[] | null = null;

    if (input.toStatus === 'CLEARED') {
      lines = isInbound
        ? [
            {
              cashBankAccountId: cashBankAccountId!,
              direction: 'DEBIT',
              currency: cheque.currency,
              amount: cheque.amount,
              rateToUsd: cheque.rateToUsd,
              description: `Cheque ${cheque.chequeNumber} cleared`,
              customerId: cheque.customerId,
            },
            {
              accountKey: ACCOUNT_KEYS.CHEQUES_ON_HAND,
              direction: 'CREDIT',
              currency: cheque.currency,
              amount: cheque.amount,
              rateToUsd: cheque.rateToUsd,
              description: 'Cheque cleared out of cheques on hand',
              customerId: cheque.customerId,
            },
          ]
        : [
            {
              accountKey: ACCOUNT_KEYS.CHEQUES_ISSUED,
              direction: 'DEBIT',
              currency: cheque.currency,
              amount: cheque.amount,
              rateToUsd: cheque.rateToUsd,
              description: `Cheque ${cheque.chequeNumber} presented`,
              vendorId: cheque.vendorId,
            },
            {
              cashBankAccountId: cashBankAccountId!,
              direction: 'CREDIT',
              currency: cheque.currency,
              amount: cheque.amount,
              rateToUsd: cheque.rateToUsd,
              description: `Cheque ${cheque.chequeNumber} cleared`,
              vendorId: cheque.vendorId,
            },
          ];
    } else if (input.toStatus === 'BOUNCED' || input.toStatus === 'CANCELLED') {
      const label = input.toStatus === 'BOUNCED' ? 'bounced' : 'cancelled';

      if (isInbound) {
        if (!cheque.customer) throw new BusinessRuleError('This inbound cheque has no customer to re-debit.');
        const ar = resolveSubledgerLeg({
          partyCurrency: cheque.customer.primaryCurrency,
          voucherCurrency: cheque.currency,
          voucherAmount: cheque.amount,
          voucherRateToUsd: cheque.rateToUsd,
          voucherAmountUsd: cheque.amountUsd,
          localCurrency: company.localCurrency,
          rateLocalPerUsd: cheque.rateLocalPerUsd,
          partyLabel: cheque.customer.customerName,
        });
        lines = [
          {
            accountKey: ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE,
            direction: 'DEBIT',
            currency: ar.currency,
            amount: ar.amount,
            rateToUsd: ar.rateToUsd,
            description: `Cheque ${cheque.chequeNumber} ${label} — debt reinstated`,
            customerId: cheque.customerId,
          },
          {
            accountKey: ACCOUNT_KEYS.CHEQUES_ON_HAND,
            direction: 'CREDIT',
            currency: cheque.currency,
            amount: cheque.amount,
            rateToUsd: cheque.rateToUsd,
            description: `Cheque ${cheque.chequeNumber} ${label}`,
            customerId: cheque.customerId,
          },
        ];
      } else {
        if (!cheque.vendor) throw new BusinessRuleError('This outbound cheque has no supplier to re-credit.');
        const ap = resolveSubledgerLeg({
          partyCurrency: cheque.vendor.primaryCurrency,
          voucherCurrency: cheque.currency,
          voucherAmount: cheque.amount,
          voucherRateToUsd: cheque.rateToUsd,
          voucherAmountUsd: cheque.amountUsd,
          localCurrency: company.localCurrency,
          rateLocalPerUsd: cheque.rateLocalPerUsd,
          partyLabel: cheque.vendor.vendorName,
        });
        lines = [
          {
            accountKey: ACCOUNT_KEYS.CHEQUES_ISSUED,
            direction: 'DEBIT',
            currency: cheque.currency,
            amount: cheque.amount,
            rateToUsd: cheque.rateToUsd,
            description: `Cheque ${cheque.chequeNumber} ${label}`,
            vendorId: cheque.vendorId,
          },
          {
            accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
            direction: 'CREDIT',
            currency: ap.currency,
            amount: ap.amount,
            rateToUsd: ap.rateToUsd,
            description: `Cheque ${cheque.chequeNumber} ${label} — liability reinstated`,
            vendorId: cheque.vendorId,
          },
        ];
      }
    }
    // DEPOSITED moves the paper, not the money: no journal entry.

    if (lines) {
      await postJournalEntry(tx, {
        companyId: input.companyId,
        entryDate: effectiveDate,
        description: `Cheque ${cheque.chequeNumber} — ${input.toStatus.toLowerCase()}`,
        sourceType: 'CHEQUE',
        sourceId: cheque.id,
        createdById: input.userId,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: cheque.rateLocalPerUsd,
        lines,
      });
    }

    const updated = await tx.cheque.update({
      where: { id: cheque.id },
      data: {
        status: input.toStatus,
        cashBankAccountId,
        depositDate: input.toStatus === 'DEPOSITED' ? effectiveDate : cheque.depositDate,
        clearingDate: input.toStatus === 'CLEARED' ? effectiveDate : cheque.clearingDate,
        bounceDate: input.toStatus === 'BOUNCED' ? effectiveDate : cheque.bounceDate,
        bounceReason: input.toStatus === 'BOUNCED' ? (input.reason ?? null) : cheque.bounceReason,
      },
    });

    await tx.chequeStatusHistory.create({
      data: {
        chequeId: cheque.id,
        fromStatus,
        toStatus: input.toStatus,
        changedById: input.userId,
        notes: input.reason ?? input.notes ?? null,
      },
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: `CHEQUE_${input.toStatus}`,
      entityType: 'Cheque',
      entityId: cheque.id,
      before: { status: fromStatus },
      after: {
        status: input.toStatus,
        amount: cheque.amount,
        currency: cheque.currency,
        reason: input.reason ?? null,
      },
    });

    return updated;
  });
}

/** Cheques on hand, grouped by status — the cheque register summary. */
export async function getChequeSummary(tx: Tx, companyId: string) {
  const rows = await tx.$queryRaw<
    Array<{ direction: string; status: string; currency: string; total: string; count: bigint }>
  >`
    SELECT "direction"::text AS direction, "status"::text AS status, "currency",
           SUM("amount")::text AS total, COUNT(*) AS count
    FROM cheques
    WHERE "companyId" = ${companyId}
    GROUP BY "direction", "status", "currency"
    ORDER BY "direction", "status"
  `;
  return rows.map((r) => ({
    direction: r.direction,
    status: r.status,
    currency: r.currency,
    total: dec(r.total),
    count: Number(r.count),
  }));
}
