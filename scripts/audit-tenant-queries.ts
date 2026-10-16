/**
 * Static tenant-isolation audit.
 *
 * Every Prisma query on a company-scoped model must be scoped to a company —
 * or be a lookup of a record by its own id *after* the record was proven to
 * belong to the company. This walks the source, finds each
 * `prisma.<model>.<operation>(...)` / `tx.<model>.<operation>(...)` call on a
 * model that carries `companyId`, and reports the ones whose arguments never
 * mention a company.
 *
 * It is a heuristic, not a proof — it reads text — so it errs towards
 * reporting. `tests/integration/tenant-isolation.test.ts` pins the reviewed
 * list: a NEW unscoped query fails the build until someone has looked at it.
 *
 *   npx tsx scripts/audit-tenant-queries.ts          # print findings
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const READ_WRITE_OPS = ['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany'];
const BY_ID_OPS = ['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert'];

export function companyScopedModels(): Set<string> {
  const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
  const models = new Set<string>();
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    if (/^\s+companyId\s/m.test(m[2])) models.add(m[1].charAt(0).toLowerCase() + m[1].slice(1));
  }
  return models;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Text of the balanced parenthesis group starting at `open`. */
function argsAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

export type Finding = { file: string; line: number; model: string; op: string; kind: 'unscoped' | 'by-id'; snippet: string };

export function audit(): Finding[] {
  const models = companyScopedModels();
  const findings: Finding[] = [];
  const pattern = /\b(?:prisma|tx|db|client)\.(\w+)\.(\w+)\s*(?:<[^>]*>)?\(/g;
  for (const file of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts')).filter(() => false)]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(pattern)) {
      const [whole, model, op] = m;
      if (!models.has(model)) continue;
      const isScan = READ_WRITE_OPS.includes(op);
      const isById = BY_ID_OPS.includes(op);
      if (!isScan && !isById) continue;
      const args = argsAt(text, (m.index ?? 0) + whole.length - 1);
      const SCOPED = /companyId|company\.id|companyScope|\bscope\b|ownShipment|forCompany/;
      if (SCOPED.test(args)) continue;
      // `{ where }` or `{ where: filter }`: read the object the variable was built from.
      const variable = args.match(/\bwhere(?::\s*(\w+))?\s*[,}]/);
      if (variable) {
        const name = variable[1] ?? 'where';
        const before = text.slice(Math.max(0, (m.index ?? 0) - 4000), m.index);
        const decl = before.lastIndexOf(`const ${name} =`);
        if (decl >= 0 && SCOPED.test(before.slice(decl, decl + 1500))) continue;
      }
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({
        file: relative(ROOT, file),
        line,
        model,
        op,
        kind: isById ? 'by-id' : 'unscoped',
        snippet: args.replace(/\s+/g, ' ').slice(0, 140),
      });
    }
  }
  return findings;
}

if (require.main === module) {
  const findings = audit();
  const unscoped = findings.filter((f) => f.kind === 'unscoped');
  console.log(`unscoped scans: ${unscoped.length}   by-id lookups/updates: ${findings.length - unscoped.length}`);
  for (const f of unscoped) console.log(`${f.file}:${f.line}  ${f.model}.${f.op}  ${f.snippet}`);
}
