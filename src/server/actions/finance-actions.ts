'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { fieldErrors } from '@/lib/validation/common';
import {
  agentSettlementSchema,
  agentOffsetSchema,
  receiptSchema,
  paymentSchema,
  expenseSchema,
  splitExpenseSchema,
  chequeStatusSchema,
  journalVoucherSchema,
  revaluationSchema,
  cashBankTransferSchema,
  intercompanyLoanSchema,
  loanSchema,
} from '@/lib/validation/finance';
import { createReceipt, updateReceipt, postReceipt, reverseReceipt, deleteDraftReceipt } from '@/lib/services/receipt';
import { createPayment, updatePayment, postPayment, reversePayment, deleteDraftPayment } from '@/lib/services/payment';
import {
  createExpense,
  createExpenseIn,
  updateExpense,
  postExpense,
  postExpenseIn,
  reverseExpense,
  deleteDraftExpense,
} from '@/lib/services/expense';
import { changeChequeStatus } from '@/lib/services/cheque';
import {
  createAgentSettlement,
  postAgentSettlement,
  recordAgentHandover,
  offsetAgentBalances,
} from '@/lib/services/agent-ledger';
import { postRevaluation } from '@/lib/services/revaluation';
import { deletePostedEntry } from '@/lib/services/document-lifecycle';
import { postJournalEntry } from '@/lib/services/accounting';
import { postCashBankTransfer, postIntercompanyLoan } from '@/lib/services/cash-transfer';
import { postLoan } from '@/lib/services/loan';
import { allocateOverheads, withdrawOverheadAllocation } from '@/lib/services/overhead-allocation';
import { allocateOverheadsSchema } from '@/lib/validation/finance';
import {
  createRecurringFromExpense,
  generateFromRecurring,
  setRecurringStatus,
} from '@/lib/services/recurring-expense';
import { dateString, optionalDateString, requiredText } from '@/lib/validation/common';
import { getCompanyContext } from '@/lib/services/company';
import { prisma, transaction } from '@/lib/db';
import { onceForKey } from '@/lib/services/idempotency';
import { businessNumber } from '@/lib/short-number';
import { fail, ok, type ActionResult } from '@/server/actions/action-utils';
import type { DocFormState } from '@/server/actions/trading-actions';

/**
 * Finance actions. As with trading, these validate and delegate — the posting
 * rules live in the services where they are tested.
 */

function toState(error: unknown): DocFormState {
  if (error instanceof z.ZodError) {
    return { ok: false, error: 'Please correct the highlighted fields.', errors: fieldErrors(error) };
  }
  const response = fail(error);
  return { ok: false, error: response.ok ? 'The action could not be completed.' : response.error };
}

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error('The submitted form could not be read. Please try again.');
  }
}

const paths = {
  receipts: ['/finance/receipts', '/finance/receivables', '/finance/cash-bank', '/dashboard'],
  payments: ['/finance/payments', '/finance/payables', '/finance/cash-bank', '/dashboard'],
  expenses: ['/finance/expenses', '/finance/cash-bank', '/profitability', '/dashboard'],
  cheques: ['/finance/cheques', '/finance/cash-bank', '/finance/receivables', '/dashboard'],
  journals: ['/accounting/journals', '/accounting/general-ledger', '/reports/trial-balance', '/dashboard'],
};

function revalidateAll(list: string[]) {
  for (const path of list) revalidatePath(path);
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export async function saveReceiptAction(id: string | null, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.RECEIPTS_CREATE);
    const { clientKey, ...input } = receiptSchema.parse(parseJson(payload));
    const data = { companyId: user.activeCompany.id, ...input, cheque: input.cheque ?? null };

    // A second submit of the same form returns the receipt the first created.
    const result = id
      ? { id: (await updateReceipt(id, data, user.id)).id, replayed: false }
      : await onceForKey({ companyId: user.activeCompany.id, userId: user.id, scope: 'RECEIPT', key: clientKey }, () =>
          createReceipt(data, user.id),
        );

    revalidateAll(paths.receipts);
    return {
      ok: true,
      id: result.id,
      message: id ? 'Receipt updated.' : result.replayed ? 'Already saved — this receipt was recorded once.' : 'Receipt created.',
    };
  } catch (error) {
    return toState(error);
  }
}

