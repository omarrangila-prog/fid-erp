import 'server-only';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { BusinessRuleError } from '@/lib/errors';

/**
 * Database backup.
 *
 * A backup nobody can point at is not a backup, so every attempt is recorded —
 * failures as prominently as successes — and the file is checksummed so a
 * silently truncated dump is detectable before it is needed.
 *
 * This complements the database host's own backups rather than replacing them.
 * Supabase and most managed providers take their own snapshots; this exists so
 * an administrator can take one on demand, before a risky change, and hold a
 * copy outside the provider.
 */

const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join(process.cwd(), 'backups');
const RETAIN_DAILY = Number(process.env.BACKUP_RETAIN_DAILY ?? 14);

/**
 * `DIRECT_URL` first, and the pooled URL only as a fallback.
 *
 * `DATABASE_URL` points at a connection pooler. The application wants that —
 * it is what makes many short web requests affordable. `pg_dump` does not: it
 * holds one long transaction and reads the catalogue, and against a pooler it
 * hangs until something times it out. `DIRECT_URL` is the connection meant for
 * exactly this kind of work, which is why migrations already use it.
 */
function connectionString(): string {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new BusinessRuleError('No database connection is configured, so a backup cannot be taken.');
  }
  return url;
}

/** The major version of the local pg_dump, or null when it is not installed. */
async function localDumpMajor(): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = spawn('pg_dump', ['--version']);
    let out = '';
    probe.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    probe.on('error', () => resolve(null));
    probe.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const match = out.match(/(\d+)\./);
      resolve(match ? Number(match[1]) : null);
    });
  });
}

/**
 * The major version of the server being backed up.
 *
 * `SHOW server_version` returns a column called `server_version`, not
 * `version`. Reading the wrong name gave undefined, the match on it threw, and
 * the catch below turned a broken check into "everything is fine" — which is
 * the worst possible failure mode for a readiness check.
 */
async function serverMajor(): Promise<number | null> {
  const rows = await prisma.$queryRaw<Array<{ server_version: string }>>`SHOW server_version`;
  const match = rows[0]?.server_version?.match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Whether a backup can actually be taken here.
 *
 * It used to check only that `pg_dump` existed. It does exist on this machine,
 * at version 16, and the database is 17 — so pg_dump connected, read the
 * server version and refused, and the operator got "aborting because of server
 * version mismatch" after waiting for a dump that was never going to happen.
 *
 * A dump taken by an older pg_dump is not merely discouraged, it is refused,
 * and a backup you cannot rely on is worse than knowing you have none. So the
 * check is made before the button is offered, and the reason is given in words
 * that say what to install.
 */
export async function backupToolAvailable(): Promise<boolean> {
  return (await backupReadiness()).ready;
}

export async function backupReadiness(): Promise<{ ready: boolean; reason?: string }> {
  const local = await localDumpMajor();
  if (local === null) {
    return {
      ready: false,
      reason:
        'pg_dump is not installed on this server, so a backup cannot be taken here. Install the PostgreSQL client tools, or rely on the database provider’s own backups.',
    };
  }

  const server = await serverMajor().catch(() => null);
  if (server !== null && local < server) {
    return {
      ready: false,
      reason:
        `The database is PostgreSQL ${server} and the backup tool on this server is version ${local}. ` +
        `PostgreSQL refuses to dump a newer database with an older tool, so this would fail rather than ` +
        `produce a partial file. Install postgresql-client-${server}, or use the database provider’s own backups.`,
    };
  }

  return { ready: true };
}

async function sha256(file: string): Promise<string> {
  const contents = await readFile(file);
  return createHash('sha256').update(contents).digest('hex');
}

/**
 * Deletes dumps older than the retention window, but never the last one
 * standing — a retention policy that can leave you with nothing is worse than
 * none at all.
 */
async function prune(): Promise<number> {
  const entries = await readdir(/* turbopackIgnore: true */ BACKUP_DIR).catch(() => [] as string[]);
  const dumps = entries.filter((name) => name.endsWith('.sql'));
  if (dumps.length <= 1) return 0;

  const cutoff = Date.now() - RETAIN_DAILY * 86_400_000;
  const withTimes = await Promise.all(
    dumps.map(async (name) => {
      const full = path.join(/* turbopackIgnore: true */ BACKUP_DIR, name);
      const info = await stat(/* turbopackIgnore: true */ full);
      return { full, time: info.mtimeMs };
    }),
  );
  withTimes.sort((a, b) => b.time - a.time);

  let removed = 0;
  // Skip index 0: the newest is kept whatever its age.
  for (const entry of withTimes.slice(1)) {
    if (entry.time < cutoff) {
      await unlink(entry.full).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}

export async function runBackup(params: {
  companyId?: string | null;
  userId?: string | null;
  trigger: 'MANUAL' | 'SCHEDULED';
}) {
  const readiness = await backupReadiness();
  if (!readiness.ready) {
    throw new BusinessRuleError(readiness.reason!);
  }

  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `fid-${stamp}.sql`);

  const run = await prisma.backupRun.create({
    data: {
      companyId: params.companyId ?? null,
      createdById: params.userId ?? null,
      trigger: params.trigger,
      status: 'IN_PROGRESS',
      location: file,
    },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      // --no-owner keeps the dump restorable into a differently-owned database.
      const child = spawn('pg_dump', ['--no-owner', '--no-privileges', '--format=plain', '--file', file, connectionString()]);
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `pg_dump exited with code ${code}`));
      });
    });

    const info = await stat(file);
    if (info.size === 0) {
      throw new Error('pg_dump produced an empty file.');
    }

    const completed = await prisma.backupRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        sizeBytes: BigInt(info.size),
        checksum: await sha256(file),
      },
    });

    await prune();
    return completed;
  } catch (error) {
    await prisma.backupRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorMessage: (error as Error).message.slice(0, 500),
      },
    });
    // Surfaced rather than swallowed: a silent failure is the worst outcome.
    throw new BusinessRuleError(`The backup did not complete: ${(error as Error).message}`);
  }
}

export async function getBackupHistory(limit = 30) {
  const runs = await prisma.backupRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: { createdBy: { select: { name: true } }, company: { select: { name: true } } },
  });

  const lastGood = runs.find((run) => run.status === 'COMPLETED') ?? null;

  return {
    runs: runs.map((run) => ({
      id: run.id,
      trigger: run.trigger,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      sizeBytes: run.sizeBytes ? Number(run.sizeBytes) : null,
      location: run.location,
      checksum: run.checksum,
      errorMessage: run.errorMessage,
      createdBy: run.createdBy?.name ?? 'System',
      company: run.company?.name ?? 'All companies',
    })),
    lastSuccessfulAt: lastGood?.startedAt ?? null,
    healthy: lastGood !== null && Date.now() - lastGood.startedAt.getTime() < 2 * 86_400_000,
    directory: BACKUP_DIR,
    retainDays: RETAIN_DAILY,
  };
}
