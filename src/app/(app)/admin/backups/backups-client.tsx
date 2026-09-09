'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { DatabaseBackup, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { runBackupAction } from '@/server/actions/compliance-actions';
import type { BadgeTone } from '@/lib/constants';

export type BackupRow = {
  id: string;
  status: string;
  trigger: string;
  startedAt: string;
  duration: string;
  sizeLabel: string | null;
  location: string | null;
  checksum: string | null;
  errorMessage: string | null;
  createdBy: string;
};

const STATUS_TONES: Record<string, BadgeTone> = {
  COMPLETED: 'success',
  FAILED: 'danger',
  IN_PROGRESS: 'progress',
};

export function BackupsClient({ runs, available }: { runs: BackupRow[]; available: boolean }) {
  const router = useRouter();
  const [running, setRunning] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Take a backup now</CardTitle>
            <CardDescription>
              A full dump of the database, checksummed so a truncated file is detectable before you need it.
            </CardDescription>
          </div>
          <Button loading={running} disabled={!available} onClick={() => setConfirm(true)}>
            <DatabaseBackup />
            Back up now
          </Button>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            Every attempt is recorded, failures included — a backup you believe in but never took is worse than none.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-0">
          {runs.length === 0 ? (
            <div className="px-4 pb-4">
              <EmptyState
                icon={DatabaseBackup}
                title="No backups taken from here yet"
                description="Your database provider takes its own snapshots as well. This is for a copy you hold yourself, before a risky change."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Started</TH>
                    <TH>Status</TH>
                    <TH>Trigger</TH>
                    <TH numeric>Size</TH>
                    <TH numeric>Took</TH>
                    <TH>By</TH>
                    <TH>Location</TH>
                  </TR>
                </THead>
                <TBody>
                  {runs.map((run) => (
                    <TR key={run.id}>
                      <TD>{run.startedAt}</TD>
                      <TD>
                        <Badge tone={STATUS_TONES[run.status] ?? 'neutral'}>
                          {run.status === 'COMPLETED' ? (
                            <CheckCircle2 className="size-3" />
                          ) : run.status === 'FAILED' ? (
                            <XCircle className="size-3" />
                          ) : (
                            <Loader2 className="size-3 animate-spin" />
                          )}
                          {run.status.replace('_', ' ').toLowerCase()}
                        </Badge>
                        {run.errorMessage ? (
                          <span className="mt-1 block max-w-xs text-xs text-red-600">{run.errorMessage}</span>
                        ) : null}
                      </TD>
                      <TD>{run.trigger.toLowerCase()}</TD>
                      <TD numeric>{run.sizeLabel ?? '—'}</TD>
                      <TD numeric>{run.duration}</TD>
                      <TD>{run.createdBy}</TD>
                      <TD>
                        <span className="block max-w-xs truncate font-mono text-xs text-ink-subtle">
                          {run.location ?? '—'}
                        </span>
                        {run.checksum ? (
                          <span className="block max-w-xs truncate font-mono text-[11px] text-ink-subtle">
                            sha256 {run.checksum.slice(0, 16)}…
                          </span>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Take a backup now?"
        description="The whole database is dumped to the server's backup directory. It can take a minute or two on a large database, and the page will wait."
        confirmLabel="Back up now"
        onConfirm={async () => {
          setRunning(true);
          try {
            const result = await runBackupAction();
            if (result.ok) {
              toast.success('Backup completed.');
              router.refresh();
            } else {
              throw new Error(result.error);
            }
          } finally {
            setRunning(false);
          }
        }}
      />
    </>
  );
}