// ---------------------------------------------------------------------------
// Agent settlements
// ---------------------------------------------------------------------------

/**
 * Money actually moving between the company and a collection agent.
 *
 * Creating and posting are one action. A settlement that is recorded but not
 * posted has moved nothing — the agent still appears to be holding money he
 * has already handed over — and there is no reason anybody would want to keep
 * one as a draft.
 */
/**
 * Settle an agent's two balances against each other — never automatic.
 *
 * Showing a net position is a convenience; moving one balance against the
 * other changes both ledgers, so somebody has to ask for it and say why.
 */
export async function offsetAgentBalancesAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const { clientKey, ...input } = agentOffsetSchema.parse(parseJson(payload));

    const posted = await onceForKey(
      { companyId: user.activeCompany.id, userId: user.id, scope: 'AGENT_OFFSET', key: clientKey },
      () => offsetAgentBalances({ companyId: user.activeCompany.id, userId: user.id, ...input }),
    );

    revalidateAll(paths.journals);
    revalidatePath('/agents');
    revalidatePath(`/agents/${input.agentId}`);
    return {
      ok: true,
      id: posted.id,
      message: posted.created
        ? `Settled against each other as ${posted.created.entryNumber}.`
        : 'Already settled against each other.',
    };
  } catch (error) {
    return toState(error);
  }
}

export async function recordAgentSettlementAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.RECEIPTS_POST);
    const { clientKey, ...input } = agentSettlementSchema.parse(parseJson(payload));

    // Recorded and posted once, even if Record is pressed twice.
    const created = await onceForKey(
      { companyId: user.activeCompany.id, userId: user.id, scope: 'AGENT_SETTLEMENT', key: clientKey },
      async () => {
        /*
         * Money coming back from an agent may be more than he was holding,
         * because part of it is his own. That part is a loan, and it has to be
         * said so rather than inferred, so the hand-over splits the amount and
         * refuses an excess nobody has explained.
         */
        if (input.direction === 'COLLECTION') {
          const { settlementId, lent } = await recordAgentHandover({
            companyId: user.activeCompany.id,
            userId: user.id,
            ...input,
            excess: input.excess ?? null,
          });
          return { id: settlementId ?? input.agentId, lent };
        }
        const settlement = await createAgentSettlement({ companyId: user.activeCompany.id, ...input }, user.id);
        await postAgentSettlement({ id: settlement.id, companyId: user.activeCompany.id, userId: user.id });
        return { id: settlement.id, lent: null };
      },
    );

    revalidateAll(paths.receipts);
    revalidatePath('/agents');
    revalidatePath(`/agents/${input.agentId}`);
    return {
      ok: true,
      id: created.id,
      message:
        input.direction !== 'COLLECTION'
          ? 'Commission paid.'
          : created.created?.lent && created.created.lent.greaterThan(0)
            ? `Recorded. ${input.currency} ${created.created.lent.toFixed(2)} of it is his own money, booked as a loan to the company.`
            : 'Recorded. The money is now in the account you chose.',
    };
  } catch (error) {
    return toState(error);
  }
}

