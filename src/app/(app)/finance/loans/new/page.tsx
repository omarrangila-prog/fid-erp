import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { LoanForm } from '@/app/(app)/finance/loans/new/loan-form';

export const metadata: Metadata = { title: 'Loan' };
export const dynamic = 'force-dynamic';

export default async function NewLoanPage({
  searchParams,
}: {
  searchParams: Promise<{ direction?: string }>;
}) {
  const { direction } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_POST);
  const companyId = user.activeCompany.id;

  const accounts = await prisma.cashBankAccount.findMany({
    where: { companyId, status: 'ACTIVE' },
    orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, currency: true },
  });

  /*
   * Everybody who already has a running account, so lending again finds the
   * same ledger rather than opening a second one in the same name. Cash and
   * bank heads and the customer/supplier control accounts are left out: a
   * loan balance does not belong in either.
   */
  const loanAccounts = await prisma.account.findMany({
    where: {
      companyId,
      status: 'ACTIVE',
      type: { in: ['ASSET', 'LIABILITY'] },
      subledgerType: 'NONE',
      cashBankAccounts: { none: {} },
    },
    orderBy: [{ code: 'asc' }],
    select: { id: true, code: true, name: true, currency: true },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Loan"
        description="Money lent to the business or by it — by a director, a friend, another company. It is never income or a cost."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Cash & Bank', href: '/finance/cash-bank' }, { label: 'Loan' }]}
      />

      {accounts.length === 0 ? (
        <Callout tone="warning" title="No account to receive it">
          A loan moves through one of the company&rsquo;s own cash or bank accounts. Open one first.
        </Callout>
      ) : (
        <LoanForm
          accounts={accounts}
          loanAccounts={loanAccounts.map((a) => ({
            id: a.id,
            label: `${a.code} · ${a.name}`,
            currency: a.currency,
          }))}
          localCurrency={user.activeCompany.localCurrency}
          initialDirection={
            direction === 'GIVEN' || direction === 'REPAID' ? direction : 'RECEIVED'
          }
        />
      )}
    </div>
  );
}
