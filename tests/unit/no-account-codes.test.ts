import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Accounting codes stay in the database and out of sight.
 *
 * The client runs a coffee business. "1100 — Cash in Hand" asks them to carry
 * a number that means nothing to them and that the application already knows;
 * "Cash in Hand" is the whole of what they need. The codes still exist, are
 * still unique, and still order the chart — they are simply never shown.
 *
 * This reads the source rather than the screen, because a code creeps back
 * into a dropdown label one paste at a time, and a rendered-output test would
 * only catch the pages somebody remembered to write one for.
 */

const ROOTS = ['src/app', 'src/components'];

/** Ways an account's code reaches the screen, as they appear in source. */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\{(?:\w+\.)*account\.code\}/,
    why: 'renders an account code',
  },
  {
    pattern: /\$\{(?:\w+\.)*account\.code\}/,
    why: 'puts an account code into a label',
  },
  {
    pattern: /\{line\.code\}|\{row\.code\}(?![^\n]*key=)/,
    why: 'renders a statement line code',
  },
  {
    pattern: /\{line\.accountCode\}/,
    why: 'renders an account code on a journal row',
  },
  {
    pattern: /header: 'Code', value: \(r\) => r\.(?:accountCode|code)\b/,
    why: 'exports an account code column',
  },
];

/** Codes that are not ours: a port, a warehouse, a VAT band, a company. */
const ALLOWED_FILES = [
  'ports',
  'warehouses',
  'shipping-lines',
  'admin/roles',
  'settings/tax',
  'reports/tax-return',
  'select-company',
  'layout/topbar',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('no accounting code reaches the screen', () => {
  const files = ROOTS.flatMap(walk).filter(
    (f) => !ALLOWED_FILES.some((allowed) => f.includes(allowed)),
  );

  it('finds source to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('renders account names, never account codes', () => {
    const offences: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        // A key or a search term is not something anybody reads.
        if (/\bkey=|keywords|searchText|searchValue/.test(line)) return;
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(line)) {
            offences.push(`${file}:${index + 1} ${why}\n    ${line.trim()}`);
          }
        }
      });
    }

    expect(offences, offences.join('\n')).toEqual([]);
  });
});
