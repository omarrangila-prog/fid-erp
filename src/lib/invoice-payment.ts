import { dec, type DecimalInput } from '@/lib/money';

/**
 * Whether a sales invoice is paid — one definition for every screen.
 *
 * The client asks one question of an invoice: is money still due on it? If
 * so it is Unpaid for every list, filter, count and total, whether nothing
 * has been received or part of it. "Partially Paid" stays the invoice's own
 * status — it is true, and shown on the row — but it is never a separate
 * filter: a part-paid invoice is an unpaid one.
 *
 * Decided on what is left to pay, never on the status text and never on a
 * payment merely existing: an invoice with a receipt against it and money
 * still owing is not Paid.
 */

/**
 * Below half a cent nothing is owed: the smallest amount any of these
 * currencies shows is a cent, so a remainder under half of one is rounding,
 * not a debt.
 */
export const SETTLED_TOLERANCE = '0.005';

export type InvoicePaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';

/** Money is still due on the invoice. */
export function isInvoiceOutstanding(outstanding: DecimalInput): boolean {
  return dec(outstanding).greaterThan(SETTLED_TOLERANCE);
}

/**
 * Nothing received and money due: Unpaid. Something received and money due:
 * Partially Paid. Nothing due: Paid.
 */
export function getInvoicePaymentStatus(params: { paid: DecimalInput; outstanding: DecimalInput }): InvoicePaymentStatus {
  if (!isInvoiceOutstanding(params.outstanding)) return 'PAID';
  return dec(params.paid).greaterThan(SETTLED_TOLERANCE) ? 'PARTIAL' : 'UNPAID';
}

/** The only two payment filters there are. */
export type PaymentFilter = 'unpaid' | 'paid';

export const PAYMENT_FILTER_LABELS: Record<PaymentFilter, string> = { unpaid: 'Unpaid', paid: 'Paid' };

/** Which filter an invoice falls under: Unpaid while anything is due, part-paid included. */
export function paymentFilterOf(outstanding: DecimalInput): PaymentFilter {
  return isInvoiceOutstanding(outstanding) ? 'unpaid' : 'paid';
}

/**
 * The filter a link asks for: `?paymentStatus=unpaid|paid`, or the older
 * `?standing=` links the dashboard and shared reports used. Every older
 * "unpaid", "partial" and "outstanding" means Unpaid now; there is no
 * part-paid list of its own.
 */
export function parsePaymentFilter(params: { paymentStatus?: string | null; standing?: string | null }): PaymentFilter | null {
  const value = (params.paymentStatus ?? params.standing ?? '').trim().toLowerCase();
  if (value === 'paid') return 'paid';
  if (value === 'unpaid' || value === 'partial' || value === 'outstanding') return 'unpaid';
  return null;
}
