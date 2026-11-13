import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { companyToday, toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { JournalForm } from '@/app/(app)/accounting/journal/new/journal-form';
import { loadJournalFormOptions } from '@/app/(app)/accounting/journal/load-journal-options';
import type { EntryOption } from '@/app/(app)/accounting/journal/new/simple-entry';

export const metadata: Metadata = { title: 'Edit Journal Entry (JV)' };
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
          customerId: true,
          vendorId: true,
          rateLocalPerUsd: true,
          account: { select: { name: true, code: true, type: true, systemKey: true } },
        },
      },
    },
  });
  if (!entry) notFound();
  if (entry.sourceType !== 'MANUAL' || entry.status !== 'POSTED' || entry.isReversal) {
    redirect(`/reports/journal?q=${encodeURIComponent(entry.entryNumber)}`);
  }

  const { rates, entryOptions } = await loadJournalFormOptions(companyId);

  /*
   * Each line opens the way it was written: a customer, supplier or agent by
   * name, anything else by its account. An account the list no longer offers
   * (inactive, or a control account written bare) is kept as it was.
   */
  const extra: EntryOption[] = [];
  const optionFor = (line: (typeof entry.lines)[number]) => {
    const key = line.account.systemKey;
    const party =
      key === 'ACCOUNTS_RECEIVABLE' && line.customerId
        ? `customer:${line.customerId}`
        : key === 'ACCOUNTS_PAYABLE' && line.vendorId
          ? `vendor:${line.vendorId}`
          : key === 'AGENT_CLEARING' && line.agentId
            ? `agent:${line.agentId}`
            : key === 'AGENT_COMMISSION_PAYABLE' && line.agentId
              ? `commission:${line.agentId}`
              : line.accountId;
    if (entryOptions.some((o) => o.value === party)) return party;
    if (!extra.some((o) => o.value === line.accountId)) {
      extra.push({
        value: line.accountId,
        label: line.account.name,
        hint: line.account.type.toLowerCase(),
        keywords: `${line.account.code} ${line.account.name}`,
        group: 'Other liabilities',
        accountId: line.accountId,
        customerId: line.customerId ?? undefined,
        vendorId: line.vendorId ?? undefined,
        agentId: line.agentId ?? undefined,
        currencies: null,
        cash: false,
      });
    }
    return line.accountId;
  };
  const initialLines = entry.lines.map((line) => ({
    option: optionFor(line),
    direction: Number(line.debit) > 0 ? ('DEBIT' as const) : ('CREDIT' as const),
    amount: (Number(line.debit) > 0 ? line.debit : line.credit).toString(),
    currency: line.currency,
    rateToUsd: line.rateToUsd.toString(),
    description: line.description ?? '',
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Edit journal entry (JV)"
        description="Saving takes the entry this replaces back out of the books and posts these figures in its place."
        breadcrumbs={[
          { label: 'Accounting' },
          { label: 'Journal', href: '/reports/journal' },
          { label: 'Edit entry' },
        ]}
      />
      <Callout tone="warning" title="This entry is posted">
        The entry it replaces is mirrored when this is saved, so it stops counting in every ledger and report. Both it
        and the correction stay in the journal, where the change can be read.
      </Callout>
      <JournalForm
        accounts={[...entryOptions, ...extra]}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={rates.local}
        ratesByCurrency={rates.byCurrency}
        today={toDateInputValue(companyToday(user.activeCompany.timezone))}
        initial={{
          entryId: entry.id,
          entryDate: toDateInputValue(entry.entryDate),
          description: entry.description,
          reference: entry.reference ?? '',
          // The rate the voucher was written at, carried on its lines.
          rateLocalPerUsd: (entry.lines[0]?.rateLocalPerUsd ?? rates.local).toString(),
          lines: initialLines,
        }}
      />
    </div>
  );
}
