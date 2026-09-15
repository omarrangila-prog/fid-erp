import { transaction } from '@/lib/db';
import type { Tx } from '@/lib/db';
import type { PaymentMethod } from '@prisma/client';
import { dec, toMoney, convertToUsd, convertFromUsd } from '@/lib/money';
import { ACCOUNT_KEYS, DOC_TYPES } from '@/lib/constants';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { nextReference } from '@/lib/services/numbering';
import { postJournalEntry, reverseJournalEntry, type JournalLineInput } from '@/lib/services/accounting';
import { applyLandedCost } from '@/lib/services/landed-cost';
import { getCompanyContext } from '@/lib/services/company';
import { resolveSubledgerLeg } from '@/lib/services/subledger';
import { writeAudit } from '@/lib/services/audit';
import { resolveTaxCode, computeLineTax, NO_TAX, supplierInvoiceIncludesInputTax, supplierGrossPayable } from '@/lib/services/tax';
import { EXPENSE_TRACE_OMIT, expenseTraceIds, expenseTraceWrite, expensesHaveTraceColumns } from '@/lib/services/expense-columns';

/**
 * ExpenseService — shipment and operating costs.
 *
 * Dubai expenses are normally AED and Morocco's are MAD, while the shipments
 * they belong to are costed in USD. Every expense therefore stores the same
 * three-way currency record as a receipt, and shipment net profit is reduced by
 * the USD equivalent captured at the time of posting.
 *
 * An expense is either paid immediately from a cash/bank account, or booked
 * unpaid to be paid later. Unpaid costs still raise shipment landed cost on
 * the day they are recorded. A named supplier or agent is optional.
 */

export type ExpenseInput = {
  companyId: string;
  expenseDate: Date;
  expenseCategoryId: string;
  shipmentId?: string | null;
  purchaseContractId?: string | null;
  containerId?: string | null;
  batchId?: string | null;
  vendorId?: string | null;
  agentId?: string | null;
  /** Owed to this agent rather than paid now — commission, typically. */
  payableToAgentId?: string | null;
  currency: string;
  amount: string | number;
  rateToUsd: string | number;
  rateLocalPerUsd: string | number;
  cashBankAccountId?: string | null;
  paymentMethod?: PaymentMethod;
  /** Overrides the category default. Direct shipment costs are capitalised
   *  into landed cost; period costs go straight to the profit and loss. */
  capitaliseToLandedCost?: boolean;
  /** Shipment cost or company overhead. Defaults to the category's own kind. */
  kind?: 'SHIPMENT' | 'GENERAL';
  /** `amount` stays net of this. Omitted means the company default. */
  taxCodeId?: string | null;
  reference?: string | null;
  description?: string | null;
};

function computeExpenseAmounts(input: ExpenseInput & { localCurrency: string }) {
  const currency = input.currency.toUpperCase();
  const amount = toMoney(input.amount);

  if (amount.lessThanOrEqualTo(0)) throw new BusinessRuleError('The expense amount must be greater than zero.');

  const rateToUsd = dec(input.rateToUsd);
  if (currency === 'USD' && !rateToUsd.equals(1)) {
    throw new BusinessRuleError('The USD exchange rate must be exactly 1.');
  }
  if (rateToUsd.lessThanOrEqualTo(0)) throw new BusinessRuleError(`An exchange rate is required for ${currency}.`);

  const amountUsd = convertToUsd(amount, rateToUsd, currency);
  // A voucher already in the company's own currency uses its own rate locally.
  const rateLocalPerUsd =
    currency === input.localCurrency.toUpperCase() ? rateToUsd : dec(input.rateLocalPerUsd);
  const amountLocal =
    currency === input.localCurrency.toUpperCase()
      ? amount
      : convertFromUsd(amountUsd, rateLocalPerUsd, input.localCurrency);

  return { currency, amount, rateToUsd, amountUsd, rateLocalPerUsd, amountLocal };
}