export async function postReceiptAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.RECEIPTS_POST);
    await postReceipt({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidateAll([...paths.receipts, `/finance/receipts/${id}`]);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function reverseReceiptAction(id: string, reason: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.RECEIPTS_POST);
    await reverseReceipt({ id, companyId: user.activeCompany.id, userId: user.id, reason });
    revalidateAll([...paths.receipts, `/finance/receipts/${id}`]);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteReceiptAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.RECEIPTS_DELETE);
    await deleteDraftReceipt({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidateAll(paths.receipts);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export async function savePaymentAction(id: string | null, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.PAYMENTS_CREATE);
    const { clientKey, ...input } = paymentSchema.parse(parseJson(payload));
    const data = { companyId: user.activeCompany.id, ...input, cheque: input.cheque ?? null };

    const result = id
      ? { id: (await updatePayment(id, data, user.id)).id, replayed: false }
      : await onceForKey({ companyId: user.activeCompany.id, userId: user.id, scope: 'PAYMENT', key: clientKey }, () =>
          createPayment(data, user.id),
        );

    revalidateAll(paths.payments);
    return {
      ok: true,
      id: result.id,
      message: id ? 'Payment updated.' : result.replayed ? 'Already saved — this payment was recorded once.' : 'Payment created.',
    };
  } catch (error) {
    return toState(error);
  }
}

export async function postPaymentAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.PAYMENTS_POST);
    await postPayment({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidateAll([...paths.payments, `/finance/payments/${id}`]);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function reversePaymentAction(id: string, reason: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.PAYMENTS_POST);
    await reversePayment({ id, companyId: user.activeCompany.id, userId: user.id, reason });
    revalidateAll([...paths.payments, `/finance/payments/${id}`]);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function deletePaymentAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.PAYMENTS_DELETE);
    await deleteDraftPayment({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidateAll(paths.payments);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export async function saveExpenseAction(id: string | null, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.EXPENSES_CREATE);
    const { clientKey, ...input } = expenseSchema.parse(parseJson(payload));
    const data = { companyId: user.activeCompany.id, ...input };

    const result = id
      ? { id: (await updateExpense(id, data, user.id)).id, replayed: false }
      : await onceForKey({ companyId: user.activeCompany.id, userId: user.id, scope: 'EXPENSE', key: clientKey }, () =>
          createExpense(data, user.id),
        );

    revalidateAll(paths.expenses);
    return {
      ok: true,
      id: result.id,
      message: id ? 'Expense updated.' : result.replayed ? 'Already saved — this expense was recorded once.' : 'Expense created.',
    };
  } catch (error) {
    return toState(error);
  }
}


/**
 * One payment, several cost categories, entered once.
 *
 * MAD 20,000 handed over at the port is rarely one thing: it is port charges,
 * labour and documentation, and typing three vouchers with the same date, the
 * same cash account and the same reference is where the third one ends up
 * slightly wrong.
 *
 * Each line becomes an expense of its own rather than one record with a
 * breakdown, because the categories genuinely behave differently — port
 * charges are capitalised into the coffee's landed cost, documentation may not
 * be — and one record cannot be capitalised and expensed at the same time.
 * They share a reference so the payment reads as one event, and they are
 * written and posted inside a single transaction, so either the whole split
 * lands or none of it does.
 */
export async function saveSplitExpenseAction(payload: string): Promise<ActionResult<{ ids: string[] }>> {
  try {
    const user = await requirePermission(PERMISSIONS.EXPENSES_CREATE);
    const post = await requirePermission(PERMISSIONS.EXPENSES_POST);
    const companyId = user.activeCompany.id;
    const { clientKey, ...input } = splitExpenseSchema.parse(parseJson(payload));

    // One transaction for the whole split: nesting `transaction()` would open a
    // second connection rather than joining this one, so the services are
    // called through their tx-body variants and share this `tx`. The split as
    // a whole is recorded once per submission key.
    const once = await onceForKey({ companyId, userId: user.id, scope: 'SPLIT_EXPENSE', key: clientKey }, async () => ({
      id: (await splitNow()).join(','),
    }));
    const ids = once.id.split(',');

    revalidateAll([...paths.expenses, '/shipments', '/finance/cash-bank']);
    return { ok: true, data: { ids } };

    async function splitNow() {
      return transaction(async (tx) => {
      const created: string[] = [];
      for (const line of input.lines) {
        const expense = await createExpenseIn(
          tx,
          {
            companyId,
            expenseDate: input.expenseDate,
            expenseCategoryId: line.expenseCategoryId,
            shipmentId: input.kind === 'SHIPMENT' ? input.shipmentId : null,
            purchaseContractId: null,
            containerId: input.kind === 'SHIPMENT' ? line.containerId : null,
            batchId: input.kind === 'SHIPMENT' ? line.batchId : null,
            vendorId: input.vendorId,
            agentId: input.agentId,
            payableToAgentId: input.payableToAgentId,
            currency: input.currency,
            amount: line.amount,
            rateToUsd: input.rateToUsd,
            rateLocalPerUsd: input.rateLocalPerUsd,
            paymentMethod: input.paymentMethod,
            cashBankAccountId: input.cashBankAccountId,
            kind: input.kind,
            taxCodeId: line.taxCodeId,
            reference: input.reference,
            description: line.description,
          },
          user.id,
        );
        await postExpenseIn(tx, { id: expense.id, companyId, userId: post.id });
        created.push(expense.id);
      }
      return created;
      }, 120_000);
    }
  } catch (error) {
    return fail(error);
  }
}


// ---------------------------------------------------------------------------
// Recurring expenses
// ---------------------------------------------------------------------------

const recurringSchema = z.object({
  name: requiredText('Name'),
  frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
  nextDate: dateString('First due date'),
  endDate: optionalDateString,
});

/** Turn the expense on screen into a template that comes round on a rhythm. */
export async function makeRecurringAction(expenseId: string, payload: string): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requirePermission(PERMISSIONS.EXPENSES_CREATE);
    const input = recurringSchema.parse(parseJson(payload));
    const created = await createRecurringFromExpense({
      companyId: user.activeCompany.id,
      expenseId,
      name: input.name,
      frequency: input.frequency,
      nextDate: input.nextDate,
      endDate: input.endDate ?? null,
      userId: user.id,
    });
    revalidateAll([...paths.expenses, '/finance/expenses/recurring']);
    return { ok: true, data: { id: created.id }, message: `${input.name} will come round ${input.frequency.toLowerCase()}.` };
  } catch (error) {
    return fail(error);
  }
}

