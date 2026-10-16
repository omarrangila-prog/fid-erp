import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audit, findingKey } from '../../scripts/audit-tenant-queries';

/**
 * No new Prisma query on company data may be written without a company.
 *
 * `scripts/audit-tenant-queries.ts` lists every query on a company-scoped model
 * whose arguments never mention a company. The ones in the fixture were read by
 * a person and are safe (they follow an id the caller has already proven
 * belongs to the company, or they are the PIN throttle, which is global by
 * design). Anything else fails here until it is scoped or reviewed.
 */
describe('tenant isolation: every query on company data is scoped', () => {
  const reviewed = new Set<string>(JSON.parse(readFileSync(join(__dirname, '../fixtures/tenant-query-review.json'), 'utf8')));

  it('has no unreviewed unscoped query', () => {
    const fresh = audit()
      .filter((f) => f.kind === 'unscoped')
      .filter((f) => !reviewed.has(findingKey(f)))
      .map((f) => `${f.file}:${f.line}  ${f.model}.${f.op}  ${f.snippet}`);
    expect(
      fresh,
      `Scope these by companyId (or by a parent already checked to be the company's), then run\n` +
        `  npx tsx scripts/audit-tenant-queries.ts --write\nonly if a person has reviewed them:\n${fresh.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the reviewed list honest: nothing in it has been fixed or removed without being dropped', () => {
    const current = new Set(audit().filter((f) => f.kind === 'unscoped').map(findingKey));
    const stale = [...reviewed].filter((key) => !current.has(key));
    expect(stale, `These reviewed entries no longer exist; re-run the script with --write:\n${stale.join('\n')}`).toEqual([]);
  });
});