async function validateReferences(tx: Tx, input: ExpenseInput) {
  /*
   * Paid now from cash or bank, or booked unpaid to pay later.
   *
   * A named supplier or agent is optional. Unpaid with no payee credits
   * accounts payable as an accrual; Record payment later moves the cash.
   * Owed to an agent still credits commission payable so the agent ledger
   * stays complete when that path is used from tests or older vouchers.
   */
  const settlements = [input.cashBankAccountId, input.vendorId, input.payableToAgentId].filter(Boolean);

  if (settlements.length > 1) {
    throw new BusinessRuleError(
      'A cost is settled one way only — paid from cash/bank, owed to a supplier, or owed to an agent. Record the payment separately.',
    );
  }

  if (input.payableToAgentId) {
    const agent = await tx.agent.findFirst({
      where: { id: input.payableToAgentId, companyId: input.companyId },
      select: { id: true, agentName: true, status: true },
    });
    if (!agent) throw new NotFoundError('Agent');
    if (agent.status !== 'ACTIVE') {
      throw new BusinessRuleError(`${agent.agentName} is inactive, so nothing can be booked as owed to them.`);
    }
  }

  const category = await tx.expenseCategory.findFirst({
    where: { id: input.expenseCategoryId, companyId: input.companyId },
    select: { id: true, name: true, glAccountId: true, status: true, capitaliseByDefault: true, kind: true },
  });
  if (!category) throw new NotFoundError('Expense category');
  if (category.status !== 'ACTIVE') throw new BusinessRuleError(`${category.name} is an inactive expense category.`);

  if (input.cashBankAccountId) {
    const account = await tx.cashBankAccount.findFirst({
      where: { id: input.cashBankAccountId, companyId: input.companyId },
      select: { currency: true, name: true, status: true },
    });
    if (!account) throw new NotFoundError('Cash/bank account');
    if (account.status !== 'ACTIVE') throw new BusinessRuleError(`${account.name} is inactive and cannot be used.`);
    if (account.currency.toUpperCase() !== input.currency.toUpperCase()) {
      throw new BusinessRuleError(
        `${account.name} is a ${account.currency} account, so it cannot pay a ${input.currency} expense.`,
      );
    }
  }

  if (input.shipmentId) {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, companyId: input.companyId },
      select: { id: true, purchaseContractId: true },
    });
    if (!shipment) throw new NotFoundError('Shipment');
    input.purchaseContractId = input.purchaseContractId || shipment.purchaseContractId;
  }

  if (input.agentId) {
    const agent = await tx.agent.findFirst({
      where: { id: input.agentId, companyId: input.companyId },
      select: { id: true },
    });
    if (!agent) throw new NotFoundError('Agent');
  }

  /**
   * Naming a shipment is itself the statement that this belongs to a job —
   * a bank charge on one consignment's remittance is a shipment expense even
   * though bank charges are usually overheads. So the shipment wins over the
   * category's own default, and only an explicit `kind` overrides both.
   */
  const kind = input.kind ?? (input.shipmentId ? 'SHIPMENT' : category.kind);

  if ((input.containerId || input.batchId) && !input.shipmentId) {
    throw new BusinessRuleError('A container or batch can only be named on a shipment expense.');
  }
  if (kind === 'GENERAL' && (input.containerId || input.batchId)) {
    throw new BusinessRuleError('A general company expense does not belong to a container or a batch.');
  }

  if (input.containerId) {
    const container = await tx.container.findFirst({
      where: { id: input.containerId, companyId: input.companyId },
      select: { id: true, shipmentId: true, containerNumber: true },
    });
    if (!container) throw new NotFoundError('Container');
    if (container.shipmentId !== input.shipmentId) {
      throw new BusinessRuleError(`${container.containerNumber} does not belong to this shipment.`);
    }
  }

  if (input.batchId) {
    const batch = await tx.batch.findFirst({
      where: { id: input.batchId, companyId: input.companyId },
      select: { id: true, shipmentId: true, containerId: true, batchNumber: true },
    });
    if (!batch) throw new NotFoundError('Batch');
    if (batch.shipmentId !== input.shipmentId) {
      throw new BusinessRuleError(`${batch.batchNumber} does not belong to this shipment.`);
    }
    if (input.containerId && batch.containerId && batch.containerId !== input.containerId) {
      throw new BusinessRuleError(`${batch.batchNumber} is not in that container.`);
    }
    if (!input.containerId && batch.containerId) {
      input.containerId = batch.containerId;
    }
  }

  // A shipment cost has to say which shipment. Without that it cannot reach a
  // job cost report, a landed cost or a profitability figure — it would be an
  // overhead wearing a shipment category's name.
  if (kind === 'SHIPMENT' && !input.shipmentId) {
    throw new BusinessRuleError(
      `${category.name} is a shipment cost, so it has to name the shipment it belongs to. If this is a running cost of the business rather than one consignment, record it as a general company expense instead.`,
    );
  }

  // And the reverse: a general expense that names a shipment would quietly
  // appear on that shipment's cost report while being treated as an overhead.
  if (kind === 'GENERAL' && input.shipmentId) {
    throw new BusinessRuleError(
      'A general company expense does not belong to a shipment. Either clear the shipment, or record it as a shipment expense.',
    );
  }

  const capitalise = kind === 'SHIPMENT' && (input.capitaliseToLandedCost ?? category.capitaliseByDefault);
  if (capitalise && !input.shipmentId) {
    throw new BusinessRuleError(
      `${category.name} is a direct shipment cost, so it must be linked to a job/shipment for its landed cost to be allocated. Either choose a shipment or record it as a period expense.`,
    );
  }

  return { category, capitalise, kind };
}

