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

/**
 * Serverless belongs on the transaction pooler, not the session one.
 *
 * Supabase offers the same database on two ports. 5432 is session mode: each
 * client holds a Postgres backend for as long as it is connected, and there
 * are about fifteen of those in total. 6543 is transaction mode: a client
 * borrows a backend for the length of one transaction and gives it straight
 * back, which is why it can serve far more callers than there are backends.
 *
 * A serverless deployment is many short-lived instances, so session mode runs
 * out — and it did, on the client's books: "Unable to start a transaction in
 * the given time" on every attempt at saving a cost, with the work never
 * beginning. Waiting and trying again does not help when the slots are held
 * by other instances, which is what the retry above proved.
 *
 * So a serverless process pointed at the session port is moved to the
 * transaction port. Migrations are unaffected: they run from DIRECT_URL,
 * which is left exactly as it is and must stay on session mode. Set
 * DATABASE_POOLER_MODE=session to turn this off.
 */
function preferTransactionPooler(url: URL): URL {
  const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const supabasePooler = /\.pooler\.supabase\.com$/i.test(url.hostname);
  // A connection string may leave the port out; Postgres reads that as 5432,
  // and so must this, or the session port goes unnoticed for want of five
  // characters — which is exactly what happened the first time.
  const port = url.port || '5432';

  const moving = serverless && supabasePooler && port === '5432' && process.env.DATABASE_POOLER_MODE !== 'session';
  const moved = new URL(url.toString());
  if (moving) moved.port = '6543';

  /*
   * Said out loud on every boot, because the last round of this was spent
   * guessing which connection the deployment had. Host and port only — never
   * the user, never the password.
   */
  console.warn(
    `[database] connecting to ${moved.hostname}:${moved.port || '5432'}` +
      (moving ? ' — moved off the session pooler (5432), which a serverless runtime exhausts' : '') +
      (serverless ? ' · serverless' : ' · long-running') +
      (supabasePooler ? ' · supabase pooler' : '') +
      ` · pool max ${defaultPoolSize(moved.toString())}` +
      ` · waits ${DEFAULT_TRANSACTION_MAX_WAIT_MS}ms for a connection, then ${DEFAULT_TRANSACTION_TIMEOUT_MS}ms to finish`,
  );

  return moved;
}

