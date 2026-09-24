import { afterEach, describe, expect, it } from 'vitest';
import { defaultPoolSize } from '@/lib/db';

/**
 * The sign-in page returned 500 for everybody because the connection pooler
 * had no slots left. Supabase's session pooler allows fifteen clients in
 * total; each instance of this process was taking up to ten, so two instances
 * could hold every slot between them.
 */

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const POOLED = 'postgresql://u:p@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require';
const DIRECT = 'postgresql://u:p@db.eykcjbrtaphontzacihn.supabase.co:5432/postgres';
const LOCAL = 'postgresql://fid_app:p@127.0.0.1:5432/fid_trading';

describe('how many connections one instance may hold', () => {
  it('takes one slot behind a pooler, which is what does the pooling', () => {
    delete process.env.DATABASE_POOL_MAX;
    delete process.env.VERCEL;
    expect(defaultPoolSize(POOLED)).toBe(1);
  });

  it('takes one slot on a serverless host, however it connects', () => {
    delete process.env.DATABASE_POOL_MAX;
    process.env.VERCEL = '1';
    expect(defaultPoolSize(DIRECT)).toBe(1);
  });

  it('keeps a real pool against a database of our own', () => {
    delete process.env.DATABASE_POOL_MAX;
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    expect(defaultPoolSize(LOCAL)).toBe(10);
    expect(defaultPoolSize(DIRECT)).toBe(10);
  });

  it('recognises pgbouncer named in the query string', () => {
    delete process.env.DATABASE_POOL_MAX;
    delete process.env.VERCEL;
    expect(defaultPoolSize(`${DIRECT}?pgbouncer=true`)).toBe(1);
  });

  it('lets the number be set where the connections are ours to spend', () => {
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.DATABASE_POOL_MAX = '4';
    expect(defaultPoolSize(LOCAL)).toBe(4);
    process.env.DATABASE_POOL_MAX = '0';
    expect(defaultPoolSize(LOCAL)).toBe(1);
  });

  /*
   * A setting made when the database was addressed directly, left in place
   * after moving behind a pooler, had every instance reaching for ten
   * connections at once — and a pooler is emptied by a handful of instances
   * doing that. The symptom is a transaction that cannot start, which is
   * what the client was looking at while trying to save a cost.
   */
  it('overrules the setting behind a pooler, where they are not', () => {
    delete process.env.VERCEL;
    process.env.DATABASE_POOL_MAX = '10';
    expect(defaultPoolSize(POOLED)).toBe(1);
  });

  it('overrules it on a serverless host too, however it connects', () => {
    process.env.VERCEL = '1';
    process.env.DATABASE_POOL_MAX = '10';
    expect(defaultPoolSize(DIRECT)).toBe(1);
  });

  it('assumes the safe number when the URL cannot be read', () => {
    delete process.env.DATABASE_POOL_MAX;
    expect(defaultPoolSize('not a url')).toBe(1);
  });
});