/**
 * Recoverable tax on a bill.
 *
 * `amount` is deliberately the net cost, not the gross the supplier billed. A
 * capitalised expense flows into the landed cost of a batch, and reclaimable
 * tax is not a cost of that coffee: including it would inflate every margin the
 * batch ever earns and the money would then be reclaimed a second time from the
 * authority.
 */
async function resolveExpenseTax(
  tx: Tx,
  input: ExpenseInput,
  amounts: { amount: ReturnType<typeof toMoney>; currency: string; rateToUsd: ReturnType<typeof dec> },
) {
  const company = await tx.company.findUniqueOrThrow({
    where: { id: input.companyId },
    select: { taxEnabled: true, country: true },
  });
  let vendorCountry: string | null = null;
  if (input.vendorId) {
    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, companyId: input.companyId },
      select: { country: true },
    });
    vendorCountry = vendor?.country ?? null;
  }
  // A bill paid from cash with no supplier is a local invoice — tax still applies.
  // A named foreign supplier does not charge the company's VAT/TVA.
  const taxOnInvoice = !input.vendorId || supplierInvoiceIncludesInputTax(vendorCountry, company.country);
  const code = taxOnInvoice
    ? await resolveTaxCode(tx, {
        companyId: input.companyId,
        taxEnabled: company.taxEnabled,
        taxCodeId: input.taxCodeId,
        appliesTo: 'PURCHASE',
      })
    : NO_TAX;
  const computed = computeLineTax({
    netAmount: amounts.amount,
    ratePct: code.ratePct,
    rateToUsd: amounts.rateToUsd,
    currency: amounts.currency,
  });
  return {
    taxCodeId: code.id,
    taxRatePct: code.ratePct,
    taxAmount: computed.taxAmount,
    taxAmountUsd: computed.taxAmountUsd,
  };
}

export async function createExpense(input: ExpenseInput, userId: string) {
  return transaction(async (tx) => {
    const company = await getCompanyContext(tx, input.companyId);
    const { category, capitalise, kind } = await validateReferences(tx, input);
    const amounts = computeExpenseAmounts({ ...input, localCurrency: company.localCurrency });
    const tax = await resolveExpenseTax(tx, input, amounts);

    const expenseNumber = await nextReference(tx, {
      companyId: input.companyId,
      docType: DOC_TYPES.EXPENSE,
    });

    const expense = await tx.expense.create({
      data: {
        companyId: input.companyId,
        expenseNumber,
        expenseDate: input.expenseDate,
        expenseCategoryId: input.expenseCategoryId,
        shipmentId: input.shipmentId ?? null,
        purchaseContractId: input.purchaseContractId ?? null,
        ...(await expenseTraceWrite(tx, input)),
        vendorId: input.vendorId ?? null,
        payableToAgentId: input.payableToAgentId ?? null,
        agentId: input.agentId ?? null,
        currency: amounts.currency,
        amount: amounts.amount,
        rateToUsd: amounts.rateToUsd,
        amountUsd: amounts.amountUsd,
        rateLocalPerUsd: amounts.rateLocalPerUsd,
        amountLocal: amounts.amountLocal,
        cashBankAccountId: input.cashBankAccountId ?? null,
        paymentMethod: input.paymentMethod ?? 'BANK_TRANSFER',
        capitaliseToLandedCost: capitalise,
        kind,
        taxCodeId: tax.taxCodeId,
        taxRatePct: tax.taxRatePct,
        taxAmount: tax.taxAmount,
        taxAmountUsd: tax.taxAmountUsd,
        reference: input.reference ?? null,
        description: input.description ?? null,
        status: 'DRAFT',
        createdById: userId,
      },
      omit: EXPENSE_TRACE_OMIT,
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'EXPENSE_CREATED',
      entityType: 'Expense',
      entityId: expense.id,
      after: {
        expenseNumber,
        category: category.name,
        amount: amounts.amount,
        currency: amounts.currency,
        capitalised: capitalise,
      },
    });

    return expense;
  });
}

