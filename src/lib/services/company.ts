import type { Tx } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';

export type CompanyContext = {
  id: string;
  code: string;
  name: string;
  localCurrency: string;
  baseCurrency: string;
  timezone: string;
};

export async function getCompanyContext(tx: Tx, companyId: string): Promise<CompanyContext> {
  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { id: true, code: true, name: true, localCurrency: true, baseCurrency: true, timezone: true },
  });
  if (!company) throw new NotFoundError('Company');
  return company;
}
