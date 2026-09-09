import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { PageHeader } from '@/components/shared/page-header';
import { PrerequisiteGate, anyMissing, type Prerequisite } from '@/components/shared/prerequisite-gate';
import { CreditNoteForm } from '@/components/credit-notes/credit-note-form';
import { loadCreditNoteFormData } from '@/components/credit-notes/data';

export const metadata: Metadata = { title: 'New Credit Note' };
export const dynamic = 'force-dynamic';

const BASE_PATH = '/sales/credit-notes';
const CRUMBS = [
  { label: 'Sales', href: '/sales' },
  { label: 'Credit Notes', href: BASE_PATH },
  { label: 'New' },
];

export default async function NewCreditNotePage() {
  const user = await requirePageAccess(PERMISSIONS.CREDIT_NOTES_CREATE);
  const data = await loadCreditNoteFormData(user.activeCompany.id, 'CUSTOMER');

  const prerequisites: Prerequisite[] = [
    {
      met: data.parties.length > 0,
      label: 'At least one customer',
      description: 'A credit has to be addressed to somebody, and the currency comes from their record.',
      href: '/customers?new=1',
      actionLabel: 'Add customer',
    },
  ];

  if (anyMissing(prerequisites)) {
    return (
      <div className="space-y-6">
        <PageHeader title="New Credit Note" breadcrumbs={CRUMBS} />
        <PrerequisiteGate
          title="Before you can raise a credit note"
          description="A credit reduces what a customer owes, so there has to be a customer on file."
          prerequisites={prerequisites}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Credit Note"
        description="Correct an invoice without deleting it. Both documents stay in the history."
        breadcrumbs={CRUMBS}
      />
      <CreditNoteForm type="CUSTOMER" basePath={BASE_PATH} {...data} />
    </div>
  );
}