export async function updateExpense(id: string, input: ExpenseInput, userId: string) {
  return transaction(async (tx) => {
    const existing = await tx.expense.findFirst({
      where: { id, companyId: input.companyId },
      omit: EXPENSE_TRACE_OMIT,
    });
    if (!existing) throw new NotFoundError('Expense');
    if (existing.status !== 'DRAFT') {
      throw new BusinessRuleError('Only draft expenses can be edited. Reverse the expense to correct a posted one.');
    }

    const company = await getCompanyContext(tx, input.companyId);
    const { capitalise, kind } = await validateReferences(tx, input);
    const amounts = computeExpenseAmounts({ ...input, localCurrency: company.localCurrency });
    const tax = await resolveExpenseTax(tx, input, amounts);

    const expense = await tx.expense.update({
      where: { id },
      data: {
        expenseDate: input.expenseDate,
        expenseCategoryId: input.expenseCategoryId,
        shipmentId: input.shipmentId ?? null,
        purchaseContractId: input.purchaseContractId ?? null,
        ...(await expenseTraceWrite(tx, input)),
        vendorId: input.vendorId ?? null,
        payableToAgentId: input.payableToAgentId ?? null,
        agentId: input.agentId ?? null,
        currency: amounts.currency,
        amount: amounts.amount,
        rateToUsd: amounts.rateToUsd,
        amountUsd: amounts.amountUsd,
        rateLocalPerUsd: amounts.rateLocalPerUsd,
        amountLocal: amounts.amountLocal,
        cashBankAccountId: input.cashBankAccountId ?? null,
        paymentMethod: input.paymentMethod ?? 'BANK_TRANSFER',
        capitaliseToLandedCost: capitalise,
        kind,
        taxCodeId: tax.taxCodeId,
        taxRatePct: tax.taxRatePct,
        taxAmount: tax.taxAmount,
        taxAmountUsd: tax.taxAmountUsd,
        reference: input.reference ?? null,
        description: input.description ?? null,
      },
      omit: EXPENSE_TRACE_OMIT,
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId,
      action: 'EXPENSE_UPDATED',
      entityType: 'Expense',
      entityId: id,
      before: { amount: existing.amount, currency: existing.currency },
      after: { amount: expense.amount, currency: expense.currency },
    });

    return expense;
  });
}

