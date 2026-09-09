import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { PageHeader } from '@/components/shared/page-header';
import { PrerequisiteGate, anyMissing, type Prerequisite } from '@/components/shared/prerequisite-gate';
import { CreditNoteForm } from '@/components/credit-notes/credit-note-form';
import { loadCreditNoteFormData } from '@/components/credit-notes/data';

export const metadata: Metadata = { title: 'New Debit Note' };
export const dynamic = 'force-dynamic';

const BASE_PATH = '/purchases/debit-notes';
const CRUMBS = [
  { label: 'Purchases', href: '/purchases' },
  { label: 'Debit Notes', href: BASE_PATH },
  { label: 'New' },
];

export default async function NewDebitNotePage() {
  const user = await requirePageAccess(PERMISSIONS.CREDIT_NOTES_CREATE);
  const data = await loadCreditNoteFormData(user.activeCompany.id, 'VENDOR');

  const prerequisites: Prerequisite[] = [
    {
      met: data.parties.length > 0,
      label: 'At least one supplier',
      description: 'A debit note has to be addressed to somebody, and the currency comes from their record.',
      href: '/vendors?new=1',
      actionLabel: 'Add supplier',
    },
  ];

  if (anyMissing(prerequisites)) {
    return (
      <div className="space-y-6">
        <PageHeader title="New Debit Note" breadcrumbs={CRUMBS} />
        <PrerequisiteGate
          title="Before you can raise a debit note"
          description="A debit note reduces what you owe a supplier, so there has to be a supplier on file."
          prerequisites={prerequisites}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Debit Note"
        description="Claim an allowance from a supplier without touching the original contract."
        breadcrumbs={CRUMBS}
      />
      <CreditNoteForm type="VENDOR" basePath={BASE_PATH} {...data} />
    </div>
  );
}
