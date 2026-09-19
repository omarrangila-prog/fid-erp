import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { CorrectOrderForm } from '@/app/(app)/purchases/[id]/correct/correct-form';

export const metadata: Metadata = { title: 'Correct Purchase Order' };
export const dynamic = 'force-dynamic';

/**
 * An approved order cannot be edited in place — its payable is posted. It
 * can be corrected: the posting is reversed and an editable copy opens under
 * the same reference. This page says exactly that before doing it.
 */
export default async function CorrectPurchasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.PURCHASES_REVERSE);

  const contract = await prisma.purchaseContract.findFirst({
    where: { id, companyId: user.activeCompany.id },
    select: {
      id: true,
      status: true,
      contractReference: true,
      vendor: { select: { vendorName: true } },
      goodsReceipts: { where: { status: 'POSTED' }, select: { id: true } },
      _count: { select: { lines: true, shipments: true } },
    },
  });
  if (!contract) notFound();

  const blocked =
    contract.status !== 'POSTED'
      ? 'Only an approved order is corrected this way. A draft is edited directly.'
      : contract.goodsReceipts.length > 0
        ? 'Coffee from this order is already in stock. Reverse the goods receipts first, or adjust the stock with a transfer or count.'
        : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Correct ${contract.contractReference}`}
        description={`${contract.vendor.vendorName} · ${contract._count.lines} ${contract._count.lines === 1 ? 'container' : 'containers'}`}
        breadcrumbs={[
          { label: 'Trading' },
          { label: 'Purchase Contracts', href: '/purchases' },
          { label: contract.contractReference, href: `/purchases/${contract.id}` },
          { label: 'Correct' },
        ]}
      />
      {blocked ? (
        <Callout tone="warning" title="This order cannot be corrected right now">
          {blocked}
        </Callout>
      ) : (
        <CorrectOrderForm
          id={contract.id}
          reference={contract.contractReference}
          canCreate={can(user, PERMISSIONS.PURCHASES_CREATE)}
        />
      )}
    </div>
  );
}
