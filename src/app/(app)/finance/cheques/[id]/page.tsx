import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS, CHEQUE_STATUS_META } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { DetailRow } from '@/components/shared/stat-card';
import { ChequeStatusActions } from '@/app/(app)/finance/cheques/[id]/cheque-status-actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const cheque = await prisma.cheque.findUnique({ where: { id }, select: { chequeNumber: true } });
  return { title: cheque ? `Cheque ${cheque.chequeNumber}` : 'Cheque' };
}

export default async function ChequeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.CHEQUES_VIEW);
  const companyId = user.activeCompany.id;

  const cheque = await prisma.cheque.findFirst({
    where: { id, companyId },
    include: {
      customer: { select: { id: true, customerName: true } },
      vendor: { select: { id: true, vendorName: true } },
      agent: { select: { agentName: true } },
      receipt: { select: { id: true, receiptNumber: true } },
      payment: { select: { id: true, paymentNumber: true } },
      cashBankAccount: { select: { name: true, currency: true } },
      createdBy: { select: { name: true } },
      statusHistory: {
        orderBy: { changedAt: 'asc' },
        include: { changedBy: { select: { name: true } } },
      },
    },
  });

  if (!cheque) notFound();

  const bankAccounts = await prisma.cashBankAccount.findMany({
    where: { companyId, status: 'ACTIVE', currency: cheque.currency, accountType: 'BANK' },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, currency: true },
  });

  const isInbound = cheque.direction === 'INBOUND';
  const party = isInbound ? cheque.customer?.customerName : cheque.vendor?.vendorName;
  const partyHref = isInbound
    ? cheque.customer
      ? `/customers/${cheque.customer.id}`
      : null
    : cheque.vendor
      ? `/vendors/${cheque.vendor.id}`
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Cheque ${cheque.chequeNumber}`}
        description={`${isInbound ? 'Received from' : 'Issued to'} ${party ?? 'unknown party'} · ${cheque.bankName}`}
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Cheques', href: '/finance/cheques' },
          { label: cheque.chequeNumber },
        ]}
        meta={
          <>
            <StatusBadge status={cheque.status} meta={CHEQUE_STATUS_META} />
            <Badge tone="neutral">{isInbound ? 'Inbound' : 'Outbound'}</Badge>
            <Badge tone="neutral">{formatMoney(cheque.amount, cheque.currency)}</Badge>
          </>
        }
      />

      {cheque.status === 'BOUNCED' ? (
        <Callout tone="danger" title="This cheque bounced">
          {isInbound
            ? 'The receivable has been reinstated, so the customer owes this money again. It is not cash.'
            : 'The liability to the supplier has been reinstated.'}
          {cheque.bounceReason ? ` Reason given: ${cheque.bounceReason}.` : ''}
        </Callout>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Instrument</CardTitle>
            <CardDescription>
              A cheque is only cash once it clears. Until then it sits in {isInbound ? 'cheques on hand' : 'cheques issued'}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-8 sm:grid-cols-2">
              <div>
                <DetailRow label="Cheque number">{cheque.chequeNumber}</DetailRow>
                <DetailRow label="Cheque date">{formatDate(cheque.chequeDate)}</DetailRow>
                <DetailRow label="Drawee bank">{cheque.bankName}</DetailRow>
                <DetailRow label="Amount">{formatMoney(cheque.amount, cheque.currency)}</DetailRow>
                <DetailRow label="USD equivalent">{formatMoney(cheque.amountUsd, 'USD')}</DetailRow>
                <DetailRow label="Beneficiary">{cheque.beneficiary ?? '—'}</DetailRow>
              </div>
              <div>
                <DetailRow label={isInbound ? 'Customer' : 'Supplier'}>
                  {partyHref && party ? (
                    <Link href={partyHref} className="text-forest-800 hover:text-gold-700">
                      {party}
                    </Link>
                  ) : (
                    (party ?? '—')
                  )}
                </DetailRow>
                <DetailRow label="Agent">{cheque.agent?.agentName ?? '—'}</DetailRow>
                <DetailRow label="Voucher">
                  {cheque.receipt ? (
                    <Link href={`/finance/receipts/${cheque.receipt.id}`} className="text-forest-800 hover:text-gold-700">
                      {cheque.receipt.receiptNumber}
                    </Link>
                  ) : cheque.payment ? (
                    <Link href={`/finance/payments/${cheque.payment.id}`} className="text-forest-800 hover:text-gold-700">
                      {cheque.payment.paymentNumber}
                    </Link>
                  ) : (
                    '—'
                  )}
                </DetailRow>
                <DetailRow label="Bank account">{cheque.cashBankAccount?.name ?? 'Not yet banked'}</DetailRow>
                <DetailRow label="Recorded by">{cheque.createdBy.name}</DetailRow>
                <DetailRow label="Recorded on">{formatDate(cheque.createdAt)}</DetailRow>
              </div>
            </dl>

            {cheque.notes ? (
              <p className="mt-4 rounded-lg bg-forest-50 p-3 text-xs leading-relaxed text-ink-muted">{cheque.notes}</p>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {can(user, PERMISSIONS.CHEQUES_UPDATE_STATUS) ? (
            <ChequeStatusActions
              chequeId={cheque.id}
              status={cheque.status}
              currency={cheque.currency}
              bankAccounts={bankAccounts}
            />
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Key dates</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <DetailRow label="Received">{formatDate(cheque.receivedDate)}</DetailRow>
                <DetailRow label="Deposited">{formatDate(cheque.depositDate)}</DetailRow>
                <DetailRow label="Cleared">{formatDate(cheque.clearingDate)}</DetailRow>
                <DetailRow label="Bounced">{formatDate(cheque.bounceDate)}</DetailRow>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>Every status change, with who made it.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {cheque.statusHistory.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 border-b border-line pb-3 last:border-0 last:pb-0">
                <StatusBadge status={entry.toStatus} meta={CHEQUE_STATUS_META} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-ink-muted">
                    {entry.fromStatus ? `From ${entry.fromStatus.toLowerCase()} · ` : ''}
                    {entry.changedBy.name} · {formatDateTime(entry.changedAt)}
                  </p>
                  {entry.notes ? <p className="mt-0.5 text-xs text-ink">{entry.notes}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
