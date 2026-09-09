import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { PageHeader } from '@/components/shared/page-header';
import { AttachmentPanel } from '@/components/attachments/attachment-panel';
import { CreditNoteActions } from '@/components/credit-notes/credit-note-actions';
import { formatMoney, formatDate, formatDateTime } from '@/lib/format';
import { dec } from '@/lib/money';
import type { loadCreditNoteDetail } from '@/components/credit-notes/data';
import type { BadgeTone } from '@/lib/constants';

const STATUS_TONES: Record<string, BadgeTone> = { DRAFT: 'neutral', POSTED: 'success', REVERSED: 'danger' };

type Detail = NonNullable<Awaited<ReturnType<typeof loadCreditNoteDetail>>>;

export function CreditNoteDetail({
  detail,
  basePath,
  kind,
  taxLabel,
  canPost,
  canManageAttachments,
  attachments,
}: {
  detail: Detail;
  basePath: string;
  kind: 'customer' | 'supplier';
  taxLabel: string;
  canPost: boolean;
  canManageAttachments: boolean;
  attachments: React.ComponentProps<typeof AttachmentPanel>['attachments'];
}) {
  const { note, lineRows } = detail;
  const party = note.customer?.customerName ?? note.vendor?.vendorName ?? '—';
  const against = note.salesInvoice?.invoiceNumber ?? note.purchaseContract?.contractNumber ?? null;
  const hasTax = dec(note.taxAmount).greaterThan(0);
  const noun = kind === 'customer' ? 'Credit note' : 'Debit note';

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${noun} ${note.creditNoteNumber}`}
        description={note.reason}
        breadcrumbs={[
          { label: kind === 'customer' ? 'Sales' : 'Purchases', href: kind === 'customer' ? '/sales' : '/purchases' },
          { label: `${noun}s`, href: basePath },
          { label: note.creditNoteNumber },
        ]}
        meta={
          <>
            <Badge tone={STATUS_TONES[note.status] ?? 'neutral'}>{note.status.toLowerCase()}</Badge>
            <span className="text-xs text-ink-muted">{formatDate(note.creditDate)}</span>
            <span className="text-xs text-ink-muted">{party}</span>
          </>
        }
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href={basePath}>
                <ArrowLeft />
                Back
              </Link>
            </Button>
            {canPost ? (
              <CreditNoteActions
                id={note.id}
                number={note.creditNoteNumber}
                status={note.status}
                returnsStock={note.lines.some((line) => line.batchId !== null)}
                basePath={basePath}
              />
            ) : null}
          </>
        }
      />

      {note.status === 'DRAFT' ? (
        <Callout tone="info" title="Nothing has been posted yet">
          This is a draft. Posting it{' '}
          {kind === 'customer'
            ? 'reduces what the customer owes and, where coffee is coming back, returns it to the warehouse at its landed cost.'
            : 'reduces what you owe the supplier.'}
        </Callout>
      ) : null}

      {note.status === 'REVERSED' ? (
        <Callout tone="warning" title="This note has been reversed">
          {note.reversalReason} — reversed {formatDateTime(note.reversedAt)}.
        </Callout>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <CardContent className="px-0 sm:px-0">
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>#</TH>
                    <TH>Description</TH>
                    <TH>Coffee returned</TH>
                    <TH numeric>Net</TH>
                    {hasTax ? <TH numeric>{taxLabel}</TH> : null}
                    <TH numeric>Total</TH>
                  </TR>
                </THead>
                <TBody>
                  {lineRows.map((line) => (
                    <TR key={line.id}>
                      <TD>{line.lineNumber}</TD>
                      <TD>{line.description}</TD>
                      <TD>
                        {line.batchNumber ? (
                          <span className="text-xs">
                            <span className="block">
                              {line.quantityLabel} · {line.batchNumber}
                            </span>
                            <span className="block text-ink-subtle">into {line.warehouseName}</span>
                          </span>
                        ) : (
                          <span className="text-xs text-ink-subtle">Value only</span>
                        )}
                      </TD>
                      <TD numeric>{line.netLabel}</TD>
                      {hasTax ? (
                        <TD numeric>
                          {line.taxLabel ?? '—'}
                          {line.taxCodeLabel ? (
                            <span className="block text-xs text-ink-subtle">{line.taxCodeLabel}</span>
                          ) : null}
                        </TD>
                      ) : null}
                      <TD numeric>{line.totalLabel}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-muted">Net</dt>
                  <dd className="tabular-nums">{formatMoney(note.subtotalAmount, note.currency)}</dd>
                </div>
                {hasTax ? (
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">{taxLabel}</dt>
                    <dd className="tabular-nums">{formatMoney(note.taxAmount, note.currency)}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{formatMoney(note.totalAmount, note.currency)}</dd>
                </div>
                {dec(note.costOfGoodsUsd).greaterThan(0) ? (
                  <div className="flex justify-between border-t border-line pt-2 text-xs">
                    <dt className="text-ink-muted">Cost returned to stock</dt>
                    <dd className="tabular-nums">{formatMoney(note.costOfGoodsUsd, 'USD')}</dd>
                  </div>
                ) : null}
              </dl>

              <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-xs text-ink-muted">
                {against ? (
                  <div className="flex justify-between gap-2">
                    <dt>Against</dt>
                    <dd className="text-ink">{against}</dd>
                  </div>
                ) : null}
                {note.reference ? (
                  <div className="flex justify-between gap-2">
                    <dt>Reference</dt>
                    <dd className="text-ink">{note.reference}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-2">
                  <dt>Raised by</dt>
                  <dd className="text-ink">{note.createdBy.name}</dd>
                </div>
                {note.postedBy ? (
                  <div className="flex justify-between gap-2">
                    <dt>Posted by</dt>
                    <dd className="text-ink">{note.postedBy.name}</dd>
                  </div>
                ) : null}
              </dl>

              {note.notes ? <p className="mt-3 border-t border-line pt-3 text-xs text-ink-muted">{note.notes}</p> : null}
            </CardContent>
          </Card>

          <AttachmentPanel
            entityType="CreditNote"
            entityId={note.id}
            attachments={attachments}
            canManage={canManageAttachments}
          />
        </div>
      </div>
    </div>
  );
}
