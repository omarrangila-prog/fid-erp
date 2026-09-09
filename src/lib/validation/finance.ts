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
    paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE']),
    cashBankAccountId: optionalCuid,
    cheque: chequeDetails.nullish(),
    shipmentId: optionalCuid,
    reference: optionalText(60),
    description: optionalText(600),
    allocations: z
      .array(z.object({ salesInvoiceId: cuid, amount: decimalString('Allocation') }))
      .default([]),
  })
  .refine(
    (v) => v.currency === 'USD' || Number(v.rateToUsd) > 0 || Number(v.usdEquivalent) > 0,
    { message: 'Enter either an exchange rate or the USD equivalent.', path: ['rateToUsd'] },
  )
  .refine((v) => v.paymentMethod === 'CHEQUE' || Boolean(v.cashBankAccountId), {
    message: 'Choose the cash or bank account the money was received into.',
    path: ['cashBankAccountId'],
  });

export const paymentSchema = z
  .object({
    paymentDate: dateString('Payment date'),
    vendorId: cuid,
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
    allocations: z
      .array(z.object({ purchaseContractId: cuid, amount: decimalString('Allocation') }))
      .default([]),
  })
  .refine((v) => v.paymentMethod === 'CHEQUE' || Boolean(v.cashBankAccountId), {
    message: 'Choose the cash or bank account the money was paid from.',
    path: ['cashBankAccountId'],
  });

export const expenseSchema = z.object({
  expenseDate: dateString('Expense date'),
  expenseCategoryId: cuid,
  shipmentId: optionalCuid,
  purchaseContractId: optionalCuid,
  vendorId: optionalCuid,
  agentId: optionalCuid,
  currency: currencyCode,
  amount: decimalString('Amount'),
  rateToUsd: decimalString('Exchange rate'),
  rateLocalPerUsd: decimalString('Local exchange rate'),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE']),
  cashBankAccountId: optionalCuid,
  capitaliseToLandedCost: z.coerce.boolean().optional(),
  taxCodeId: optionalCuid,
  reference: optionalText(60),
  description: optionalText(600),
});

export const chequeStatusSchema = z.object({
  toStatus: z.enum(['RECEIVED', 'DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED']),
  cashBankAccountId: optionalCuid,
  effectiveDate: optionalDateString,
  reason: optionalText(400),
  notes: optionalText(400),
});

export const journalVoucherSchema = z.object({
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

export type ReceiptFormInput = z.infer<typeof receiptSchema>;
export type PaymentFormInput = z.infer<typeof paymentSchema>;
export type ExpenseFormInput = z.infer<typeof expenseSchema>;
