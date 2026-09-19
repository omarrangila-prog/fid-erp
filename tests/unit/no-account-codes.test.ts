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
  {
    // CUS-0001, SUP-0002, AG-RID, ITM-0007 — issued by the system, meaningless
    // to the person reading the screen.
    pattern: /\{(?:\w+\.)*(?:customerCode|vendorCode|agentCode|itemCode)\}/,
    why: 'renders a master-data code',
  },
  {
    pattern: /\$\{(?:\w+\.)*(?:customerCode|vendorCode|agentCode|itemCode)\}/,
    why: 'puts a master-data code into a label',
  },
  {
    pattern: /label: '(?:Customer|Supplier|Agent|Account) code'/,
    why: 'asks the user to type a code the system issues',
  },
  {
    // FID-MA-JOB-000001 and FID-MA-EV-000007: the job already has the
    // client's own ICUL/FID reference, and a cost is known by what it was for.
    pattern: /\{(?:\w+\.)*(?:jobNumber|expenseNumber)\}/,
    why: 'renders a job or expense number',
  },
  {
    pattern: /\$\{(?:\w+\.)*(?:jobNumber|expenseNumber)\}/,
    why: 'puts a job or expense number into a label',
  },
  {
    // FID-MA-PO-000001: the order already carries the client's own
    // ICUL/FID reference, which is what they quote and search by.
    pattern: /\{(?:\w+\.)*contractNumber\}/,
    why: 'renders a contract number',
  },
  {
    pattern: /\$\{(?:\w+\.)*contractNumber\}/,
    why: 'puts a contract number into a label',
  },
  {
    // FID-MA-SI-000008 and the rest of the system's own numbering. A
    // document is named by what it is, who it was with and when.
    // shortDocumentNumber(r.invoiceNumber) is fine — that is "INV 8". A bare
    // {r.invoiceNumber} is FID-MA-SI-000008, which is not.
    pattern: /\{(?:\w+\.)*(?:invoiceNumber|receiptNumber|paymentNumber|creditNoteNumber|grnNumber|shipmentNumber|transferNumber|countNumber|settlementNumber)\}/,
    why: 'renders a document number the system issued',
  },
  {
    pattern: /\$\{(?:\w+\.)*(?:invoiceNumber|receiptNumber|paymentNumber|creditNoteNumber|grnNumber|shipmentNumber|transferNumber|countNumber|settlementNumber)\}/,
    why: 'puts a system document number into a label',
  },
];

/** Codes that are not ours: a port, a warehouse, a VAT band, a company. */
const ALLOWED_FILES = [
  // A tax invoice must carry a sequential number by law in both Morocco and
  // the UAE, so the printed customer copy keeps one.
  'sales/[id]/print',
  'ledgers/customers/[id]/print',
  'ledgers/vendors/[id]/print',
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

describe('no system-issued code reaches the screen', () => {
  const files = ROOTS.flatMap(walk).filter(
    (f) => !ALLOWED_FILES.some((allowed) => f.includes(allowed)),
  );

  it('finds source to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('renders names, never the codes the system issues for itself', () => {
    const offences: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        // A key or a search term is not something anybody reads. A search
        // template often spans several lines, so look back a little for
        // those; a key only exempts its own line, or the row's key would
        // excuse the three cells under it.
        const context = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
        if (/keywords|searchText|searchValue/.test(context)) return;
        if (/\bkey=/.test(line)) return;
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
