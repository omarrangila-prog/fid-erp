import { prisma } from '@/lib/db';
import { dec, toMoney, type Decimal } from '@/lib/money';

export type SupplierPaymentRate = {
  /** Dollars paid against the order on posted payments that state a rate. */
  paidUsd: Decimal;
  /** Σ(USD × its payment's USD/local rate) ÷ Σ USD. */
  weightedRate: Decimal;
  payments: Array<{ paymentId: string; paymentNumber: string; paymentDate: Date; usd: Decimal; rate: Decimal }>;
};

/**
 * The rate the dollars for an order were actually bought at, weighted by what
 * each payment paid against it — e.g. USD 40,000 at 10.30 and USD 60,000 at
 * 9.90 is 10.06.
 *
 * Shown beside the order's own rate, never instead of it: the rate saved on
 * the order is what costs the shipment, and the user decides whether to edit
 * the order to this one. Null when no posted payment against the order states
 * a rate.
 */
export async function getSupplierPaymentRate(params: { companyId: string; contractId: string }): Promise<SupplierPaymentRate | null> {
  const rows = await prisma.$queryRaw<Array<{ paymentId: string; paymentNumber: string; paymentDate: Date; usd: string; rate: string }>>`
    SELECT p."id" AS "paymentId", p."paymentNumber", p."paymentDate",
           pa."amountUsd"::text AS usd, p."rateLocalPerUsd"::text AS rate
      FROM payment_allocations pa
      JOIN payments p ON p."id" = pa."paymentId"
     WHERE p."companyId" = ${params.companyId}
       AND pa."purchaseContractId" = ${params.contractId}
       AND p."status" = 'POSTED'
       AND pa."amountUsd" > 0
       AND p."rateLocalPerUsd" > 1
     ORDER BY p."paymentDate", p."paymentNumber"`;
  if (rows.length === 0) return null;
  const payments = rows.map((r) => ({ paymentId: r.paymentId, paymentNumber: r.paymentNumber, paymentDate: r.paymentDate, usd: dec(r.usd), rate: dec(r.rate) }));
  const paidUsd = payments.reduce((s, p) => s.plus(p.usd), dec(0));
  const weighted = payments.reduce((s, p) => s.plus(p.usd.times(p.rate)), dec(0));
  return { paidUsd: toMoney(paidUsd), weightedRate: weighted.dividedBy(paidUsd).toDecimalPlaces(4), payments };
}
