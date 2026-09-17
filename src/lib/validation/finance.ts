import { z } from 'zod';
import {
  currencyCode,
  cuid,
  dateString,
  decimalString,
  optionalCuid,
  optionalDateString,
  optionalDecimalString,
  optionalText,
  requiredText,
  requiredChoice,
} from '@/lib/validation/common';

/** Receipt, payment, expense and cheque schemas. */

const chequeDetails = z.object({
  chequeNumber: requiredText('Cheque number', 40),
  chequeDate: dateString('Cheque date'),
  bankName: requiredText('Bank', 120),
  beneficiary: optionalText(160),
  agentId: optionalCuid,
  notes: optionalText(400),
});

export const receiptSchema = z
  .object({
    receiptDate: dateString('Receipt date'),
    customerId: cuid,
    currency: currencyCode,
    amount: decimalString('Amount'),
    /** Either a rate or an explicit USD value must be supplied for a non-USD receipt. */
    rateToUsd: optionalDecimalString('Exchange rate'),
    usdEquivalent: optionalDecimalString('USD equivalent'),
    rateLocalPerUsd: decimalString('Local exchange rate'),
    paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'AGENT_COLLECTION']),
    cashBankAccountId: optionalCuid,
    /** Who collected it, when the customer paid an agent rather than the company. */
    agentId: optionalCuid,
    cheque: chequeDetails.nullish(),
    shipmentId: optionalCuid,
    reference: optionalText(120),
    description: optionalText(600),
    allocations: z
      .array(z.object({ salesInvoiceId: cuid, amount: decimalString('Allocation') }))
      .default([]),
  })
  .refine(
    (v) => v.currency === 'USD' || Number(v.rateToUsd) > 0 || Number(v.usdEquivalent) > 0,
    { message: 'Enter either an exchange rate or the USD equivalent.', path: ['rateToUsd'] },
  )
  .refine(
    (v) =>
      v.paymentMethod === 'CHEQUE' ||
      v.paymentMethod === 'AGENT_COLLECTION' ||
      Boolean(v.cashBankAccountId),
    {
      message: 'Choose the cash or bank account the money was received into.',
      path: ['cashBankAccountId'],
    },
  )
  .refine((v) => v.paymentMethod !== 'AGENT_COLLECTION' || Boolean(v.agentId), {
    message: 'Choose the agent who collected this money.',
    path: ['agentId'],
  });

export const paymentSchema = z
  .object({
    paymentDate: dateString('Payment date'),
    /** Blank when the payment settles costs that were booked without a supplier. */
    vendorId: optionalCuid,
    currency: currencyCode,
    amount: decimalString('Amount'),
    rateToUsd: decimalString('Exchange rate'),
    rateLocalPerUsd: decimalString('Local exchange rate'),
    paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE']),
    cashBankAccountId: optionalCuid,
    cheque: chequeDetails.nullish(),
    shipmentId: optionalCuid,
    reference: optionalText(60),
    description: optionalText(600),
    // A payment settles a purchase contract or a cost billed by the same
    // supplier. One or the other, never both on a line.
    allocations: z
      .array(
        z
          .object({
            purchaseContractId: optionalCuid,
            expenseId: optionalCuid,
            amount: decimalString('Allocation'),
          })
          .refine((a) => Boolean(a.purchaseContractId) !== Boolean(a.expenseId), {
            message: 'Each allocation settles one document.',
            path: ['purchaseContractId'],
          }),
      )
      .default([]),
  })
  .refine((v) => v.paymentMethod === 'CHEQUE' || Boolean(v.cashBankAccountId), {
    message: 'Choose the cash or bank account the money was paid from.',
    path: ['cashBankAccountId'],
  })
  // Without a supplier there is nothing for money to sit against, so every
  // dirham has to be put against a cost.
  .refine((v) => Boolean(v.vendorId) || v.allocations.length > 0, {
    message: 'Choose a supplier, or put the payment against the cost it settles.',
    path: ['vendorId'],
  });

export const expenseSchema = z.object({
  expenseDate: dateString('Expense date'),
  expenseCategoryId: cuid,
  shipmentId: optionalCuid,
  purchaseContractId: optionalCuid,
  containerId: optionalCuid,
  batchId: optionalCuid,
  vendorId: optionalCuid,
  agentId: optionalCuid,
  /** Owed to this agent rather than paid now — commission, typically. */
  payableToAgentId: optionalCuid,
  currency: currencyCode,
  amount: decimalString('Amount'),
  rateToUsd: decimalString('Exchange rate'),
  rateLocalPerUsd: decimalString('Local exchange rate'),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE']),
  cashBankAccountId: optionalCuid,
  capitaliseToLandedCost: z.coerce.boolean().optional(),
  kind: z.enum(['SHIPMENT', 'GENERAL']),
  taxCodeId: optionalCuid,
  reference: optionalText(60),
  description: optionalText(600),
});

