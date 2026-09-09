import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/format';
import { getReconciliationWorkspace } from '@/lib/services/bank-reconciliation';
import { PageHeader } from '@/components/shared/page-header';
import { Callout, EmptyState } from '@/components/ui/feedback';
import {
  ReconciliationClient,
  type ReconWorkspace,
} from '@/app/(app)/finance/reconciliation/reconciliation-client';

export const metadata: Metadata = { title: 'Bank Reconciliation' };
export const dynamic = 'force-dynamic';

export default async function BankReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; date?: string }>;
}) {
  const user = await requirePageAccess(PERMISSIONS.BANK_RECONCILE);
  const params = await searchParams;

  const accounts = await prisma.cashBankAccount.findMany({
    where: { companyId: user.activeCompany.id, status: 'ACTIVE' },
    orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, currency: true },
  });

  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Bank Reconciliation"
          breadcrumbs={[{ label: 'Finance' }, { label: 'Reconciliation' }]}
        />
        <EmptyState
          title="No cash or bank accounts yet"
          description="Add the account your statements come from, then come back and reconcile it."
        />
      </div>
    );
  }

  const accountId = accounts.find((account) => account.id === params.account)?.id ?? accounts[0].id;
  // Default to the end of last month, which is the statement most people are
  // holding when they sit down to do this.
  const today = new Date();
  const defaultDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)).toISOString().slice(0, 10);
  const statementDate = params.date ?? defaultDate;

  const raw = await getReconciliationWorkspace({
    companyId: user.activeCompany.id,
    cashBankAccountId: accountId,
    statementDate: new Date(`${statementDate}T00:00:00.000Z`),
  });

  const workspace: ReconWorkspace = {
    reconciliationId: raw.reconciliation?.id ?? null,
    isComplete: raw.reconciliation?.isComplete ?? false,
    currency: raw.account.currency,
    accountName: raw.account.name,
    lines: raw.lines.map((line) => ({
      journalLineId: line.journalLineId,
      date: formatDate(line.entryDate),
      entryNumber: line.entryNumber,
      description: line.description,
      reference: line.reference,
      amount: line.amount.toString(),
      reconciled: line.reconciled,
    })),
    bookBalance: raw.bookBalance.toString(),
    reconciledBalance: raw.reconciledBalance.toString(),
    statementBalance: raw.statementBalance.toString(),
    difference: raw.difference.toString(),
    unclearedDeposits: raw.unclearedDeposits.toString(),
    unclearedPayments: raw.unclearedPayments.toString(),
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bank Reconciliation"
        description={`Tick the ledger against the statement for ${raw.account.name}.`}
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Cash & Bank', href: '/finance/cash-bank' },
          { label: 'Reconciliation' },
        ]}
      />

      <Callout tone="info" title="What you are looking for">
        The ledger balance and the statement balance are rarely equal, and that is normal: a cheque you wrote last week
        is a real payment the bank has not seen yet. The number that has to reach zero is the{' '}
        <strong>difference</strong> between the statement and what you have ticked. Anything still unticked is
        outstanding, and is shown separately so the gap is explained rather than merely reported.
      </Callout>

      <ReconciliationClient
        accounts={accounts}
        accountId={accountId}
        statementDate={statementDate}
        workspace={workspace}
      />
    </div>
  );
}
