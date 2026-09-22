import 'dotenv/config';
import fs from 'node:fs';
import { prisma } from '@/lib/db';

/**
 * One spelling for one business counterparty, wherever it is written.
 *
 * The same person has been recorded as "RADOUAN MOHAMMED" and as "Ridwan
 * Mohammad". The client's spelling is the one below, and it belongs on the
 * agent, on his warehouse, on the loan accounts opened in his name, and
 * inside the words of the entries that mention him.
 *
 * Names only. No amount, account, date, quantity or link is touched: the
 * agent and the warehouse stay two separate records with the ids and
 * relationships they had, and the agent's ledger is counted before and after
 * to prove nothing moved. Everything replaced is written to a backup first
 * and recorded in the audit trail.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/rename-agent-name.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/rename-agent-name.ts --apply   # write
 */

/** The client's spelling. Change this one line to change it everywhere. */
const CANONICAL = 'RADOUAN MOHAMMED';
const WAREHOUSE_NAME = `${CANONICAL} Warehouse`;
const WAREHOUSE_CODE = 'MA-RADOUAN';

/** Every spelling of this person seen on the books, as a whole name. */
const VARIANT = /\b(radouan|ridwan|rizwan|redouan|ridouan)\s+moh?amm?[ae]d\b/gi;
/** And the shorter forms used on the warehouse. */
const SHORT = /\b(radouan|ridwan|rizwan|redouan|ridouan)\b/gi;
/**
 * The surname on its own — "CASH RECVD BY MOHAMMED" — which the client
 * confirmed is the same person. Never touched where the full name is already
 * there, so a corrected sentence is not corrected again.
 */
const SURNAME = /(?<!radouan\s)\bmoh?amm?[ae]d\b/gi;

const apply = process.argv.includes('--apply');
const swap = (text: string | null | undefined) =>
  text ? text.replace(VARIANT, CANONICAL).replace(SURNAME, CANONICAL) : text;

