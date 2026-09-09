import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';

/**
 * Prisma 7 requires an explicit driver adapter. A single pooled adapter is
 * reused across hot reloads in development so we do not exhaust Postgres
 * connections while Next.js re-evaluates modules.
 */

/**
 * TLS for managed Postgres (Supabase, Neon, RDS…).
 *
 * `pg` parses the connection string *after* the config object and overwrites
 * whatever we pass, so the only way to control the certificate policy is to
 * take `sslmode` out of the URL and decide here.
 *
 *   sslmode=disable    plain TCP — local development only
 *   sslmode=no-verify  encrypted, certificate not checked (self-signed CA)
 *   anything else      encrypted, certificate chain verified
 *
 * `DATABASE_SSL_CA` may point at a root certificate file when the provider
 * uses its own CA; Supabase offers one to download, though its pooler
 * certificates verify against the public roots Node already trusts.
 */
function resolveConnection(rawUrl: string): PoolConfig {
  const url = new URL(rawUrl);
  const mode = url.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? null;

  // Leave the rest of the query string (schema, application_name…) intact.
  url.searchParams.delete('sslmode');
  const connectionString = url.toString();

  if (!mode || mode === 'disable') {
    return { connectionString };
  }

  const ca = process.env.DATABASE_SSL_CA ? readFileSync(process.env.DATABASE_SSL_CA, 'utf8') : undefined;

  return {
    connectionString,
    ssl: { ca, rejectUnauthorized: mode !== 'no-verify' },
  };
}

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
  }

  const adapter = new PrismaPg({
    ...resolveConnection(connectionString),
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * The transaction client type. Every domain service accepts this so that a
 * caller can compose multiple service calls inside one atomic transaction.
 */
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * A hosted database adds a network round-trip to every statement inside a
 * transaction, so the ceiling that is generous on localhost can be tight from
 * another continent. Raise DATABASE_TRANSACTION_TIMEOUT_MS if posting starts
 * timing out; the right answer is usually a database closer to the server.
 */
const DEFAULT_TRANSACTION_TIMEOUT_MS = Number(process.env.DATABASE_TRANSACTION_TIMEOUT_MS ?? 20_000);

/**
 * Runs `fn` inside a database transaction. Serializable-adjacent defaults are
 * intentional: financial posting must not observe torn reads of stock or
 * balances. We use the ORM default (read committed) plus explicit row locks in
 * the services, which is the standard approach for high-write ERP posting.
 */
export function transaction<T>(
  fn: (tx: Tx) => Promise<T>,
  timeoutMs = DEFAULT_TRANSACTION_TIMEOUT_MS,
): Promise<T> {
  return prisma.$transaction(fn, { timeout: timeoutMs, maxWait: 10_000 });
}
