import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDatabase, getContext } from '../helpers';
import { getTablePrefs, setTablePrefs } from '@/lib/services/table-prefs';
import { normaliseTablePrefs, isTablePrefsKey } from '@/lib/table-prefs';

/** Customize Report (§24.1): a layout is kept per person, per table, on the server. */
let userA: string;
let userB: string;

beforeAll(async () => {
  await resetDatabase();
  const ctx = await getContext();
  userA = ctx.admin.id;
  userB = (await prisma.user.findFirstOrThrow({ where: { id: { not: userA } }, select: { id: true } })).id;
}, 120_000);

describe('table preferences', () => {
  it('keeps one person’s layout to themselves', async () => {
    await setTablePrefs(userA, 'stock-items', { hidden: ['collected'], order: ['available', 'item'], sort: { columnId: 'available', direction: 'desc' }, compact: true });
    expect(await getTablePrefs(userA, 'stock-items')).toEqual({
      hidden: ['collected'],
      order: ['available', 'item'],
      sort: { columnId: 'available', direction: 'desc' },
      compact: true,
    });
    expect(await getTablePrefs(userB, 'stock-items')).toBeNull();
    expect(await getTablePrefs(userA, 'another-table')).toBeNull();
  });

  it('puts the table back to its own layout on reset', async () => {
    await setTablePrefs(userA, 'stock-items', null);
    expect(await getTablePrefs(userA, 'stock-items')).toBeNull();
  });

  it('accepts only the expected shape', () => {
    expect(normaliseTablePrefs({ hidden: ['ok', 'bad id!', 3], sort: { columnId: 'x', direction: 'sideways' }, extra: 1 })).toEqual({
      hidden: ['ok'],
      order: undefined,
      sort: null,
      compact: null,
    });
    expect(isTablePrefsKey('fid.reports.cogs')).toBe(true);
    expect(isTablePrefsKey('../../etc')).toBe(false);
  });
});
