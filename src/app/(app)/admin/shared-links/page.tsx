import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/guards';
import { isDeveloper } from '@/lib/auth/developer';
import { PERMISSIONS } from '@/lib/constants';
import { listShareLinks } from '@/lib/services/report-share';
import { shareReportLabel } from '@/lib/share/model';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { RevokeLinkButton } from '@/components/share/revoke-link-button';

export const metadata: Metadata = { title: 'Shared Links' };

/**
 * The secure report links that are still open, so the owner or an
 * administrator can withdraw one. Everybody else sees only the links they
 * made themselves. This is not the share log — that is the developer's.
 */
export default async function SharedLinksPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const developer = isDeveloper(user);
  const everyone = user.isSuperAdmin || can(user, PERMISSIONS.USERS_MANAGE) || developer;

  const links = (await listShareLinks(user.activeCompany.id)).filter((l) => l.status === 'active' && (everyone || l.createdBy === user.id));

  return (
    <div className="space-y-5" data-testid="shared-links">
      <PageHeader
        title="Shared Links"
        description={`Secure report links that still open${everyone ? '' : ' — the ones you shared'}. Revoke one and it stops working at once.`}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Shared Links' }]}
        actions={
          developer ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/share-activity">Share activity</Link>
            </Button>
          ) : undefined
        }
      />
      {links.length === 0 ? (
        <EmptyState title="No open links" description="Links made with Share on WhatsApp → Secure link appear here until they expire or are revoked." />
      ) : (
        <TableWrap>
          <Table data-testid="shared-links-table">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Shared</TH>
                <TH>Report</TH>
                <TH>Party / period</TH>
                <TH>Shared by</TH>
                <TH>Expires</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {links.map((l) => (
                <TR key={l.shareId} data-testid="shared-link-row">
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(l.createdAt)}</TD>
                  <TD>{shareReportLabel(l.report)}</TD>
                  <TD>
                    <span className="block">{l.subject ?? l.title}</span>
                    {l.period ? <span className="block text-[11px] text-ink-muted">{l.period}</span> : null}
                  </TD>
                  <TD>{l.createdByName}</TD>
                  <TD className="whitespace-nowrap text-xs">{l.expiresAt ? formatDateTime(l.expiresAt) : <Badge tone="warning">Never</Badge>}</TD>
                  <TD className="text-right">
                    <RevokeLinkButton shareId={l.shareId} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