/** Make the draft that is due. It is a draft; posting is a separate, read decision. */
export async function generateRecurringAction(id: string): Promise<ActionResult<{ expenseId: string; number: string }>> {
  try {
    const user = await requirePermission(PERMISSIONS.EXPENSES_CREATE);
    const expense = await generateFromRecurring({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidateAll([...paths.expenses, '/finance/expenses/recurring']);
    return { ok: true, data: { expenseId: expense.id, number: expense.expenseNumber } };
  } catch (error) {
    return fail(error);
  }
}

export async function setRecurringStatusAction(id: string, status: 'ACTIVE' | 'INACTIVE'): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.EXPENSES_CREATE);
    await setRecurringStatus({ id, companyId: user.activeCompany.id, status, userId: user.id });
    revalidateAll(['/finance/expenses/recurring']);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function postExpenseAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.EXPENSES_POST);
    await postExpense({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidateAll([...paths.expenses, `/finance/expenses/${id}`, '/shipments']);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function reverseExpenseAction(id: string, reason: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.EXPENSES_POST);
    await reverseExpense({ id, companyId: user.activeCompany.id, userId: user.id, reason });
    revalidateAll([...paths.expenses, `/finance/expenses/${id}`, '/shipments']);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteExpenseAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.EXPENSES_DELETE);
    await deleteDraftExpense({ id, companyId: user.activeCompany.id, userId: user.id });
    revalidateAll(paths.expenses);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}
// ---------------------------------------------------------------------------
// Cheques
// ---------------------------------------------------------------------------

export async function changeChequeStatusAction(chequeId: string, payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.CHEQUES_UPDATE_STATUS);
    const input = chequeStatusSchema.parse(parseJson(payload));

    await changeChequeStatus({
      chequeId,
      companyId: user.activeCompany.id,
      userId: user.id,
      toStatus: input.toStatus,
      cashBankAccountId: input.cashBankAccountId,
      effectiveDate: input.effectiveDate ?? undefined,
      reason: input.reason,
      notes: input.notes,
    });

    revalidateAll([...paths.cheques, `/finance/cheques/${chequeId}`]);
    return { ok: true, id: chequeId, message: `Cheque marked ${input.toStatus.toLowerCase()}.` };
  } catch (error) {
    return toState(error);
  }
}

// ---------------------------------------------------------------------------
// Manual journal voucher
// ---------------------------------------------------------------------------

