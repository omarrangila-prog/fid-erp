import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { JournalForm, type AccountOption } from '@/app/(app)/accounting/journal/new/journal-form';

export const metadata: Metadata = { title: 'New Journal Voucher' };
export const dynamic = 'force-dynamic';

export default async function NewJournalEntryPage() {
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_POST);

  const accounts = await prisma.account.findMany({
    where: { companyId: user.activeCompany.id, status: 'ACTIVE' },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, type: true },
  });

  const options: AccountOption[] = accounts.map((account) => ({
    value: account.id,
    label: `${account.code} — ${account.name}`,
    hint: account.type.replaceAll('_', ' ').toLowerCase(),
    keywords: `${account.code} ${account.name} ${account.type}`,
    accountType: account.type,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Journal Voucher"
        description="A direct double-entry posting for corrections, accruals and opening balances."
        breadcrumbs={[
          { label: 'Accounting' },
          { label: 'Journal', href: '/reports/journal' },
          { label: 'New voucher' },
        ]}
      />
      <JournalForm
        accounts={options}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={user.activeCompany.localCurrency === 'AED' ? '3.6725' : '9.85'}
        today={toDateInputValue(new Date())}
      />
    </div>
  );
}
