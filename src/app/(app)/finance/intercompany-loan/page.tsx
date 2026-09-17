import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { IntercompanyLoanForm, type LoanCompany } from '@/app/(app)/finance/intercompany-loan/loan-form';

export const metadata: Metadata = { title: 'Intercompany Loan' };
export const dynamic = 'force-dynamic';

export default async function IntercompanyLoanPage() {
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_POST);

  /*
   * Only the companies this person may actually reach. The loan writes to both
   * sets of books, so somebody who can see one of them has no business moving
   * money between them.
   */
  const reachable = user.companies.map((c) => c.id);
  const accounts = await prisma.cashBankAccount.findMany({
    where: { companyId: { in: reachable }, status: 'ACTIVE' },
    orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, currency: true, companyId: true },
  });

  const companies: LoanCompany[] = user.companies.map((company) => ({
    id: company.id,
    name: company.name,
    accounts: accounts
      .filter((a) => a.companyId === company.id)
      .map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
  }));

  const usable = companies.filter((c) => c.accounts.length > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Intercompany Loan"
        description="Money lent by one FID company to the other. Both sets of books record it, and neither counts it as income or expense."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Cash & Bank', href: '/finance/cash-bank' }, { label: 'Loan' }]}
      />

      {usable.length < 2 ? (
        <Callout tone="warning" title="Two companies are needed">
          A loan runs between two companies you can reach, each with at least one active cash or bank account. You
          currently have {usable.length}.
        </Callout>
      ) : (
        <IntercompanyLoanForm companies={usable} />
      )}
    </div>
  );
}