/**
 * Delete any posted entry, from wherever it is being read.
 *
 * The journal, a ledger, the cash book: a row that is in the books can be
 * taken back out of them from the screen it is on, whatever kind of document
 * put it there. A loan, a transfer between the company's own accounts, a
 * revaluation, an agent's settlement and a hand-raised voucher had no way to
 * be deleted at all before this.
 */
export async function deletePostedEntryAction(entryId: string, reason: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    await deletePostedEntry({ companyId: user.activeCompany.id, userId: user.id, entryId, reason });
    revalidateAll([...paths.journals, ...paths.receipts, ...paths.payments, ...paths.expenses]);
    revalidatePath('/agents');
    revalidatePath('/ledgers');
    revalidatePath('/sales');
    revalidatePath('/purchases');
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function postJournalVoucherAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const input = journalVoucherSchema.parse(parseJson(payload));

    // The voucher's identity is the key the form was opened with, so posting
    // is idempotent: the same form submitted twice posts once.
    const sourceId = input.clientKey ? `JV-${input.clientKey}` : `JV-${Date.now()}`;

    const entry = await transaction(async (tx) => {
      const already = await tx.journalEntry.findFirst({
        where: { companyId: user.activeCompany.id, sourceType: 'MANUAL', sourceId },
        select: { id: true, entryNumber: true },
      });
      if (already) return already;

      const company = await getCompanyContext(tx, user.activeCompany.id);
      return postJournalEntry(tx, {
        companyId: user.activeCompany.id,
        entryDate: input.entryDate,
        description: input.description,
        reference: input.reference,
        sourceType: 'MANUAL',
        sourceId,
        createdById: user.id,
        localCurrency: company.localCurrency,
        rateLocalPerUsd: input.rateLocalPerUsd,
        lines: input.lines.map((line) => ({
          accountId: line.accountId,
          direction: line.direction,
          currency: line.currency,
          amount: line.amount,
          rateToUsd: line.rateToUsd,
          description: line.description ?? undefined,
          customerId: line.customerId,
          vendorId: line.vendorId,
          agentId: line.agentId,
          shipmentId: line.shipmentId,
        })),
      });
    });

    revalidateAll(['/accounting/journal', '/reports', '/ledgers', '/ledgers/customers', '/ledgers/vendors', '/agents', '/dashboard']);
    return { ok: true, id: entry.id, message: `Journal voucher ${businessNumber(entry.entryNumber)} posted.` };
  } catch (error) {
    return toState(error);
  }
}

// ---------------------------------------------------------------------------
// Foreign currency revaluation
// ---------------------------------------------------------------------------

export async function postCashBankTransferAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const input = cashBankTransferSchema.parse(parseJson(payload));
    const entry = await postCashBankTransfer({
      companyId: user.activeCompany.id,
      userId: user.id,
      transferDate: input.transferDate,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amount: input.amount,
      receivedAmount: input.receivedAmount,
      reference: input.reference,
      description: input.description,
    });
    revalidateAll([...paths.expenses, '/finance/cash-bank', '/accounting/journal', '/reports', '/dashboard']);
    return { ok: true, id: entry.id, message: `Transfer posted as ${entry.entryNumber}.` };
  } catch (error) {
    return toState(error);
  }
}


/**
 * Lend money from one FID company to the other.
 *
 * Needs the right to post in both sets of books, because it writes to both.
 * A user who can only reach one company cannot move money between them.
 */
export async function postIntercompanyLoanAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const input = intercompanyLoanSchema.parse(parseJson(payload));

    const reachable = new Set(user.companies.map((c) => c.id));
    if (!reachable.has(input.fromCompanyId) || !reachable.has(input.toCompanyId)) {
      return { ok: false, error: 'You can only record a loan between companies you have access to.' };
    }

    const result = await postIntercompanyLoan({
      fromCompanyId: input.fromCompanyId,
      toCompanyId: input.toCompanyId,
      userId: user.id,
      transferDate: input.transferDate,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amount: input.amount,
      exchangeRate: input.exchangeRate,
      receivedAmount: input.receivedAmount,
      fromLoanAccountId: input.fromLoanAccountId,
      toLoanAccountId: input.toLoanAccountId,
      reference: input.reference,
      description: input.description,
    });

    revalidateAll(['/finance/cash-bank', '/accounting/journal', '/reports', '/dashboard', '/finance/expenses']);
    return {
      ok: true,
      id: result.lenderEntry.id,
      message: `Loan posted: ${result.lenderEntry.entryNumber} and ${result.borrowerEntry.entryNumber}.`,
    };
  } catch (error) {
    return toState(error);
  }
}

