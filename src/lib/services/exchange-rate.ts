import { prisma } from '@/lib/db';
import { Decimal, dec } from '@/lib/money';

/**
 * The rate a document should default to.
 *
 * The rate lived as a literal in eight different files — `localCurrency ===
 * 'AED' ? '3.6725' : '9.85'` — while the database held a proper table of them.
 * So a rate the business had already recorded still had to be typed onto every
 * voucher, and adding a third company meant editing eight files to teach it a
 * number it could have looked up.
 *
 * This reads the most recent rate on or before the document's date, which is
 * the right one: back-dating a voucher to last month should offer last month's
 * rate, not today's. What the user accepts is stored on the voucher and never
 * recomputed afterwards — these are only the defaults.
 */

/** Units of the quoted currency per 1 USD, e.g. AED 3.6725. */
export async function getRate(params: {
  companyId?: string | null;
  quoteCurrency: string;
  asOf?: Date;
}): Promise<Decimal | null> {
  const currency = params.quoteCurrency.toUpperCase();
  if (currency === 'USD') return new Decimal(1);

  const asOf = params.asOf ?? new Date();

  // A company's own rate beats the shared one; the shared one is the fallback.
  const rows = await prisma.exchangeRate.findMany({
    where: {
      quoteCurrency: currency,
      effectiveDate: { lte: asOf },
      OR: [{ companyId: params.companyId ?? null }, { companyId: null }],
    },
    orderBy: [{ effectiveDate: 'desc' }, { companyId: 'desc' }],
    take: 1,
    select: { rate: true },
  });

  return rows[0] ? dec(rows[0].rate) : null;
}

/**
 * Every rate a document entry form needs, in one round trip.
 *
 * `local` is the company's own currency per USD, which every voucher stores so
 * the company can report in its own money whatever currency it traded in.
 */
export async function getRateDefaults(companyId: string, asOf?: Date) {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { localCurrency: true },
  });

  const [local, aed, mad] = await Promise.all([
    getRate({ companyId, quoteCurrency: company.localCurrency, asOf }),
    getRate({ companyId, quoteCurrency: 'AED', asOf }),
    getRate({ companyId, quoteCurrency: 'MAD', asOf }),
  ]);

  return {
    localCurrency: company.localCurrency,
    /**
     * A missing rate falls back to 1 rather than to a made-up number. One is
     * obviously wrong on an AED voucher, and obviously wrong is safer than
     * plausibly wrong — somebody notices and enters the real rate, instead of
     * a stale constant quietly pricing a year of trade.
     */
    local: (local ?? new Decimal(1)).toString(),
    byCurrency: {
      USD: '1',
      AED: (aed ?? new Decimal(1)).toString(),
      MAD: (mad ?? new Decimal(1)).toString(),
    } as Record<string, string>,
    /** True when no rate was on file, so the form can say so. */
    missing: local === null,
  };
}
