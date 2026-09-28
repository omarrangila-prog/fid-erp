import type { Metadata } from 'next';
import Link from 'next/link';
import { requireDeveloperPage } from '@/lib/auth/developer';
import { getShareActivity, type ShareActivityFilter } from '@/lib/services/report-share';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { RevokeLinkButton } from '@/components/share/revoke-link-button';

export const metadata: Metadata = { title: 'Share Activity' };

/**
 * Share Activity — for the developer only.
 *
 * Every share the application started, from the log: who, which report, for
 * whom, which dates and filters, how many rows, PDF or link, and what the
 * application actually did. It never says "sent": WhatsApp does not tell
 * anybody that. For links it adds what the server does know — whether the
 * link was opened, when, and how often.
 *
 * The page answers "not found" to everybody else, owner included; the check
 * is here on the server, not in the menu.
 */

const PARTIES = ['Customer', 'Supplier', 'Agent', 'Shipment', 'Account', 'Invoice'];

function dateParam(value: string | undefined, end = false): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
}

export default async function ShareActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireDeveloperPage();
  const params = await searchParams;
  const filter: ShareActivityFilter = {
    from: dateParam(params.from),
    to: dateParam(params.to, true),
    userId: params.user || undefined,
    role: params.role || undefined,
    report: params.report || undefined,
    format: params.format || undefined,
    party: params.party || undefined,
    q: params.q || undefined,
  };
  const { rows, summary, users, roles, reports } = await getShareActivity(user.activeCompany.id, filter);

  const cards: Array<[string, string, string?]> = [
    ['Initiated today', String(summary.today)],
    ['This month', String(summary.month)],
    ['PDF shares', String(summary.pdf)],
    ['Link shares', String(summary.link)],
    ['Most shared report', summary.topReport?.name ?? '—', summary.topReport ? `${summary.topReport.count} shares` : undefined],
    ['Most active user', summary.topUser?.name ?? '—', summary.topUser ? `${summary.topUser.count} shares` : undefined],
  ];

  return (
    <div className="space-y-5" data-testid="share-activity">
      <PageHeader
        title="Share Activity"
        description={`Developer only · ${user.activeCompany.name}. What was shared and what the application did — "WhatsApp opened", never "sent", which it cannot know.`}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Share Activity' }]}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/shared-links">Shared links</Link>
          </Button>
        }
      />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="share-summary-cards">
        {cards.map(([label, value, hint]) => (
          <Card key={label}>
            <CardContent className="space-y-0.5 p-3">
              <dt className="text-[11px] text-ink-muted">{label}</dt>
              <dd className="truncate text-lg font-semibold text-ink">{value}</dd>
              {hint ? <p className="text-[11px] text-ink-subtle">{hint}</p> : null}
            </CardContent>
          </Card>
        ))}
      </dl>

      <form className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-3 text-xs" method="get">
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-ink-muted">
          Search
          <Input name="q" defaultValue={params.q ?? ''} placeholder="RADOUAN, a report, a shipment…" className="h-9" aria-label="Search the share log" />
        </label>
        <label className="flex flex-col gap-1 text-ink-muted">
          User
          <Select name="user" defaultValue={params.user ?? ''} className="h-9 w-40">
            <option value="">Everyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-ink-muted">
          Role
          <Select name="role" defaultValue={params.role ?? ''} className="h-9 w-36">
            <option value="">Any role</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-ink-muted">
          Report
          <Select name="report" defaultValue={params.report ?? ''} className="h-9 w-44">
            <option value="">Any report</option>
            {reports.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-ink-muted">
          Party
          <Select name="party" defaultValue={params.party ?? ''} className="h-9 w-32">
            <option value="">Any</option>
            {PARTIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-ink-muted">
          Share type
          <Select name="format" defaultValue={params.format ?? ''} className="h-9 w-28">
            <option value="">PDF or link</option>
            <option value="PDF">PDF</option>
            <option value="LINK">Link</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-ink-muted">
          From
          <Input type="date" name="from" defaultValue={params.from ?? ''} className="h-9 w-36" />
        </label>
        <label className="flex flex-col gap-1 text-ink-muted">
          To
          <Input type="date" name="to" defaultValue={params.to ?? ''} className="h-9 w-36" />
        </label>
        <Button type="submit" size="sm">
          Apply
        </Button>
        <Button asChild type="button" size="sm" variant="ghost">
          <Link href="/admin/share-activity">Clear</Link>
        </Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No shares recorded" description="Shares appear here as soon as anybody presses Share on a report." />
      ) : (
        <TableWrap>
          <Table data-testid="share-activity-table">
            <THead className="sticky-head">
              <TR className="hover:bg-transparent">
                <TH>Date</TH>
                <TH>User</TH>
                <TH>Role</TH>
                <TH>Report</TH>
                <TH>Party / reference</TH>
                <TH numeric>Rows</TH>
                <TH>Method</TH>
                <TH>Status</TH>
                <TH numeric>Views</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.shareId} data-testid="share-activity-row">
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(r.at)}</TD>
                  <TD>{r.userName}</TD>
                  <TD className="text-xs">{r.roles.join(', ') || '—'}</TD>
                  <TD>
                    <span className="block font-medium">{r.reportLabel}</span>
                    <span className="block text-[11px] text-ink-muted">{r.scope}</span>
                  </TD>
                  <TD className="max-w-[18rem]">
                    <span className="block">{r.subject ?? '—'}</span>
                    {r.period ? <span className="block text-[11px] text-ink-muted">{r.period}</span> : null}
                    {r.filters.length ? <span className="block text-[11px] text-ink-muted">{r.filters.join(' · ')}</span> : null}
                  </TD>
                  <TD numeric>{r.rows.toLocaleString('en-US')}</TD>
                  <TD className="whitespace-nowrap">
                    <Badge tone={r.format === 'LINK' ? 'info' : 'neutral'}>{r.format === 'LINK' ? 'Link' : 'PDF'}</Badge>
                    <span className="block text-[11px] text-ink-muted">{r.method}</span>
                  </TD>
                  <TD className="text-xs">
                    {r.statuses.map((s) => (
                      <span key={s} className="block">
                        {s}
                      </span>
                    ))}
                    {r.link ? (
                      <span className="block text-[11px] text-ink-muted">
                        {r.link.status === 'active'
                          ? r.link.expiresAt
                            ? `Link active until ${formatDateTime(r.link.expiresAt)}`
                            : 'Link active, never expires'
                          : r.link.status === 'revoked'
                            ? `Revoked${r.link.revokedByName ? ` by ${r.link.revokedByName}` : ''}`
                            : 'Link expired'}
                      </span>
                    ) : null}
                  </TD>
                  <TD numeric>
                    {r.link ? (
                      <>
                        <span className="block" data-testid="share-activity-views">
                          {r.link.views}
                        </span>
                        {r.link.lastViewedAt ? <span className="block text-[11px] text-ink-muted">last {formatDateTime(r.link.lastViewedAt)}</span> : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD className="text-right">{r.link?.status === 'active' ? <RevokeLinkButton shareId={r.shareId} /> : null}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
