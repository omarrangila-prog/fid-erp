import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { prisma } from '@/lib/db';
import { reconcile } from '@/lib/services/reconciliation';
import {
  getBalanceSheet,
  getCustomerBalances,
  getProfitAndLoss,
  getTrialBalanceReport,
  getVendorBalances,
} from '@/lib/services/reports';
import { getReceivablesAgeing, getPayablesAgeing } from '@/lib/services/receivables';
import { getInventoryValuation, getItemStock } from '@/lib/services/stock';

/**
 * The FID golden master: a fingerprint of every company's books.
 *
 * Productizing must not move a single figure in FID's historical accounting.
 * This reads the headline reports for every company through the same services
 * the screens use, writes them out (one SHA-256 per report, plus the full
 * canonical text), and later compares a new run against the saved one.
 *
 *   # BEFORE changing anything, against a restored COPY of the live data:
 *   DATABASE_URL=<copy> npx tsx --tsconfig tsconfig.json scripts/golden-master.ts save golden.json
 *   # after every phase:
 *   DATABASE_URL=<copy> npx tsx --tsconfig tsconfig.json scripts/golden-master.ts compare golden.json
 *
 * It only reads. Point it at a copy, not the live database, so a long run can
 * never hold a connection the client needs.
 */

const AS_OF = new Date('2030-12-31T00:00:00.000Z');
const FROM = new Date('2000-01-01T00:00:00.000Z');

/** Stable text for any value: sorted keys, decimals and dates as strings. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('toFixed' in v && 'd' in v) return String(v); // decimal.js
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

type Snapshot = Record<string, Record<string, { hash: string; text?: string }>>;

async function snapshotCompany(companyId: string, keepText: boolean) {
  const sections: Record<string, () => Promise<unknown>> = {
    reconciliation: async () => {
      const r = await reconcile(companyId);
      return r.checks.map((c) => ({ label: c.label, passed: c.passed }));
    },
    trialBalance: () => getTrialBalanceReport({ companyId, to: AS_OF }),
    profitAndLoss: () => getProfitAndLoss({ companyId, from: FROM, to: AS_OF }),
    balanceSheet: () => getBalanceSheet({ companyId, asOf: AS_OF }),
    inventoryValuation: () => getInventoryValuation(companyId),
    itemStock: () => getItemStock(companyId),
    receivablesAgeing: () => getReceivablesAgeing(companyId),
    payablesAgeing: () => getPayablesAgeing(companyId),
    customerBalances: () => getCustomerBalances(companyId),
    vendorBalances: () => getVendorBalances(companyId),
  };
  const out: Record<string, { hash: string; text?: string }> = {};
  for (const [name, run] of Object.entries(sections)) {
    const text = canonical(await run());
    out[name] = { hash: sha(text), ...(keepText ? { text } : {}) };
  }
  return out;
}

async function capture(keepText: boolean): Promise<Snapshot> {
  const companies = await prisma.company.findMany({ select: { id: true, code: true }, orderBy: { code: 'asc' } });
  const snapshot: Snapshot = {};
  for (const c of companies) snapshot[c.code] = await snapshotCompany(c.id, keepText);
  return snapshot;
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if ((mode !== 'save' && mode !== 'compare') || !file) {
    console.error('usage: golden-master.ts save|compare <file.json>');
    process.exit(2);
  }

  if (mode === 'save') {
    const snapshot = await capture(true);
    writeFileSync(file, JSON.stringify(snapshot));
    for (const [code, sections] of Object.entries(snapshot)) {
      console.log(`${code}: ${Object.keys(sections).length} reports fingerprinted`);
    }
    return;
  }

  const saved = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
  const now = await capture(true);
  let differences = 0;
  for (const code of Object.keys(saved)) {
    if (!now[code]) {
      console.log(`✗ ${code}: company is missing now`);
      differences += 1;
      continue;
    }
    for (const [name, was] of Object.entries(saved[code])) {
      const is = now[code][name];
      if (is?.hash === was.hash) {
        console.log(`✓ ${code} · ${name}`);
      } else {
        differences += 1;
        console.log(`✗ ${code} · ${name} CHANGED`);
        if (was.text && is?.text) {
          let i = 0;
          while (i < was.text.length && was.text[i] === is.text[i]) i += 1;
          console.log(`    first difference at char ${i}:\n    was: …${was.text.slice(Math.max(0, i - 60), i + 80)}\n    now: …${is.text.slice(Math.max(0, i - 60), i + 80)}`);
        }
      }
    }
  }
  console.log(differences === 0 ? '\nGOLDEN MASTER: identical.' : `\nGOLDEN MASTER: ${differences} report(s) differ.`);
  process.exit(differences === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
