import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { openShareLink } from '@/lib/services/report-share';
import { SharedReportView } from '@/components/share/shared-report-view';

/**
 * A report somebody shared on WhatsApp, opened from its secure link.
 *
 * Outside the signed-in application on purpose: no session, no menu, no way
 * from here into anything else. The page title says nothing about the report,
 * because WhatsApp shows the title in its link preview; and the robots that
 * draw those previews are shown nothing at all and do not count as a view.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Shared report',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

const PREVIEW_ROBOT = /whatsapp|facebookexternalhit|facebot|telegrambot|twitterbot|slackbot|linkedinbot|discordbot|skypeuripreview|googlebot|bingbot|embedly|preview/i;

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-2 px-6 text-center" data-testid="shared-notice">
      <p className="text-sm font-semibold text-ink-muted">FID Trading</p>
      <h1 className="text-lg font-semibold text-ink">{title}</h1>
      <p className="text-sm text-ink-muted">{body}</p>
    </main>
  );
}

export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const userAgent = h.get('user-agent') ?? '';
  if (PREVIEW_ROBOT.test(userAgent)) {
    return <Notice title="Shared report" body="Open this link to view the report." />;
  }

  const result = await openShareLink(token, {
    countView: true,
    client: { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null, userAgent },
  });

  if (result.status === 'expired') return <Notice title="This link has expired" body="Ask the person who shared it to send a new one." />;
  if (result.status === 'revoked') return <Notice title="This link was withdrawn" body="The person who shared this report has withdrawn it." />;
  if (result.status !== 'active') return <Notice title="This link is not valid" body="Check that the whole link was copied, or ask for a new one." />;

  return (
    <div className="min-h-dvh bg-paper">
      <SharedReportView snapshot={result.snapshot} expiresAt={result.link.expiresAt} />
    </div>
  );
}
