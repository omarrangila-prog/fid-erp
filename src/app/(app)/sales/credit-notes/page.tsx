import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { CreditNotesClient } from '@/components/credit-notes/credit-notes-client';
import { loadCreditNoteRows } from '@/components/credit-notes/data';

export const metadata: Metadata = { title: 'Credit Notes' };
export const dynamic = 'force-dynamic';

export default async function CreditNotesPage() {
  const user = await requirePageAccess(PERMISSIONS.CREDIT_NOTES_VIEW);
  const rows = await loadCreditNoteRows(user.activeCompany.id, 'CUSTOMER');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Credit Notes"
        description="Reduce what a customer owes without deleting the invoice they already hold."
        breadcrumbs={[{ label: 'Sales', href: '/sales' }, { label: 'Credit Notes' }]}
      />

      <Callout tone="info" title="A credit note is not a reversal">
        Reversing an invoice unwinds it as though it had never existed. A credit note is its own document: both papers
        stay in the history, which is what an auditor — and a customer holding the original — needs. Credits show
        separately in <strong>Sales Returns &amp; Credits</strong> rather than being netted into revenue, so the top
        line never quietly flatters itself.
      </Callout>

      <CreditNotesClient
        rows={rows}
        basePath="/sales/credit-notes"
        kind="customer"
        canCreate={can(user, PERMISSIONS.CREDIT_NOTES_CREATE)}
        canPost={can(user, PERMISSIONS.CREDIT_NOTES_POST)}
      />
    </div>
  );
}