/**
 * A loan with anybody, in either direction.
 *
 * Distinct from the inter-company screen, which writes to two sets of books.
 * This writes to one: the money moved through a company account and the other
 * side is a ledger in somebody's name.
 */
export async function postLoanAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const { clientKey, ...input } = loanSchema.parse(parseJson(payload));

    // One Post is one loan, even if the button is pressed twice.
    const once = await onceForKey(
      { companyId: user.activeCompany.id, userId: user.id, scope: 'LOAN', key: clientKey },
      async () => {
        const result = await postLoan({
          companyId: user.activeCompany.id,
          userId: user.id,
          loanDate: input.loanDate,
          direction: input.direction,
          counterpartyName: input.counterpartyName,
          loanAccountId: input.loanAccountId,
          agentId: input.agentId,
          cashBankAccountId: input.cashBankAccountId,
          currency: input.currency,
          amount: input.amount,
          exchangeRate: input.exchangeRate,
          bankAmount: input.bankAmount,
          reference: input.reference,
          description: input.description,
        });
        return result.entry;
      },
    );

    revalidateAll([
      '/finance/cash-bank',
      '/finance/loans',
      '/accounting/journal',
      '/accounting/chart',
      '/reports',
      '/dashboard',
      '/agents',
      '/ledgers',
    ]);
    if (once.replayed) {
      return { ok: true, id: once.id, message: 'Already posted — this loan was recorded once.' };
    }
    const posted = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: once.id },
      select: { id: true, entryNumber: true, lines: { select: { account: { select: { name: true } } } } },
    });
    const loanLine = posted.lines.find((l) => /loan/i.test(l.account.name)) ?? posted.lines[posted.lines.length - 1];
    return {
      ok: true,
      id: posted.id,
      message: `${businessNumber(posted.entryNumber)} posted to ${loanLine?.account.name ?? 'the loan account'}.`,
    };
  } catch (error) {
    return toState(error);
  }
}

export async function postRevaluationAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const input = revaluationSchema.parse(parseJson(payload));

    const { entry } = await postRevaluation({
      companyId: user.activeCompany.id,
      asOf: input.asOf,
      rates: input.rates,
      userId: user.id,
    });

    revalidateAll(['/reports', '/accounting/journal', '/dashboard']);
    return { ok: true, id: entry.id, message: 'Revaluation posted.' };
  } catch (error) {
    return toState(error);
  }
}

// ---------------------------------------------------------------------------
// Overhead allocation (management view; nothing posts to the ledger)
// ---------------------------------------------------------------------------

/**
 * Share a period's general expenses across shipments for management
 * reporting. The expenses stay exactly where they are on the company profit
 * and loss; this records a view beside them.
 */
export async function allocateOverheadsAction(payload: string): Promise<ActionResult<{ shipments: number }>> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    const input = allocateOverheadsSchema.parse(parseJson(payload));
    const allocation = await allocateOverheads({
      companyId: user.activeCompany.id,
      userId: user.id,
      from: input.from,
      to: input.to,
      basis: input.basis,
      shipments: input.shipments,
      notes: input.notes,
    });
    revalidatePath('/reports/overhead-allocation');
    revalidatePath('/reports/analytics');
    revalidatePath('/profitability');
    return ok({ shipments: allocation.lines.length });
  } catch (error) {
    return fail(error);
  }
}

/** Withdraw an allocation. The expenses are untouched; only the view goes. */
export async function withdrawOverheadAllocationAction(id: string): Promise<ActionResult<undefined>> {
  try {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_POST);
    await withdrawOverheadAllocation({ companyId: user.activeCompany.id, id, userId: user.id });
    revalidatePath('/reports/overhead-allocation');
    revalidatePath('/profitability');
    return ok(undefined);
  } catch (error) {
    return fail(error);
  }
}
