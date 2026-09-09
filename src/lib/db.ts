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
 * `DATABASE_SSL_CA` may carry a root certificate when the provider uses its own
 * CA. It accepts either a path to a `.crt` file or the PEM text itself, because
 * a serverless host has no reliable working directory to resolve a path
 * against, and pasting the certificate into an environment variable is the only
 * option there. Supabase offers a CA to download, though its pooler
 * certificates verify against the public roots Node already trusts.
 */
function resolveCertificate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // A PEM body is unmistakable, and never a valid path.
  if (value.includes('-----BEGIN')) return value;
  try {
    return readFileSync(value, 'utf8');
  } catch {
    // A missing certificate file must not take the process down at import
    // time. Verification below still applies; it simply falls back to the
    // public roots, which is correct for Supabase's pooler.
    console.warn(`DATABASE_SSL_CA points at ${value}, which could not be read. Falling back to the system roots.`);
    return undefined;
  }
}

function resolveConnection(rawUrl: string): PoolConfig {
  const url = new URL(rawUrl);
  const mode = url.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? null;

  // Leave the rest of the query string (schema, application_name…) intact.
  url.searchParams.delete('sslmode');
  const connectionString = url.toString();

  if (!mode || mode === 'disable') {
    return { connectionString };
  }

  const ca = resolveCertificate(process.env.DATABASE_SSL_CA);

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

function client(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }
  return globalForPrisma.prisma;
}

/**
 * The client is built on first use, not on import.
 *
 * Next's build collects page data by importing every route in a process that
 * has no environment variables, so constructing the client at module scope
 * threw "DATABASE_URL is not set" and failed the build for routes that would
 * never run at build time. Deferring it means importing this module is free,
 * and the error still surfaces — loudly, and at the first query — if the
 * variable really is missing when the application runs.
 *
 * The instance is cached on globalThis so a development hot reload reuses one
 * pool instead of exhausting Postgres with a new one per module evaluation.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    return Reflect.get(client(), property, receiver);
  },
  set(_target, property, value, receiver) {
    return Reflect.set(client(), property, value, receiver);
  },
  has(_target, property) {
    return Reflect.has(client(), property);
  },
});

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