/**
 * One payment spread across several cost categories.
 *
 * Everything that describes the payment — the date, who was paid or is owed,
 * the currency and the rate — is stated once in the header; the lines say what
 * the money was for. Each line becomes an expense in its own right, because in
 * this business two categories on one payment can be treated differently: port
 * charges are capitalised into the coffee, a staff dinner is not, and a single
 * record could not be both.
 */
export const splitExpenseSchema = z.object({
  expenseDate: dateString('Expense date'),
  kind: z.enum(['SHIPMENT', 'GENERAL']),
  shipmentId: optionalCuid,
  vendorId: optionalCuid,
  agentId: optionalCuid,
  payableToAgentId: optionalCuid,
  currency: currencyCode,
  rateToUsd: decimalString('Exchange rate'),
  rateLocalPerUsd: decimalString('Local exchange rate'),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE']),
  cashBankAccountId: optionalCuid,
  reference: optionalText(60),
  lines: z
    .array(
      z.object({
        expenseCategoryId: cuid,
        description: optionalText(600),
        amount: decimalString('Amount'),
        containerId: optionalCuid,
        batchId: optionalCuid,
        taxCodeId: optionalCuid,
      }),
    )
    .min(2, 'A split needs at least two lines. Use the ordinary expense form for a single category.')
    .max(20, 'Twenty lines is the most one payment can be split across.'),
});

export const chequeStatusSchema = z.object({
  toStatus: z.enum(['RECEIVED', 'DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED']),
  cashBankAccountId: optionalCuid,
  effectiveDate: optionalDateString,
  reason: optionalText(400),
  notes: optionalText(400),
});

export const journalVoucherSchema = z.object({
  /**
   * Issued once by the form when it opens. A second submit of the same form
   * — a double click, a retry after a slow network — carries the same key
   * and returns the entry already posted rather than posting it again.
   */
  clientKey: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional(),
  entryDate: dateString('Entry date'),
  description: requiredText('Description', 300),
  rateLocalPerUsd: decimalString('Local exchange rate'),
  lines: z
    .array(
      z.object({
        accountId: cuid,
        direction: z.enum(['DEBIT', 'CREDIT']),
        currency: currencyCode,
        amount: decimalString('Amount'),
        rateToUsd: decimalString('Exchange rate'),
        description: optionalText(300),
        customerId: optionalCuid,
        vendorId: optionalCuid,
        shipmentId: optionalCuid,
      }),
    )
    .min(2, 'A journal voucher needs at least two lines.'),
});

export const revaluationSchema = z.object({
  asOf: dateString('Revaluation date'),
  rates: z.record(z.string(), z.string()),
});

export const cashBankTransferSchema = z
  .object({
    transferDate: dateString('Transfer date'),
    fromAccountId: cuid,
    toAccountId: cuid,
    amount: decimalString('Amount'),
    reference: optionalText(60),
    description: optionalText(300),
  })
  .refine((value) => value.fromAccountId !== value.toAccountId, {
    message: 'Choose two different accounts.',
    path: ['toAccountId'],
  });

export type ReceiptFormInput = z.infer<typeof receiptSchema>;
export type PaymentFormInput = z.infer<typeof paymentSchema>;
export type ExpenseFormInput = z.infer<typeof expenseSchema>;

/**
 * Money handed over by a collection agent, or commission paid to one.
 *
 * The account is required in both directions and is the only place cash or
 * bank moves in this whole arrangement: the collection itself never touched
 * an account, which is the point of the agent clearing ledger.
 */
export const agentSettlementSchema = z.object({
  agentId: requiredChoice('Agent'),
  settlementDate: dateString('Date'),
  direction: z.enum(['COLLECTION', 'COMMISSION']),
  cashBankAccountId: requiredChoice('Cash or bank account'),
  currency: currencyCode,
  amount: decimalString('Amount'),
  rateToUsd: decimalString('Exchange rate'),
  rateLocalPerUsd: decimalString('Local exchange rate'),
  reference: optionalText(60),
  notes: optionalText(400),
});

export const ledgerAccountSchema = z.object({
  code: requiredText('Account code', 20),
  name: requiredText('Account name', 120),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']),
  reportGroup: optionalText(40),
  openingAmount: optionalDecimalString('Opening balance'),
  openingDate: optionalDateString,
});

export const ledgerAccountUpdateSchema = z.object({
  code: optionalText(20),
  name: requiredText('Account name', 120),
  reportGroup: optionalText(40),
});

export const ledgerOpeningSchema = z.object({
  amount: decimalString('Opening balance'),
  asOf: dateString('Opening date'),
  currency: currencyCode,
  rateToUsd: decimalString('Exchange rate'),
  rateLocalPerUsd: decimalString('Local exchange rate'),
});
