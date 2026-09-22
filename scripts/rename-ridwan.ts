import 'dotenv/config';
import fs from 'node:fs';
import { prisma } from '@/lib/db';

/**
 * One spelling for one business counterparty: Ridwan Mohammad.
 *
 * The agent was recorded as "RADOUAN MOHAMMED" and his warehouse as "Ridwan
 * Warehouse". They are the same person, and the client spells the name
 * "Ridwan Mohammad". Two records stay two records — an agent is a financial
 * counterparty, a warehouse is a place, and nothing about their ids or
 * relationships changes — but both now carry the name the client uses, so
 * searching "Ridwan" finds them.
 *
 * Only the display names change. No posting, quantity, balance or link is
 * touched, and the previous names are written to a backup first.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/rename-ridwan.ts           # dry run
 *   npx tsx --tsconfig tsconfig.json scripts/rename-ridwan.ts --apply   # write
 */

const AGENT_NAME = 'Ridwan Mohammad';
const WAREHOUSE_NAME = 'Ridwan Mohammad Warehouse';
/** Spellings of the same person seen on the books. */
const VARIANTS = /^(radouan|ridwan|redouan|ridouan)\s+moh?amm?[ae]d$/i;

const apply = process.argv.includes('--apply');

async function main() {
  const company = await prisma.company.findFirstOrThrow({ where: { code: 'FID-MA' }, select: { id: true, name: true } });

  const agents = await prisma.agent.findMany({
    where: { companyId: company.id },
    select: { id: true, agentCode: true, agentName: true },
  });
  const warehouses = await prisma.warehouse.findMany({
    where: { companyId: company.id },
    select: { id: true, code: true, name: true },
  });

  const agentTargets = agents.filter((a) => VARIANTS.test(a.agentName.trim()) && a.agentName.trim() !== AGENT_NAME);
  const warehouseTargets = warehouses.filter(
    (w) => /radouan|ridwan|redouan|ridouan/i.test(`${w.name} ${w.code}`) && w.name !== WAREHOUSE_NAME,
  );

  console.log(`${company.name}`);
  for (const a of agentTargets) console.log(`  agent      ${a.agentCode}  ${a.agentName}  →  ${AGENT_NAME}`);
  for (const w of warehouseTargets) console.log(`  warehouse  ${w.code}  ${w.name}  →  ${WAREHOUSE_NAME}`);
  if (agentTargets.length === 0 && warehouseTargets.length === 0) {
    console.log('  nothing to rename — both already read Ridwan Mohammad');
    return;
  }

  // What the ledgers hold for this agent, before and after: renaming a name
  // must not move a single figure.
  const before = await prisma.$queryRaw<Array<{ local: string; usd: string; lines: bigint }>>`
    SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local,
           COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd,
           COUNT(*) AS lines
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."companyId" = ${company.id} AND jl."agentId" = ANY(${agentTargets.map((a) => a.id)}::text[])`;
  console.log('  agent ledger before:', JSON.stringify({ ...before[0], lines: Number(before[0].lines) }));

  if (!apply) {
    console.log('dry run — pass --apply to write');
    return;
  }

  const file = `backups/rename-ridwan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), agents, warehouses }, null, 2));
  console.log('backup written:', file);

  for (const agent of agentTargets) {
    await prisma.agent.update({ where: { id: agent.id }, data: { agentName: AGENT_NAME } });
    await prisma.auditLog.create({
      data: {
        companyId: company.id,
        action: 'AGENT_RENAMED',
        entityType: 'Agent',
        entityId: agent.id,
        before: { agentName: agent.agentName },
        after: { agentName: AGENT_NAME, reason: "The client's spelling of the same person" },
      },
    });
  }
  for (const warehouse of warehouseTargets) {
    await prisma.warehouse.update({ where: { id: warehouse.id }, data: { name: WAREHOUSE_NAME } });
    await prisma.auditLog.create({
      data: {
        companyId: company.id,
        action: 'WAREHOUSE_RENAMED',
        entityType: 'Warehouse',
        entityId: warehouse.id,
        before: { name: warehouse.name },
        after: { name: WAREHOUSE_NAME, reason: "The client's spelling of the same person" },
      },
    });
  }

  const after = await prisma.$queryRaw<Array<{ local: string; usd: string; lines: bigint }>>`
    SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS local,
           COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS usd,
           COUNT(*) AS lines
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."companyId" = ${company.id} AND jl."agentId" = ANY(${agentTargets.map((a) => a.id)}::text[])`;
  console.log('  agent ledger after: ', JSON.stringify({ ...after[0], lines: Number(after[0].lines) }));
  console.log(
    before[0].local === after[0].local && before[0].usd === after[0].usd && before[0].lines === after[0].lines
      ? 'renamed; every figure unchanged'
      : 'FIGURES MOVED — investigate',
  );
}

main().finally(() => prisma.$disconnect());
