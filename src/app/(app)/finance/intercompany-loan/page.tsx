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
  /*
   * Lending happens in dollars or dirhams, never in AED.
   *
   * The group does not lend or receive between the companies in AED, so the
   * AED accounts are left off this screen rather than offered and then
   * regretted. They remain available everywhere else.
   */
  const accounts = await prisma.cashBankAccount.findMany({
    where: { companyId: { in: reachable }, status: 'ACTIVE', currency: { not: 'AED' } },
    orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, currency: true, companyId: true },
  });

  /*
   * Where each company may carry the debt.
   *
   * The built-in loan accounts are the default, but a company that keeps a
   * named account for the other one — "F I D TRADING LLC DUBAI" in Morocco's
   * chart, say — needs to be able to point the loan at it, or the balance
   * lands somewhere they never open.
   */
  const loanAccounts = await prisma.account.findMany({
    where: {
      companyId: { in: reachable },
      status: 'ACTIVE',
      type: { in: ['ASSET', 'LIABILITY'] },
      // Not a cash drawer or a bank account: those are where the money is,
      // not where the debt is, and a loan balance posted into one would put a
      // figure in the cash book that no bank statement shows.
      cashBankAccounts: { none: {} },
      // Not a customer, vendor or agent control account: every line on one of
      // those has to name whose balance it is, and a company is none of them.
      subledgerType: 'NONE',
    },
    orderBy: [{ code: 'asc' }],
    select: { id: true, code: true, name: true, type: true, systemKey: true, companyId: true },
  });

  const companies: LoanCompany[] = user.companies.map((company) => ({
    id: company.id,
    name: company.name,
    accounts: accounts
      .filter((a) => a.companyId === company.id)
      .map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    loanAccounts: loanAccounts
      .filter((a) => a.companyId === company.id)
      .map((a) => ({
        id: a.id,
        label: a.name,
        type: a.type as 'ASSET' | 'LIABILITY',
        isDefaultReceivable: a.systemKey === 'INTERCOMPANY_LOAN_RECEIVABLE',
        isDefaultPayable: a.systemKey === 'INTERCOMPANY_LOAN_PAYABLE',
      })),
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
