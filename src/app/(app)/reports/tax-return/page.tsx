import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getTaxSettings } from '@/lib/services/tax';
import { getTaxReturn, listTaxReturns, suggestedTaxPeriod } from '@/lib/services/tax-return';
import { formatDate, formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, THead, TBody, TR, TH, TD, TFoot } from '@/components/ui/table';
import { FileReturnButton } from '@/app/(app)/reports/tax-return/file-return';

export const metadata: Metadata = { title: 'Tax Return' };
export const dynamic = 'force-dynamic';

function iso(date: Date) {
  return date.toISOString().slice(0, 10);
}

export default async function TaxReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const companyId = user.activeCompany.id;
  const params = await searchParams;

  const settings = await getTaxSettings(companyId);

  if (!settings.enabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="Tax Return" breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Tax Return' }]} />
        <EmptyState
          title="This company is not registered for tax"
          description="No tax is charged or reclaimed, so there is no return to prepare. An administrator can enter the registration details in Tax Settings."
          action={
            can(user, PERMISSIONS.SETTINGS_MANAGE) ? (
              <Button asChild>
                <Link href="/settings/tax">Open tax settings</Link>
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const suggested = await suggestedTaxPeriod(companyId, settings.periodMonths);
  const from = params.from ? new Date(`${params.from}T00:00:00.000Z`) : suggested.from;
  const to = params.to ? new Date(`${params.to}T00:00:00.000Z`) : suggested.to;

  const [figures, history] = await Promise.all([
    getTaxReturn({ companyId, from, to }),
    listTaxReturns(companyId),
  ]);

  const currency = figures.localCurrency;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${settings.label} Return`}
        description={`${formatDate(from)} to ${formatDate(to)} · registration ${settings.registrationNumber ?? '—'}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: `${settings.label} Return` }]}
        meta={
          figures.filed ? (
            <Badge tone="success">Filed {formatDateTime(figures.filed.filedAt)}</Badge>
          ) : figures.reconciled ? (
            <Badge tone="info">Agrees with the ledger</Badge>
          ) : (
            <Badge tone="danger">Does not agree with the ledger</Badge>
          )
        }
        actions={
          <>
            <PrintButton />
            {!figures.filed && can(user, PERMISSIONS.ACCOUNTING_POST) ? (
              <FileReturnButton
                from={iso(from)}
                to={iso(to)}
                reconciled={figures.reconciled}
                netPayable={figures.netPayable}
                currency={currency}
              />
            ) : null}
          </>
        }
      />

      <form className="flex flex-wrap items-end gap-3 print:hidden" method="get">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-muted">From</span>
          <input
            type="date"
            name="from"
            defaultValue={iso(from)}
            className="h-9 rounded-lg border border-line-strong bg-surface px-3 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-muted">To</span>
          <input
            type="date"
            name="to"
            defaultValue={iso(to)}
            className="h-9 rounded-lg border border-line-strong bg-surface px-3 text-sm"
          />
        </label>
        <Button type="submit" variant="outline" size="sm">
          Show period
        </Button>
      </form>

      {!figures.reconciled ? (
        <Callout tone="danger" title="These figures do not agree with the ledger">
          Output tax computed from the invoices differs from the {settings.label} Payable control account by{' '}
          <strong>
            {figures.outputDifference} {currency}
          </strong>
          , and input tax differs from {settings.label} Recoverable by{' '}
          <strong>
            {figures.inputDifference} {currency}
          </strong>
          . Something has posted to those accounts that no document explains — usually a manual journal voucher. Find
          it before filing: a number you cannot trace to a posting is how an assessment becomes a penalty.
        </Callout>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryTile label={`Output ${settings.label} (charged)`} value={`${figures.outputTax} ${currency}`} />
        <SummaryTile label={`Input ${settings.label} (reclaimable)`} value={`${figures.inputTax} ${currency}`} />
        <SummaryTile
          label={Number(figures.netPayable) >= 0 ? 'Net payable to the authority' : 'Net refundable to you'}
          value={`${figures.netPayable} ${currency}`}
          strong
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sales</CardTitle>
          <CardDescription>
            Invoices raised in the period, less customer credit notes. Every figure is in {currency}, converted at the
            rate each document was posted at.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-0">
          <BandTable bands={figures.sales} currency={currency} taxLabel={settings.label} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Purchases and expenses</CardTitle>
          <CardDescription>
            Contracts approved and expenses posted in the period, less supplier credits.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-0">
          <BandTable bands={figures.purchases} currency={currency} taxLabel={settings.label} />
        </CardContent>
      </Card>

      {history.length > 0 ? (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Filed periods</CardTitle>
            <CardDescription>Figures as submitted, frozen at the moment of filing.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 sm:px-0">
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Period</TH>
                    <TH numeric>Output</TH>
                    <TH numeric>Input</TH>
                    <TH numeric>Net</TH>
                    <TH>Reference</TH>
                    <TH>Filed</TH>
                  </TR>
                </THead>
                <TBody>
                  {history.map((entry) => (
                    <TR key={entry.id}>
                      <TD>
                        <Link
                          href={`/reports/tax-return?from=${iso(entry.periodStart)}&to=${iso(entry.periodEnd)}`}
                          className="text-forest-700 hover:underline"
                        >
                          {formatDate(entry.periodStart)} → {formatDate(entry.periodEnd)}
                        </Link>
                      </TD>
                      <TD numeric>{entry.outputTax.toFixed(2)}</TD>
                      <TD numeric>{entry.inputTax.toFixed(2)}</TD>
                      <TD numeric>{entry.netPayable.toFixed(2)}</TD>
                      <TD>{entry.reference ?? '—'}</TD>
                      <TD>
                        {entry.filedAt ? (
                          <span className="text-xs">
                            {formatDateTime(entry.filedAt)}
                            {entry.filedBy ? ` · ${entry.filedBy.name}` : ''}
                          </span>
                        ) : (
                          <Badge tone="neutral">draft</Badge>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function SummaryTile({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p className={strong ? 'mt-1 text-2xl font-semibold tabular-nums text-ink' : 'mt-1 text-xl font-semibold tabular-nums text-ink'}>
        {value}
      </p>
    </div>
  );
}

function BandTable({
  bands,
  currency,
  taxLabel,
}: {
  bands: Array<{
    code: string;
    label: string;
    treatment: string;
    ratePct: string;
    netLocal: string;
    taxLocal: string;
    documentCount: number;
  }>;
  currency: string;
  taxLabel: string;
}) {
  if (bands.length === 0) {
    return (
      <p className="px-4 pb-4 text-sm text-ink-subtle">Nothing in this period.</p>
    );
  }

  const netTotal = bands.reduce((sum, band) => sum + Number(band.netLocal), 0);
  const taxTotal = bands.reduce((sum, band) => sum + Number(band.taxLocal), 0);

  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TR>
            <TH>Code</TH>
            <TH>Treatment</TH>
            <TH numeric>Rate</TH>
            <TH numeric>Documents</TH>
            <TH numeric>Net ({currency})</TH>
            <TH numeric>
              {taxLabel} ({currency})
            </TH>
          </TR>
        </THead>
        <TBody>
          {bands.map((band) => (
            <TR key={`${band.code}-${band.ratePct}`}>
              <TD>
                <span className="font-mono font-medium">{band.code}</span>
                <span className="block text-xs text-ink-subtle">{band.label}</span>
              </TD>
              <TD>
                <span className="text-xs">{band.treatment.replace(/_/g, ' ').toLowerCase()}</span>
              </TD>
              <TD numeric>{Number(band.ratePct).toFixed(2)}%</TD>
              <TD numeric>{band.documentCount}</TD>
              <TD numeric>{Number(band.netLocal).toLocaleString(undefined, { minimumFractionDigits: 2 })}</TD>
              <TD numeric>{Number(band.taxLocal).toLocaleString(undefined, { minimumFractionDigits: 2 })}</TD>
            </TR>
          ))}
        </TBody>
        <TFoot>
          <TR>
            <TD>Total</TD>
            <TD />
            <TD />
            <TD />
            <TD numeric>{netTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</TD>
            <TD numeric>{taxTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</TD>
          </TR>
        </TFoot>
      </Table>
    </div>
  );
}
