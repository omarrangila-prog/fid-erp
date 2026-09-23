import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { JournalForm } from '@/app/(app)/accounting/journal/new/journal-form';
import { loadJournalFormOptions } from '@/app/(app)/accounting/journal/load-journal-options';

export const metadata: Metadata = { title: 'Edit Journal Voucher' };
export const dynamic = 'force-dynamic';

/**
 * Correcting a hand-raised voucher.
 *
 * Deleting it and writing it again is two acts and two chances to get it
 * wrong. This is one: saving takes the entry it replaces back out of the
 * books and posts these figures in its place, and the journal keeps all
 * three lines of the story.
 *
 * Only a voucher somebody wrote can be opened here. An entry a document
 * produced — an invoice, a receipt, a cost — is corrected on that document,
 * where the stock and the allocations are understood.
 */
export default async function EditJournalVoucherPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_POST);
  const companyId = user.activeCompany.id;

  const entry = await prisma.journalEntry.findFirst({
    where: { id, companyId },
    include: {
      lines: {
        orderBy: { lineNumber: 'asc' },
        select: {
          accountId: true,
          debit: true,
          credit: true,
          currency: true,
          rateToUsd: true,
          description: true,
          agentId: true,
          rateLocalPerUsd: true,
        },
      },
    },
  });
  if (!entry) notFound();
  if (entry.sourceType !== 'MANUAL' || entry.status !== 'POSTED' || entry.isReversal) {
    redirect(`/reports/journal?q=${encodeURIComponent(entry.entryNumber)}`);
  }

  const { options, customers, rates } = await loadJournalFormOptions(companyId);

  /*
   * A line tagged with an agent was written by choosing the agent rather than
   * the clearing account, so it opens the way it was written.
   */
  const agentChoice = new Map(
    options.filter((o) => o.value.startsWith('agent:') && o.agentId).map((o) => [o.agentId!, o.value]),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Edit journal voucher"
        description="Saving takes the entry this replaces back out of the books and posts these figures in its place."
        breadcrumbs={[
          { label: 'Accounting' },
          { label: 'Journal', href: '/reports/journal' },
          { label: 'Edit voucher' },
        ]}
      />
      <Callout tone="warning" title="This voucher is posted">
        The entry it replaces is mirrored when this is saved, so it stops counting in every ledger and report. Both it
        and the correction stay in the journal, where the change can be read.
      </Callout>
      <JournalForm
        accounts={options}
        customers={customers}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={rates.local}
        ratesByCurrency={rates.byCurrency}
        today={toDateInputValue(new Date())}
        initial={{
          entryId: entry.id,
          entryDate: toDateInputValue(entry.entryDate),
          description: entry.description,
          reference: entry.reference ?? '',
          // The rate the voucher was written at, carried on its lines.
          rateLocalPerUsd: (entry.lines[0]?.rateLocalPerUsd ?? rates.local).toString(),
          lines: entry.lines.map((line) => ({
            accountId: (line.agentId && agentChoice.get(line.agentId)) || line.accountId,
            direction: Number(line.debit) > 0 ? ('DEBIT' as const) : ('CREDIT' as const),
            amount: (Number(line.debit) > 0 ? line.debit : line.credit).toString(),
            currency: line.currency,
            rateToUsd: line.rateToUsd.toString(),
            description: line.description ?? '',
          })),
        }}
      />
    </div>
  );
}
