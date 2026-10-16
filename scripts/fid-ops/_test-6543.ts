import 'dotenv/config';
import pg from 'pg';

/**
 * Does the same database answer on the transaction pooler?
 *
 * Read-only. Nothing is written and no credential is printed: this only
 * proves the port the serverless runtime should be using actually works
 * before anything in production is pointed at it.
 */
async function main() {
  const current = new URL(process.env.DATABASE_URL!);
  const candidate = new URL(process.env.DATABASE_URL!);
  candidate.port = '6543';

  for (const [label, url] of [['session mode (5432, in use now)', current], ['transaction mode (6543)', candidate]] as const) {
    // The app's own SSL handling, so this proves the same path it uses.
    const plain = new URL(url.toString());
    plain.searchParams.delete('sslmode');
    const client = new pg.Client({ connectionString: plain.toString(), ssl: { rejectUnauthorized: false } });
    const started = Date.now();
    try {
      await client.connect();
      const one = await client.query('SELECT current_database() AS db, inet_server_port() AS port');
      const shipments = await client.query('SELECT COUNT(*)::int AS n FROM shipments');
      console.log(
        `  ${label}: connected in ${Date.now() - started}ms · db=${one.rows[0].db} · shipments=${shipments.rows[0].n}`,
      );
    } catch (error) {
      console.log(`  ${label}: FAILED — ${(error as Error).message}`);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
main();
