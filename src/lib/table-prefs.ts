/**
 * One person's layout for one table: which columns are hidden, their order,
 * the sort and the row density. Pure — shared by the server, which stores it
 * per user, and the table, which applies it.
 */
export type TablePrefs = {
  hidden?: string[];
  order?: string[] | null;
  sort?: { columnId: string; direction: 'asc' | 'desc' } | null;
  compact?: boolean | null;
};

const ID = /^[A-Za-z0-9._:-]{1,80}$/;

export function isTablePrefsKey(key: unknown): key is string {
  return typeof key === 'string' && ID.test(key);
}

/** Only the shape above survives: unknown fields, bad ids and oversized lists are dropped. */
export function normaliseTablePrefs(input: unknown): TablePrefs {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 100) : undefined);
  const sort = raw.sort as Record<string, unknown> | null | undefined;
  return {
    hidden: ids(raw.hidden),
    order: raw.order === null ? null : ids(raw.order),
    sort:
      sort && typeof sort === 'object' && typeof sort.columnId === 'string' && ID.test(sort.columnId) && (sort.direction === 'asc' || sort.direction === 'desc')
        ? { columnId: sort.columnId, direction: sort.direction }
        : null,
    compact: typeof raw.compact === 'boolean' ? raw.compact : null,
  };
}
