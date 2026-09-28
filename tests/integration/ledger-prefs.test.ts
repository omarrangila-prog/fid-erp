import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext } from '../helpers';
import { normaliseLedgerPrefs, DEFAULT_LEDGER_COLUMNS, CORE_LEDGER_COLUMNS } from '@/lib/ledger-columns';
import { getLedgerPrefs, setLedgerPrefs } from '@/lib/services/ledger-prefs';

/**
 * How one person lays out one ledger: remembered, per person and per ledger,
 * and never able to lose the accounting view itself.
 */

let ctx: Awaited<ReturnType<typeof getContext>>;

beforeAll(async () => {
  await resetDatabase();
  ctx = await getContext();
}, 300_000);

describe('a ledger layout', () => {
  it('starts as Date, Reference, Memo, Debit, Credit, Balance', async () => {
    const prefs = await getLedgerPrefs(ctx.admin.id, 'customer');
    expect(prefs.columns).toEqual([...DEFAULT_LEDGER_COLUMNS]);
    expect(prefs.saved).toBe(false);
    expect(prefs.pageSize).toBe(50);
  });

  it('keeps the core columns whatever is sent, and drops what it does not know', () => {
    const prefs = normaliseLedgerPrefs({ columns: ['jv', 'balance', 'nonsense'], pageSize: 7, view: 'weird' });
    for (const core of CORE_LEDGER_COLUMNS) expect(prefs.columns).toContain(core);
    expect(prefs.columns).toContain('jv');
    expect(prefs.columns).not.toContain('nonsense');
    expect(prefs.pageSize).toBe(50);
    expect(prefs.view).toBe('table');
  });

  it('is remembered per person and per ledger, in the order chosen, and resets', async () => {
    await setLedgerPrefs(ctx.admin.id, 'agent', { columns: ['date', 'jv', 'memo', 'shipment', 'debit', 'credit', 'balance'], pageSize: 100, view: 'compact' });
    const agent = await getLedgerPrefs(ctx.admin.id, 'agent');
    expect(agent.columns).toEqual(['date', 'jv', 'memo', 'shipment', 'debit', 'credit', 'balance']);
    expect(agent.pageSize).toBe(100);
    expect(agent.view).toBe('compact');
    expect(agent.saved).toBe(true);
    // Another ledger, and another person, are untouched.
    expect((await getLedgerPrefs(ctx.admin.id, 'customer')).columns).toEqual([...DEFAULT_LEDGER_COLUMNS]);
    const other = await prisma.user.findFirstOrThrow({ where: { NOT: { id: ctx.admin.id } }, select: { id: true } }).catch(() => null);
    if (other) expect((await getLedgerPrefs(other.id, 'agent')).columns).toEqual([...DEFAULT_LEDGER_COLUMNS]);
    await setLedgerPrefs(ctx.admin.id, 'agent', null);
    expect((await getLedgerPrefs(ctx.admin.id, 'agent')).columns).toEqual([...DEFAULT_LEDGER_COLUMNS]);
  });
});
