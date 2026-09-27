import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { JournalForm } from '@/app/(app)/accounting/journal/new/journal-form';
import { SimpleEntryForm } from '@/app/(app)/accounting/journal/new/simple-entry';
import { GeneralEntryTabs } from '@/app/(app)/accounting/journal/new/general-entry-tabs';
import { loadJournalFormOptions } from '@/app/(app)/accounting/journal/load-journal-options';

export const metadata: Metadata = { title: 'General Entry' };
export const dynamic = 'force-dynamic';

export default async function NewJournalEntryPage() {
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_POST);
  const { options, customers, rates, entryOptions } = await loadJournalFormOptions(user.activeCompany.id);
  const today = toDateInputValue(new Date());

  return (
    <div className="space-y-6">
      <PageHeader
        title="General Entry"
        description="Journal Voucher (JV) — choose the kind of entry and the two accounts; the debit and credit are posted for you."
        breadcrumbs={[
          { label: 'Accounting' },
          { label: 'Journal', href: '/reports/journal' },
          { label: 'General Entry' },
        ]}
      />
      <GeneralEntryTabs
        simple={
          <SimpleEntryForm
            options={entryOptions}
            localCurrency={user.activeCompany.localCurrency}
            defaultLocalRate={rates.local}
            ratesByCurrency={rates.byCurrency}
            today={today}
          />
        }
        advanced={
          <JournalForm
            embedded
            accounts={options}
            customers={customers}
            localCurrency={user.activeCompany.localCurrency}
            defaultLocalRate={rates.local}
            ratesByCurrency={rates.byCurrency}
            today={today}
          />
        }
      />
    </div>
  );
}