async function agentLedgerTotals(companyId: string, agentIds: string[]) {
  const rows = await prisma.$queryRaw<Array<{ local: string; usd: string; lines: bigint }>>`
    SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local,
           COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd,
           COUNT(*) AS lines
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."companyId" = ${companyId} AND jl."agentId" = ANY(${agentIds}::text[])`;
  return { local: rows[0].local, usd: rows[0].usd, lines: Number(rows[0].lines) };
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ where: { code: 'FID-MA' }, select: { id: true, name: true } });
  const id = company.id;

  const [agents, warehouses, accounts, lines, entries, receipts, payments, expenses, settlements] = await Promise.all([
    prisma.agent.findMany({ where: { companyId: id }, select: { id: true, agentCode: true, agentName: true } }),
    prisma.warehouse.findMany({ where: { companyId: id }, select: { id: true, code: true, name: true } }),
    prisma.account.findMany({ where: { companyId: id }, select: { id: true, code: true, name: true } }),
    prisma.journalLine.findMany({ where: { journalEntry: { companyId: id } }, select: { id: true, description: true } }),
    prisma.journalEntry.findMany({ where: { companyId: id }, select: { id: true, entryNumber: true, description: true } }),
    prisma.receipt.findMany({ where: { companyId: id }, select: { id: true, receiptNumber: true, description: true, reference: true } }),
    prisma.payment.findMany({ where: { companyId: id }, select: { id: true, paymentNumber: true, description: true, reference: true } }),
    prisma.expense.findMany({ where: { companyId: id }, select: { id: true, expenseNumber: true, description: true, reference: true } }),
    prisma.agentSettlement.findMany({ where: { companyId: id }, select: { id: true, settlementNumber: true, notes: true } }),
  ]);

  const changed = <T extends { id: string }>(rows: T[], read: (row: T) => string | null) =>
    rows.filter((row) => swap(read(row)) !== read(row));

  const agentTargets = agents.filter((a) => VARIANT.test(a.agentName) && a.agentName !== CANONICAL);
  VARIANT.lastIndex = 0;
  const warehouseTargets = warehouses.filter(
    (w) => SHORT.test(`${w.name} ${w.code}`) && (w.name !== WAREHOUSE_NAME || w.code !== WAREHOUSE_CODE),
  );
  SHORT.lastIndex = 0;
  const accountTargets = changed(accounts, (a) => a.name);
  const lineTargets = changed(lines, (l) => l.description);
  const entryTargets = changed(entries, (e) => e.description);
  // Both the note and the reference carry these words.
  const touched = <T extends { description: string | null; reference: string | null }>(rows: T[]) =>
    rows.filter((row) => swap(row.description) !== row.description || swap(row.reference) !== row.reference);
  const receiptTargets = touched(receipts);
  const paymentTargets = touched(payments);
  const expenseTargets = touched(expenses);
  const settlementTargets = changed(settlements, (s) => s.notes);

  console.log(company.name, '→', CANONICAL);
  for (const a of agentTargets) console.log(`  agent      ${a.agentCode}  ${a.agentName}  →  ${CANONICAL}`);
  for (const w of warehouseTargets) console.log(`  warehouse  ${w.code} ${w.name}  →  ${WAREHOUSE_CODE} ${WAREHOUSE_NAME}`);
  for (const a of accountTargets) console.log(`  account    ${a.code}  ${a.name}  →  ${swap(a.name)}`);
  for (const l of lineTargets) console.log(`  line       ${l.description}  →  ${swap(l.description)}`);
  for (const e of entryTargets) console.log(`  entry      ${e.entryNumber}  ${e.description}  →  ${swap(e.description)}`);
  for (const r of receiptTargets) console.log(`  receipt    ${r.receiptNumber}  ${r.description ?? r.reference}  →  ${swap(r.description ?? r.reference)}`);
  for (const p of paymentTargets) console.log(`  payment    ${p.paymentNumber}  ${p.description ?? p.reference}  →  ${swap(p.description ?? p.reference)}`);
  for (const e of expenseTargets) console.log(`  expense    ${e.expenseNumber}  ${e.description ?? e.reference}  →  ${swap(e.description ?? e.reference)}`);
  for (const s of settlementTargets) console.log(`  settlement ${s.settlementNumber}  ${s.notes}  →  ${swap(s.notes)}`);

  const total =
    agentTargets.length + warehouseTargets.length + accountTargets.length + lineTargets.length +
    entryTargets.length + receiptTargets.length + paymentTargets.length + expenseTargets.length + settlementTargets.length;
  if (total === 0) {
    console.log(`  nothing to change — everything already reads ${CANONICAL}`);
    return;
  }

  const ledgerBefore = await agentLedgerTotals(id, agents.map((a) => a.id));
  console.log('  agent ledger before:', JSON.stringify(ledgerBefore));

  if (!apply) {
    console.log(`dry run — ${total} name(s) to correct. Pass --apply to write.`);
    return;
  }

  const file = `backups/rename-agent-name-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(
    file,
    JSON.stringify(
      { at: new Date().toISOString(), canonical: CANONICAL, agents: agentTargets, warehouses: warehouseTargets, accounts: accountTargets, lines: lineTargets, entries: entryTargets, receipts: receiptTargets, payments: paymentTargets, expenses: expenseTargets, settlements: settlementTargets },
      null,
      2,
    ),
  );
  console.log('  backup written:', file);

  for (const a of agentTargets) await prisma.agent.update({ where: { id: a.id }, data: { agentName: CANONICAL } });
  for (const w of warehouseTargets) await prisma.warehouse.update({ where: { id: w.id }, data: { name: WAREHOUSE_NAME, code: WAREHOUSE_CODE } });
  for (const a of accountTargets) await prisma.account.update({ where: { id: a.id }, data: { name: swap(a.name)! } });
  for (const l of lineTargets) await prisma.journalLine.update({ where: { id: l.id }, data: { description: swap(l.description) } });
  for (const e of entryTargets) await prisma.journalEntry.update({ where: { id: e.id }, data: { description: swap(e.description)! } });
  for (const r of receiptTargets) await prisma.receipt.update({ where: { id: r.id }, data: { description: swap(r.description), reference: swap(r.reference) } });
  for (const p of paymentTargets) await prisma.payment.update({ where: { id: p.id }, data: { description: swap(p.description), reference: swap(p.reference) } });
  for (const e of expenseTargets) await prisma.expense.update({ where: { id: e.id }, data: { description: swap(e.description), reference: swap(e.reference) } });
  for (const s of settlementTargets) await prisma.agentSettlement.update({ where: { id: s.id }, data: { notes: swap(s.notes) } });

  await prisma.auditLog.create({
    data: {
      companyId: id,
      action: 'AGENT_NAME_STANDARDISED',
      entityType: 'Agent',
      entityId: agents[0]?.id ?? CANONICAL,
      before: { counts: { agents: agentTargets.length, warehouses: warehouseTargets.length, accounts: accountTargets.length, lines: lineTargets.length, entries: entryTargets.length, receipts: receiptTargets.length, payments: paymentTargets.length, expenses: expenseTargets.length, settlements: settlementTargets.length } },
      after: { spelling: CANONICAL, note: 'Names only; no amount, account, date or link changed' },
    },
  });

  const ledgerAfter = await agentLedgerTotals(id, agents.map((a) => a.id));
  console.log('  agent ledger after: ', JSON.stringify(ledgerAfter));
  console.log(
    ledgerBefore.local === ledgerAfter.local && ledgerBefore.usd === ledgerAfter.usd && ledgerBefore.lines === ledgerAfter.lines
      ? `corrected ${total} name(s); every figure unchanged`
      : 'FIGURES MOVED — investigate',
  );
}

main().finally(() => prisma.$disconnect());
