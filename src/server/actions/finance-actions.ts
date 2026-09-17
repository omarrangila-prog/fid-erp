'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { fieldErrors } from '@/lib/validation/common';
import {
  agentSettlementSchema,
  receiptSchema,
  paymentSchema,
  expenseSchema,
  splitExpenseSchema,
  chequeStatusSchema,
  journalVoucherSchema,
  revaluationSchema,
  cashBankTransferSchema,
  intercompanyLoanSchema,
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
import { createAgentSettlement, postAgentSettlement } from '@/lib/services/agent-ledger';
import { postRevaluation } from '@/lib/services/revaluation';
import { postJournalEntry } from '@/lib/services/accounting';
import { postCashBankTransfer, postIntercompanyLoan } from '@/lib/services/cash-transfer';
import {
  createRecurringFromExpense,
  generateFromRecurring,
  setRecurringStatus,
} from '@/lib/services/recurring-expense';
import { dateString, optionalDateString, requiredText } from '@/lib/validation/common';
import { getCompanyContext } from '@/lib/services/company';
import { transaction } from '@/lib/db';
import { fail, type ActionResult } from '@/server/actions/action-utils';
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
    const input = receiptSchema.parse(parseJson(payload));
    const data = { companyId: user.activeCompany.id, ...input, cheque: input.cheque ?? null };

    const result = id ? await updateReceipt(id, data, user.id) : await createReceipt(data, user.id);

    revalidateAll(paths.receipts);
    return { ok: true, id: result.id, message: id ? 'Receipt updated.' : 'Receipt created.' };
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
export async function recordAgentSettlementAction(payload: string): Promise<DocFormState> {
  try {
    const user = await requirePermission(PERMISSIONS.RECEIPTS_POST);
    const input = agentSettlementSchema.parse(parseJson(payload));

    const created = await createAgentSettlement(
      { companyId: user.activeCompany.id, ...input },
      user.id,
    );
    await postAgentSettlement({ id: created.id, companyId: user.activeCompany.id, userId: user.id });

    revalidateAll(paths.receipts);
    revalidatePath('/agents');
    revalidatePath(`/agents/${input.agentId}`);
    return {
      ok: true,
      id: created.id,
      message:
        input.direction === 'COLLECTION'
          ? 'Recorded. The money is now in the account you chose.'
          : 'Commission paid.',
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
    const input = paymentSchema.parse(parseJson(payload));
    const data = { companyId: user.activeCompany.id, ...input, cheque: input.cheque ?? null };

    const result = id ? await updatePayment(id, data, user.id) : await createPayment(data, user.id);

    revalidateAll(paths.payments);
    return { ok: true, id: result.id, message: id ? 'Payment updated.' : 'Payment created.' };
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
    const input = expenseSchema.parse(parseJson(payload));
    const data = { companyId: user.activeCompany.id, ...input };

    const result = id ? await updateExpense(id, data, user.id) : await createExpense(data, user.id);

    revalidateAll(paths.expenses);
    return { ok: true, id: result.id, message: id ? 'Expense updated.' : 'Expense created.' };
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
    const input = splitExpenseSchema.parse(parseJson(payload));

    // One transaction for the whole split: nesting `transaction()` would open a
    // second connection rather than joining this one, so the services are
    // called through their tx-body variants and share this `tx`.
    const ids = await transaction(async (tx) => {
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

    revalidateAll([...paths.expenses, '/shipments', '/finance/cash-bank']);
    return { ok: true, data: { ids } };
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
          shipmentId: line.shipmentId,
        })),
      });
    });

    revalidateAll(['/accounting/journal', '/reports', '/ledgers/customers', '/ledgers/vendors', '/dashboard']);
    return { ok: true, id: entry.id, message: `Journal voucher ${entry.entryNumber} posted.` };
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