function resolveConnection(rawUrl: string): PoolConfig {
  const url = preferTransactionPooler(new URL(rawUrl));
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

/**
 * How many connections one instance of this process may hold.
 *
 * A connection pooler is a shared, and small, resource: Supabase's session
 * pooler allows fifteen clients in total across everything that connects. A
 * serverless deployment runs many instances of this process at once, so ten
 * connections each meant two instances could take every slot and the third
 * user to arrive was met with "max clients reached" — a 500 on the sign-in
 * page, which is the one page nobody can work around.
 *
 * Behind a pooler, one is the right number: each request is served by one
 * instance doing one thing, and the pooler is what does the pooling. A direct
 * connection to Postgres — a local database, a migration, a script — keeps a
 * real pool, because there the connections are ours to spend.
 */
function defaultPoolSize(rawUrl: string): number {
  let host = '';
  let query = '';
  try {
    const url = new URL(rawUrl);
    host = url.hostname;
    query = url.search;
  } catch {
    // An unparseable URL will fail later, and loudly. Assume the safe number.
    return 1;
  }

  const pooled = /pooler\.|pgbouncer|-pooler/.test(host) || /pgbouncer=true/.test(query);
  const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const configured = process.env.DATABASE_POOL_MAX ? Math.max(1, Number(process.env.DATABASE_POOL_MAX)) : null;

  /*
   * Behind a pooler, one is the right number and a setting cannot make it
   * otherwise.
   *
   * This used to take DATABASE_POOL_MAX at its word. A setting of ten, made
   * when the database was addressed directly, then had every serverless
   * instance reaching for ten connections at once — and a pooler with a few
   * dozen client slots is emptied by a handful of instances doing that. The
   * symptom is a transaction that cannot start, which is what the client was
   * looking at, and it survives moving to the transaction pooler because the
   * demand, not the port, is what is wrong.
   *
   * So the setting is honoured where the connections are genuinely ours to
   * spend, and overruled where they are not. The reason is said out loud
   * rather than silently applied.
   */
  if (configured !== null && (pooled || serverless) && configured > 1) {
    console.warn(
      `[database] DATABASE_POOL_MAX is ${configured}; using 1 instead. Behind a pooler each instance should hold ` +
        'one connection and let the pooler do the pooling — many instances reaching for many each is what empties it.',
    );
    return 1;
  }

  if (configured !== null) return configured;
  return pooled || serverless ? 1 : 10;
}

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
  }

  const adapter = new PrismaPg({
    ...resolveConnection(connectionString),
    max: defaultPoolSize(connectionString),
    // Hand a connection back rather than sitting on it between requests: a
    // slot held idle is a slot the next person cannot have.
    idleTimeoutMillis: Number(process.env.DATABASE_POOL_IDLE_MS ?? 10_000),
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
export { defaultPoolSize };

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
const DEFAULT_TRANSACTION_TIMEOUT_MS = Number(process.env.DATABASE_TRANSACTION_TIMEOUT_MS ?? 60_000);

/**
 * How long to wait for a free connection before giving up.
 *
 * Under a connection pooler a burst of requests can leave a transaction
 * queueing for a slot, and failing immediately tells the user their cost was
 * not saved when nothing was ever wrong with it.
 *
 * Kept short on purpose. This is waited three times over, and a person
 * watching a spinner would rather be told in eight seconds that the save did
 * not happen than sit for a minute and be told the same thing — which is
 * what a twenty-second wait, tried three times, did to the client.
 */
const DEFAULT_TRANSACTION_MAX_WAIT_MS = Number(process.env.DATABASE_TRANSACTION_MAX_WAIT_MS ?? 6_000);

/**
 * Runs `fn` inside a database transaction. Serializable-adjacent defaults are
 * intentional: financial posting must not observe torn reads of stock or
 * balances. We use the ORM default (read committed) plus explicit row locks in
 * the services, which is the standard approach for high-write ERP posting.
 */
/**
 * A failure that happened before the work began, and is therefore safe to try again.
 *
 * The distinction is the whole point. A transaction that could not get a
 * connection never ran a statement: nothing was written, nothing was half
 * written, and trying again cannot post anything twice. A transaction that
 * ran and then failed is a different animal and is never retried here —
 * whether its work landed is the one thing this cannot know, and guessing
 * would be how a cost gets posted twice.
 */
function neverStarted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    /unable to start a transaction/i.test(message) ||
    /max client connections reached/i.test(message) ||
    /too many connections/i.test(message) ||
    /connection terminated|connection closed|ECONNRESET|ETIMEDOUT|EPIPE/i.test(message) ||
    /server closed the connection/i.test(message)
  );
}

const RETRY_DELAYS_MS = [250, 750];

/**
 * Runs `fn` inside a database transaction. Serializable-adjacent defaults are
 * intentional: financial posting must not observe torn reads of stock or
 * balances. We use the ORM default (read committed) plus explicit row locks in
 * the services, which is the standard approach for high-write ERP posting.
 *
 * A connection that could not be had is waited out rather than handed to the
 * user as a failure: behind a pooler with few slots, a burst of traffic makes
 * this ordinary, and the client should not be told their expense was not
 * saved because somebody else was saving one at the same moment.
 */
export async function transaction<T>(
  fn: (tx: Tx) => Promise<T>,
  timeoutMs = DEFAULT_TRANSACTION_TIMEOUT_MS,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await prisma.$transaction(fn, { timeout: timeoutMs, maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS });
    } catch (error) {
      lastError = error;
      if (!neverStarted(error) || attempt === RETRY_DELAYS_MS.length) break;

      const wait = RETRY_DELAYS_MS[attempt];
      console.warn(
        `[transaction] no connection on attempt ${attempt + 1}; waiting ${wait}ms and trying again. ` +
          `Nothing was written: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  throw lastError;
}
