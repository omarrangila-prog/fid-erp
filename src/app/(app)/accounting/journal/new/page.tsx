import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { JournalForm } from '@/app/(app)/accounting/journal/new/journal-form';
import { loadJournalFormOptions } from '@/app/(app)/accounting/journal/load-journal-options';

export const metadata: Metadata = { title: 'New Journal Voucher' };
export const dynamic = 'force-dynamic';

export default async function NewJournalEntryPage() {
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_POST);
  const { options, customers, rates } = await loadJournalFormOptions(user.activeCompany.id);

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
        customers={customers}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={rates.local}
        ratesByCurrency={rates.byCurrency}
        today={toDateInputValue(new Date())}
      />
    </div>
  );
}
