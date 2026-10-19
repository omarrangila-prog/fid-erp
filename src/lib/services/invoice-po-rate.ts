import { prisma } from '@/lib/db';
import { dec, type Decimal } from '@/lib/money';

/**
 * The USD/MAD rate an invoice's dollar equivalent is stated at: the rate of
 * the purchase orders whose coffee it sold.
 *
 * A customer is invoiced in the company's own money, and the invoice keeps
 * that money — its amount, its tax, its balance never move. Its dollars are a
 * management equivalent, and the client wants them at the purchase order's
 * rate, so that sales and the cost of what was sold are stated at the same
 * rate and the dollar margin means something. The rate on the order can be
 * edited at any time; nothing is stored here, so every screen follows the
 * order the moment it changes.
 *
 * An invoice can sell coffee from more than one order, each at its own rate.
 * Each line is converted at its own order's rate and the invoice's rate is
 * the result: the line amounts ÷ their dollar equivalents. An invoice in a
 * foreign currency keeps its own rate and is not listed.
 */
export async function getInvoicePoRates(params: { companyId: string; invoiceIds?: string[] }): Promise<Map<string, Decimal>> {
  const ids = params.invoiceIds ?? null;
  if (ids && ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ invoiceId: string; local: string; usd: string }>>`
    SELECT sil."salesInvoiceId" AS "invoiceId",
           SUM(sil."lineTotal" + sil."taxAmount")::text AS local,
           SUM((sil."lineTotal" + sil."taxAmount") / NULLIF(COALESCE(pc."actualRateLocalPerUsd", pc."rateLocalPerUsd"), 0))::text AS usd
      FROM sales_invoice_lines sil
      JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
      JOIN companies co ON co."id" = si."companyId"
      JOIN batches b ON b."id" = sil."batchId"
      JOIN purchase_contracts pc ON pc."id" = b."purchaseContractId"
     WHERE si."companyId" = ${params.companyId}
       AND si."currency" = co."localCurrency"
       AND (${ids}::text[] IS NULL OR si."id" = ANY(${ids}::text[]))
     GROUP BY sil."salesInvoiceId"`;
  const rates = new Map<string, Decimal>();
  for (const row of rows) {
    const usd = dec(row.usd ?? 0);
    if (usd.greaterThan(0)) rates.set(row.invoiceId, dec(row.local).dividedBy(usd));
  }
  return rates;
}
