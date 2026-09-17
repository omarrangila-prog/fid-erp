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
 *   INBOUND, COLLECTED BY AN AGENT (the customer paid him, in his name)
 *     RECEIVED   Dr Agent Clearing       Cr Accounts Receivable   (by the receipt)
 *     CLEARED    no entry — it cleared in his hands; he still owes us
 *     BOUNCED    Dr Accounts Receivable  Cr Agent Clearing        (debt reinstated)
 *     CANCELLED  Dr Accounts Receivable  Cr Agent Clearing
 *   The money reaches the bank when the agent settles, not before.
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
    include: { customer: true, vendor: true, cashBankAccount: true, receipt: true, agent: true },
  });
  if (!cheque) throw new NotFoundError('Cheque');
  return cheque;
}

/**
 * Is the agent holding this cheque on the company's behalf?
 *
 * The customer handed it to him, in his name, and it is he who owes the money
 * until he settles. The value therefore sits in agent clearing rather than in
 * cheques on hand, and that changes what every later status means: clearing
 * such a cheque puts nothing in our bank, and bouncing it has to come back out
 * of his balance, not out of an account the paper was never in.
 */
function heldByAgent(cheque: { receipt: { paymentMethod: string } | null; agentId: string | null }) {
  return cheque.receipt?.paymentMethod === 'AGENT_COLLECTION' && Boolean(cheque.agentId);
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
    const withAgent = heldByAgent(cheque);
    const cashBankAccountId = input.cashBankAccountId ?? cheque.cashBankAccountId;
    if (input.toStatus === 'CLEARED' && !withAgent) {
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

    if (fromStatus === 'BOUNCED' && input.toStatus === 'DEPOSITED') {
      // Bounce already credited Cheques on Hand and reinstated the debt.
      // Putting the paper back in play has to reopen that asset (or liability).
      if (isInbound) {
        if (!cheque.customer) throw new BusinessRuleError('This inbound cheque has no customer to re-credit.');
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
            accountKey: withAgent ? ACCOUNT_KEYS.AGENT_CLEARING : ACCOUNT_KEYS.CHEQUES_ON_HAND,
            direction: 'DEBIT',
            currency: cheque.currency,
            amount: cheque.amount,
            rateToUsd: cheque.rateToUsd,
            description: `Cheque ${cheque.chequeNumber} redeposited`,
            customerId: cheque.customerId,
            ...(withAgent ? { agentId: cheque.agentId } : {}),
          },
          {
            accountKey: ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE,
            direction: 'CREDIT',
            currency: ar.currency,
            amount: ar.amount,
            rateToUsd: ar.rateToUsd,
            description: `Cheque ${cheque.chequeNumber} redeposited — debt settled again`,
            customerId: cheque.customerId,
          },
        ];
      } else {
        if (!cheque.vendor) throw new BusinessRuleError('This outbound cheque has no supplier to re-debit.');
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
            accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
            direction: 'DEBIT',
            currency: ap.currency,
            amount: ap.amount,
            rateToUsd: ap.rateToUsd,
            description: `Cheque ${cheque.chequeNumber} reissued — liability settled again`,
            vendorId: cheque.vendorId,
          },
          {
            accountKey: ACCOUNT_KEYS.CHEQUES_ISSUED,
            direction: 'CREDIT',
            currency: cheque.currency,
            amount: cheque.amount,
            rateToUsd: cheque.rateToUsd,
            description: `Cheque ${cheque.chequeNumber} reissued`,
            vendorId: cheque.vendorId,
          },
        ];
      }
    } else if (input.toStatus === 'CLEARED' && withAgent) {
      /*
       * The cheque cleared in the agent's hands, not in ours.
       *
       * Nothing about the company's position has changed: the agent owed the
       * money before the cheque cleared and owes it still, until he hands it
       * over. Debiting the bank here would state cash the company does not
       * have, which is the whole mistake agent clearing exists to prevent.
       * The money arrives when he settles.
       */
      lines = null;
    } else if (input.toStatus === 'CLEARED') {
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
        // Out of whichever account is actually holding the value: agent
        // clearing when the agent took the cheque, cheques on hand when we
        // did. Crediting the wrong one leaves the agent still owing money he
        // never received and the company holding paper that bounced.
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
            accountKey: withAgent ? ACCOUNT_KEYS.AGENT_CLEARING : ACCOUNT_KEYS.CHEQUES_ON_HAND,
            direction: 'CREDIT',
            currency: cheque.currency,
            amount: cheque.amount,
            rateToUsd: cheque.rateToUsd,
            description: withAgent
              ? `Cheque ${cheque.chequeNumber} ${label} — no longer due from ${cheque.agent?.agentName ?? 'the agent'}`
              : `Cheque ${cheque.chequeNumber} ${label}`,
            customerId: cheque.customerId,
            ...(withAgent ? { agentId: cheque.agentId } : {}),
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
