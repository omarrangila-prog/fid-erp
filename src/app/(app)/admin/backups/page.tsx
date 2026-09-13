import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { formatDateTime } from '@/lib/format';
import { getBackupHistory, backupReadiness } from '@/lib/services/backup';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { BackupsClient, type BackupRow } from '@/app/(app)/admin/backups/backups-client';

export const metadata: Metadata = { title: 'Backups' };
export const dynamic = 'force-dynamic';

function humanSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function duration(from: Date, to: Date | null): string {
  if (!to) return '—';
  const seconds = Math.round((to.getTime() - from.getTime()) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default async function BackupsPage() {
  await requirePageAccess(PERMISSIONS.BACKUP_MANAGE);

  const [history, readiness] = await Promise.all([getBackupHistory(), backupReadiness()]);
  const available = readiness.ready;

  const runs: BackupRow[] = history.runs.map((run) => ({
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    startedAt: formatDateTime(run.startedAt),
    duration: duration(run.startedAt, run.finishedAt),
    sizeLabel: humanSize(run.sizeBytes),
    location: run.location,
    checksum: run.checksum,
    errorMessage: run.errorMessage,
    createdBy: run.createdBy,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Backups"
        description="An on-demand copy of the database, held by you rather than only by the hosting provider."
        breadcrumbs={[{ label: 'Administration' }, { label: 'Backups' }]}
      />

      {!available ? (
        <Callout tone="warning" title="Backups cannot be taken from this server">
          {/*
            The specific reason, not a guess at it.
            
            This used to assume the only possible cause was pg_dump being
            absent. It is present on this machine — at version 16, against a
            database that is version 17, which PostgreSQL refuses outright. The
            operator pressed the button, waited, and got "aborting because of
            server version mismatch" with nothing telling them what to do.
          */}
          <p>{readiness.reason}</p>
          <p className="mt-2">
            On a serverless host such as Vercel a backup can never be taken here in any case — the filesystem is
            read-only and each request runs in a container that is thrown away, so there is nowhere for a dump to live.
          </p>
          <p className="mt-2">
            Your database is on Supabase, which takes its own automatic backups and offers point-in-time recovery from
            the Supabase dashboard. That is the recovery path for this installation. This page becomes usable if the
            application is ever run on a server of your own with the PostgreSQL client tools installed.
          </p>
        </Callout>
      ) : history.lastSuccessfulAt === null ? (
        <Callout tone="warning" title="No successful backup has been taken from here">
          Your database provider is still taking its own snapshots. Take one here as well before any change you would
          not want to repeat by hand.
        </Callout>
      ) : !history.healthy ? (
        <Callout tone="warning" title="The last backup from here is more than two days old">
          Taken {formatDateTime(history.lastSuccessfulAt)}.
        </Callout>
      ) : (
        <Callout tone="info" title="Last backup">
          {formatDateTime(history.lastSuccessfulAt)} · kept for {history.retainDays} days in{' '}
          <code>{history.directory}</code>. The most recent dump is never pruned, whatever its age.
        </Callout>
      )}

      <BackupsClient runs={runs} available={available} />
    </div>
  );
}
