import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { CreditNoteDetail } from '@/components/credit-notes/credit-note-detail';
import { loadCreditNoteDetail } from '@/components/credit-notes/data';
import { loadAttachments } from '@/components/attachments/load';
import { getTaxSettings } from '@/lib/services/tax';

export const metadata: Metadata = { title: 'Credit Note' };
export const dynamic = 'force-dynamic';

export default async function CreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageAccess(PERMISSIONS.CREDIT_NOTES_VIEW);
  const { id } = await params;

  // All three in one round trip. The database is in another region, so a chain
  // of dependent awaits is the difference between a page that opens and a page
  // somebody watches a skeleton on.
  const [detail, attachments, taxSettings] = await Promise.all([
    loadCreditNoteDetail(user.activeCompany.id, id),
    can(user, PERMISSIONS.ATTACHMENTS_VIEW)
      ? loadAttachments(user.activeCompany.id, 'CreditNote', id)
      : Promise.resolve([]),
    getTaxSettings(user.activeCompany.id),
  ]);
  if (!detail) notFound();

  return (
    <CreditNoteDetail
      detail={detail}
      basePath="/sales/credit-notes"
      kind="customer"
      taxLabel={taxSettings.label}
      canPost={can(user, PERMISSIONS.CREDIT_NOTES_POST)}
      canManageAttachments={can(user, PERMISSIONS.ATTACHMENTS_MANAGE)}
      attachments={attachments}
    />
  );
}