export async function postExpense(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM expenses
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Expense');
    if (locked[0].status !== 'DRAFT') {
      throw new BusinessRuleError(`This expense is already ${locked[0].status.toLowerCase()} and cannot be posted again.`);
    }

    const hasTrace = await expensesHaveTraceColumns(tx);
    const expense = await tx.expense.findUniqueOrThrow({
      where: { id: params.id },
      ...(hasTrace ? {} : { omit: EXPENSE_TRACE_OMIT }),
      include: {
        expenseCategory: true,
        cashBankAccount: true,
        vendor: true,
        payableToAgent: { select: { agentName: true } },
      },
    });
    const company = await getCompanyContext(tx, params.companyId);

    // ---------------------------------------------------------------------
    // The credit side: paid from cash/bank, or owed to a supplier.
    // ---------------------------------------------------------------------
    // A local bill (cash, or a supplier in the same tax jurisdiction) is paid
    // gross of tax. A foreign supplier is paid the net — their invoice does
    // not carry the buyer's VAT/TVA.
    const payable = supplierGrossPayable({
      netAmount: expense.amount,
      taxAmount: expense.taxAmount,
      netAmountUsd: expense.amountUsd,
      taxAmountUsd: expense.taxAmountUsd,
      vendorCountry: expense.vendor?.country,
      companyCountry: company.country,
    });
    const grossAmount = expense.vendorId
      ? payable.amount
      : toMoney(dec(expense.amount).plus(expense.taxAmount));
    const grossAmountUsd = expense.vendorId
      ? payable.amountUsd
      : toMoney(dec(expense.amountUsd).plus(expense.taxAmountUsd));

    const creditLine: JournalLineInput = expense.cashBankAccountId
      ? {
          cashBankAccountId: expense.cashBankAccountId,
          direction: 'CREDIT',
          currency: expense.currency,
          amount: grossAmount,
          rateToUsd: expense.rateToUsd,
          description: `Paid from ${expense.cashBankAccount?.name ?? 'cash/bank'}`,
          shipmentId: expense.shipmentId,
        }
      : expense.payableToAgent
      ? {
          // A cost of the shipment now; money out of the bank later, when the
          // agent is actually paid and the settlement clears this balance.
          accountKey: ACCOUNT_KEYS.AGENT_COMMISSION_PAYABLE,
          direction: 'CREDIT' as const,
          currency: expense.currency,
          amount: grossAmount,
          rateToUsd: expense.rateToUsd,
          description: `Owed to ${expense.payableToAgent.agentName}`,
          agentId: expense.payableToAgentId,
          shipmentId: expense.shipmentId,
        }
      : expense.vendor
      ? (() => {
          const ap = resolveSubledgerLeg({
            partyCurrency: expense.vendor.primaryCurrency,
            voucherCurrency: expense.currency,
            voucherAmount: grossAmount,
            voucherRateToUsd: expense.rateToUsd,
            voucherAmountUsd: grossAmountUsd,
            localCurrency: company.localCurrency,
            rateLocalPerUsd: expense.rateLocalPerUsd,
            partyLabel: expense.vendor.vendorName,
          });
          return {
            accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
            direction: 'CREDIT' as const,
            currency: ap.currency,
            amount: ap.amount,
            rateToUsd: ap.rateToUsd,
            description: `Payable to ${expense.vendor.vendorName}`,
            vendorId: expense.vendorId,
            shipmentId: expense.shipmentId,
          };
        })()
      : {
          accountKey: ACCOUNT_KEYS.ACCOUNTS_PAYABLE,
          direction: 'CREDIT' as const,
          currency: expense.currency,
          amount: grossAmount,
          rateToUsd: expense.rateToUsd,
          description: `Unpaid ${expense.expenseCategory.name} — to be paid later`,
          shipmentId: expense.shipmentId,
        };

    // ---------------------------------------------------------------------
    // The debit side.
    //
    // A direct shipment cost is capitalised into the landed cost of the coffee
    // rather than expensed: it raises the value of stock still on hand, and the
    // share belonging to coffee already sold is trued up straight into cost of
    // goods sold so the ledger keeps agreeing with the profitability report.
    // ---------------------------------------------------------------------
    const debitLines: JournalLineInput[] = [];

    if (dec(expense.taxAmount).greaterThan(0) && (!expense.vendorId || payable.taxOnSupplierInvoice)) {
      debitLines.push({
        accountKey: ACCOUNT_KEYS.VAT_INPUT,
        direction: 'DEBIT',
        currency: expense.currency,
        amount: expense.taxAmount,
        rateToUsd: expense.rateToUsd,
        description: `Input tax on ${expense.expenseNumber}`,
      });
    }

    if (expense.capitaliseToLandedCost && expense.shipmentId) {
      const landed = await applyLandedCost(tx, {
        companyId: params.companyId,
        shipmentId: expense.shipmentId,
        amountUsd: expense.amountUsd,
        reference: expense.expenseNumber,
        ...expenseTraceIds(expense, hasTrace),
      });

      // The engine has already split the cost three ways by kilograms. Any
      // rounding residue between the three shares and the voucher stays with
      // the coffee on the shelf, so the entry always sums to what was paid.
      const shelfUsd = toMoney(
        dec(expense.amountUsd).minus(landed.totalTrueUpUsd).minus(landed.totalInTransitUsd),
      );

      if (shelfUsd.greaterThan(0)) {
        debitLines.push({
          accountKey: ACCOUNT_KEYS.INVENTORY,
          direction: 'DEBIT',
          currency: 'USD',
          amount: shelfUsd,
          rateToUsd: 1,
          description: `${expense.expenseCategory.name} capitalised into landed cost`,
          shipmentId: expense.shipmentId,
          purchaseContractId: expense.purchaseContractId,
        });
      }

      if (landed.totalInTransitUsd.greaterThan(0)) {
        debitLines.push({
          accountKey: ACCOUNT_KEYS.INVENTORY_IN_TRANSIT,
          direction: 'DEBIT',
          currency: 'USD',
          amount: landed.totalInTransitUsd,
          rateToUsd: 1,
          description: `${expense.expenseCategory.name} on coffee still in transit`,
          shipmentId: expense.shipmentId,
          purchaseContractId: expense.purchaseContractId,
        });
      }

      if (landed.totalTrueUpUsd.greaterThan(0)) {
        debitLines.push({
          accountKey: ACCOUNT_KEYS.COST_OF_GOODS_SOLD,
          direction: 'DEBIT',
          currency: 'USD',
          amount: landed.totalTrueUpUsd,
          rateToUsd: 1,
          description: `${expense.expenseCategory.name} on coffee already sold`,
          shipmentId: expense.shipmentId,
          purchaseContractId: expense.purchaseContractId,
        });
      }
    } else {
      debitLines.push({
        ...(expense.expenseCategory.glAccountId
          ? { accountId: expense.expenseCategory.glAccountId }
          : { accountKey: ACCOUNT_KEYS.EXPENSE_DEFAULT }),
        direction: 'DEBIT',
        currency: expense.currency,
        amount: expense.amount,
        rateToUsd: expense.rateToUsd,
        description: `${expense.expenseCategory.name} — ${expense.expenseNumber}`,
        shipmentId: expense.shipmentId,
        purchaseContractId: expense.purchaseContractId,
        vendorId: expense.vendorId,
      });
    }

    await postJournalEntry(tx, {
      companyId: params.companyId,
      entryDate: expense.expenseDate,
      description: `Expense ${expense.expenseNumber} — ${expense.expenseCategory.name}`,
      sourceType: 'EXPENSE',
      sourceId: expense.id,
      createdById: params.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd: expense.rateLocalPerUsd,
      lines: [...debitLines, creditLine],
    });

    const posted = await tx.expense.update({
      where: { id: expense.id },
      data: { status: 'POSTED', postedAt: new Date() },
      omit: EXPENSE_TRACE_OMIT,
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'EXPENSE_POSTED',
      entityType: 'Expense',
      entityId: expense.id,
      before: { status: 'DRAFT' },
      after: { status: 'POSTED', amount: expense.amount, currency: expense.currency, amountUsd: expense.amountUsd },
    });

    return posted;
  });
}

