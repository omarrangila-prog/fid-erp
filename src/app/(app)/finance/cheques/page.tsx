import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { getChequeSummary } from '@/lib/services/cheque';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/shared/stat-card';
import { Callout } from '@/components/ui/feedback';
import { EmptyAction } from '@/components/shared/empty-action';
import { ChequesClient, type ChequeRow } from '@/app/(app)/finance/cheques/cheques-client';

export const metadata: Metadata = { title: 'Cheque Register' };
export const dynamic = 'force-dynamic';

export default async function ChequesPage() {
  const user = await requirePageAccess(PERMISSIONS.CHEQUES_VIEW);
  const companyId = user.activeCompany.id;

  const [cheques, accounts, summary] = await Promise.all([
    prisma.cheque.findMany({
      where: { companyId },
      orderBy: [{ chequeDate: 'desc' }],
      include: {
        customer: { select: { customerName: true } },
        vendor: { select: { vendorName: true } },
        receipt: { select: { id: true, receiptNumber: true } },
        payment: { select: { id: true, paymentNumber: true } },
      },
    }),
    prisma.cashBankAccount.findMany({
      where: { companyId, status: 'ACTIVE', accountType: 'BANK' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, currency: true },
    }),
    transaction((tx) => getChequeSummary(tx, companyId)),
  ]);

  const rows: ChequeRow[] = cheques.map((c) => ({
    id: c.id,
    chequeNumber: c.chequeNumber,
    direction: c.direction,
    party: c.customer?.customerName ?? c.vendor?.vendorName ?? c.beneficiary ?? '—',
    bankName: c.bankName,
    chequeDate: formatDate(c.chequeDate),
    chequeDateSort: c.chequeDate.getTime(),
    currency: c.currency,
    amount: formatMoney(c.amount, c.currency),
    amountSort: Number(c.amountUsd),
    status: c.status,
    depositDate: formatDate(c.depositDate),
    clearingDate: formatDate(c.clearingDate),
    bounceReason: c.bounceReason,
    voucherNumber: c.receipt?.receiptNumber ?? c.payment?.paymentNumber ?? null,
    voucherHref: c.receipt
      ? `/finance/receipts/${c.receipt.id}`
      : c.payment
        ? `/finance/payments/${c.payment.id}`
        : null,
  }));

  const onHand = summary.filter((s) => s.direction === 'INBOUND' && ['RECEIVED', 'DEPOSITED'].includes(s.status));
  const issued = summary.filter((s) => s.direction === 'OUTBOUND' && ['RECEIVED', 'DEPOSITED'].includes(s.status));
  const bounced = summary.filter((s) => s.status === 'BOUNCED');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cheque Register"
        description="Cheques received and issued, from the day they arrive to the day they clear."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Cheques' }]}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Cheques on hand"
          value={String(onHand.reduce((a, s) => a + s.count, 0))}
          sublabel={onHand.map((s) => formatMoney(s.total, s.currency)).join(' · ') || 'None'}
        />
        <StatCard
          label="Cheques issued"
          value={String(issued.reduce((a, s) => a + s.count, 0))}
          sublabel={issued.map((s) => formatMoney(s.total, s.currency)).join(' · ') || 'None'}
        />
        <StatCard
          label="Bounced"
          value={String(bounced.reduce((a, s) => a + s.count, 0))}
          tone={bounced.length > 0 ? 'negative' : 'default'}
          sublabel={bounced.map((s) => formatMoney(s.total, s.currency)).join(' · ') || 'None'}
        />
        <StatCard label="Total recorded" value={String(cheques.length)} />
      </div>

      <Callout tone="info" title="A cheque is not cash until it clears">
        Receiving one moves the balance from the customer into <strong>Cheques on Hand</strong>. Depositing records
        that it is with the bank but moves no money. Only <strong>clearing</strong> increases the bank account. If it
        bounces, the amount goes straight back onto the customer&rsquo;s account.
      </Callout>

      <ChequesClient
        emptyAction={
          can(user, PERMISSIONS.RECEIPTS_CREATE) ? (
            <EmptyAction href="/finance/receipts/new" label="Record a receipt by cheque" tone="go" />
          ) : undefined
        }
        rows={rows}
        accounts={accounts}
        canManage={can(user, PERMISSIONS.CHEQUES_UPDATE_STATUS)}
      />
    </div>
  );
}
