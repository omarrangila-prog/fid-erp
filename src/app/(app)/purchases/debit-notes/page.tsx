import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { CreditNotesClient } from '@/components/credit-notes/credit-notes-client';
import { loadCreditNoteRows } from '@/components/credit-notes/data';

export const metadata: Metadata = { title: 'Supplier Debit Notes' };
export const dynamic = 'force-dynamic';

export default async function DebitNotesPage() {
  const user = await requirePageAccess(PERMISSIONS.CREDIT_NOTES_VIEW);
  const rows = await loadCreditNoteRows(user.activeCompany.id, 'VENDOR');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Supplier Debit Notes"
        description="Reduce what you owe a supplier — a short shipment, a quality claim, an agreed allowance."
        breadcrumbs={[{ label: 'Purchases', href: '/purchases' }, { label: 'Debit Notes' }]}
      />

      <Callout tone="info" title="Where the money goes">
        The supplier&rsquo;s balance is reduced and the credit is recorded in <strong>Purchase Returns &amp;
        Credits</strong>, so it is visible as a claim rather than silently lowering the cost of coffee you have already
        sold.
      </Callout>

      <CreditNotesClient
        rows={rows}
        basePath="/purchases/debit-notes"
        kind="supplier"
        canCreate={can(user, PERMISSIONS.CREDIT_NOTES_CREATE)}
        canPost={can(user, PERMISSIONS.CREDIT_NOTES_POST)}
      />
    </div>
  );
}