export async function reverseExpense(params: { id: string; companyId: string; userId: string; reason: string }) {
  return transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"::text FROM expenses
      WHERE "id" = ${params.id} AND "companyId" = ${params.companyId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Expense');
    if (locked[0].status !== 'POSTED') throw new BusinessRuleError('Only a posted expense can be reversed.');

    const hasTrace = await expensesHaveTraceColumns(tx);
    const expense = await tx.expense.findUniqueOrThrow({
      where: { id: params.id },
      ...(hasTrace ? {} : { omit: EXPENSE_TRACE_OMIT }),
    });
    const reversalDate = new Date();

    // Unwind the capitalisation before reversing the journal so the batch
    // landed costs and the ledger move back together.
    if (expense.capitaliseToLandedCost && expense.shipmentId) {
      await applyLandedCost(tx, {
        companyId: params.companyId,
        shipmentId: expense.shipmentId,
        amountUsd: dec(expense.amountUsd).negated(),
        reference: `${expense.expenseNumber} reversal`,
        ...expenseTraceIds(expense, hasTrace),
      });
    }

    await reverseJournalEntry(tx, {
      companyId: params.companyId,
      sourceType: 'EXPENSE',
      sourceId: params.id,
      createdById: params.userId,
      entryDate: reversalDate,
      reason: params.reason,
    });

    const reversed = await tx.expense.update({
      where: { id: params.id },
      data: { status: 'REVERSED', reversedAt: reversalDate, reversalReason: params.reason },
      omit: EXPENSE_TRACE_OMIT,
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'EXPENSE_REVERSED',
      entityType: 'Expense',
      entityId: params.id,
      before: { status: 'POSTED' },
      after: { status: 'REVERSED', reason: params.reason },
    });

    return reversed;
  });
}

export async function deleteDraftExpense(params: { id: string; companyId: string; userId: string }) {
  return transaction(async (tx) => {
    const expense = await tx.expense.findFirst({
      where: { id: params.id, companyId: params.companyId },
      omit: EXPENSE_TRACE_OMIT,
    });
    if (!expense) throw new NotFoundError('Expense');
    if (expense.status !== 'DRAFT') {
      throw new BusinessRuleError('Only draft expenses can be deleted. Posted expenses must be reversed.');
    }
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'EXPENSE_DELETED',
      entityType: 'Expense',
      entityId: expense.id,
      before: { expenseNumber: expense.expenseNumber, amount: expense.amount },
    });
    await tx.expense.delete({ where: { id: params.id }, omit: EXPENSE_TRACE_OMIT });
  });
}
