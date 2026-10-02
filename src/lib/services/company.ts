import type { Tx } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { companyToday } from '@/lib/format';

export type CompanyContext = {
  id: string;
  code: string;
  name: string;
  country: string;
  localCurrency: string;
  baseCurrency: string;
  timezone: string;
};

export async function getCompanyContext(tx: Tx, companyId: string): Promise<CompanyContext> {
  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { id: true, code: true, name: true, country: true, localCurrency: true, baseCurrency: true, timezone: true },
  });
  if (!company) throw new NotFoundError('Company');
  return company;
}

/**
 * Today where the company is, as midnight UTC of its own calendar day — the
 * form every document date takes. The server's clock is UTC, a day behind
 * Dubai for the first four hours of every morning.
 */
export async function getCompanyDay(tx: Tx, companyId: string): Promise<Date> {
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
  return companyToday(company?.timezone);
}
