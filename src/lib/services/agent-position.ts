import { prisma } from '@/lib/db';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { dec, toMoney, type Decimal } from '@/lib/money';
import { LIVE_ENTRY_SQL } from '@/lib/services/journal-visibility';
import type { TrialBalanceRow } from '@/lib/services/reports';

/**
 * One agent, one line.
 *
 * An agent such as Radouan sits in two places in the ledger: what he holds
 * of customers' money (his share of "Customer Collections Held by Agents")
 * and the accounts kept in his name — the loans he gave the company. The
 * owner reads the statements with the two netted into one figure: what is
 * owed between the company and him. This is presentation only; the ledger
 * keeps both accounts, and the netted figure is their sum.
 */
export type AgentPosition = {
  agentId: string;
  agentName: string;
  /** His share of the collections account, debit minus credit. */
  clearingLocal: Decimal;
  clearingUsd: Decimal;
  /** The accounts kept in his name. */
  accountIds: string[];
};

export type AgentNetting = { clearingAccountId: string | null; agents: AgentPosition[] };

export async function getAgentNetting(companyId: string, asOf?: Date | null): Promise<AgentNetting> {
  const [clearing, agents] = await Promise.all([
    prisma.account.findFirst({ where: { companyId, systemKey: ACCOUNT_KEYS.AGENT_CLEARING }, select: { id: true } }),
    prisma.agent.findMany({ where: { companyId }, select: { id: true, agentName: true, accounts: { where: { companyId }, select: { id: true } } } }),
  ]);
  const held = clearing
    ? await prisma.$queryRaw<Array<{ agentId: string; local: string; usd: string }>>`
        SELECT jl."agentId", SUM(jl."debitLocal" - jl."creditLocal")::text AS local, SUM(jl."debitUsd" - jl."creditUsd")::text AS usd
          FROM journal_lines jl
          JOIN journal_entries je ON je."id" = jl."journalEntryId" AND ${LIVE_ENTRY_SQL}
         WHERE je."companyId" = ${companyId} AND jl."accountId" = ${clearing.id} AND jl."agentId" IS NOT NULL
           AND (${asOf ?? null}::date IS NULL OR je."entryDate" <= ${asOf ?? null}::date)
         GROUP BY jl."agentId"`
    : [];
  const byAgent = new Map(held.map((h) => [h.agentId, h]));
  return {
    clearingAccountId: clearing?.id ?? null,
    agents: agents
      .map((a) => ({
        agentId: a.id,
        agentName: a.agentName,
        clearingLocal: toMoney(dec(byAgent.get(a.id)?.local ?? 0)),
        clearingUsd: toMoney(dec(byAgent.get(a.id)?.usd ?? 0)),
        accountIds: a.accounts.map((x) => x.id),
      }))
      // Only an agent with both sides is netted; one side alone is already one line.
      .filter((a) => a.accountIds.length > 0 && (!a.clearingLocal.isZero() || !a.clearingUsd.isZero())),
  };
}

type BalanceRow = { accountId: string; debitLocal: Decimal; creditLocal: Decimal; debitUsd: Decimal; creditUsd: Decimal };

/**
 * Trial balance rows with each netted agent's accounts and his share of the
 * collections account replaced by one row in his name. What is left on the
 * collections account (other agents, or lines with no agent) stays its own
 * row. Debits and credits still balance: each side drops by the same amount.
 */
export function netAgentRows<T extends BalanceRow>(
  rows: T[],
  netting: AgentNetting,
  make: (agent: AgentPosition, balance: { debitLocal: Decimal; creditLocal: Decimal; debitUsd: Decimal; creditUsd: Decimal }) => T,
): T[] {
  if (netting.agents.length === 0 || !netting.clearingAccountId) return rows;
  const split = (local: Decimal, usd: Decimal) => ({
    debitLocal: local.greaterThan(0) ? local : dec(0),
    creditLocal: local.lessThan(0) ? local.negated() : dec(0),
    debitUsd: usd.greaterThan(0) ? usd : dec(0),
    creditUsd: usd.lessThan(0) ? usd.negated() : dec(0),
  });
  const netOf = (r: BalanceRow) => ({ local: r.debitLocal.minus(r.creditLocal), usd: r.debitUsd.minus(r.creditUsd) });
  const taken = new Set(netting.agents.flatMap((a) => a.accountIds));
  const out: T[] = [];
  for (const row of rows) {
    if (taken.has(row.accountId)) continue;
    if (row.accountId === netting.clearingAccountId) {
      const rest = netOf(row);
      for (const a of netting.agents) {
        rest.local = rest.local.minus(a.clearingLocal);
        rest.usd = rest.usd.minus(a.clearingUsd);
      }
      // Zero in the books' currency is nothing left, whatever USD crumb remains.
      if (!rest.local.isZero()) out.push({ ...row, ...split(toMoney(rest.local), toMoney(rest.usd)) });
      continue;
    }
    out.push(row);
  }
  for (const a of netting.agents) {
    let local = a.clearingLocal;
    let usd = a.clearingUsd;
    for (const r of rows.filter((x) => a.accountIds.includes(x.accountId))) {
      const n = netOf(r);
      local = local.plus(n.local);
      usd = usd.plus(n.usd);
    }
    out.push(make(a, split(toMoney(local), toMoney(usd))));
  }
  return out;
}

/** The id an agent's netted line carries in place of an account id. */
export const AGENT_ROW_PREFIX = 'agent-';

/**
 * The trial balance as the owner reads it: each netted agent on one line.
 * Debit and credit totals are those of the lines shown — each falls by the
 * same amount, so the balance check is unchanged.
 */
export function agentNettedTrialBalance<
  R extends TrialBalanceRow,
  T extends { rows: R[]; totals: { debitLocal: Decimal; creditLocal: Decimal; debitUsd: Decimal; creditUsd: Decimal } },
>(report: T, netting: AgentNetting): T {
  const zero = dec(0);
  const rows = netAgentRows(report.rows, netting, (agent, balance) => {
    // Next to the accounts it replaces.
    const first = report.rows.find((r) => agent.accountIds.includes(r.accountId));
    return {
      ...(first ?? report.rows[0]),
      accountId: `${AGENT_ROW_PREFIX}${agent.agentId}`,
      name: agent.agentName,
      type: balance.creditLocal.greaterThan(0) ? 'LIABILITY' : 'ASSET',
      openingDebitUsd: zero, openingCreditUsd: zero, periodDebitUsd: zero, periodCreditUsd: zero,
      openingDebitLocal: zero, openingCreditLocal: zero, periodDebitLocal: zero, periodCreditLocal: zero,
      ...balance,
    } as R;
  }).sort((a, b) => a.code.localeCompare(b.code));
  const total = (pick: (r: R) => Decimal) => toMoney(rows.reduce((t, r) => t.plus(pick(r)), dec(0)));
  return {
    ...report,
    rows,
    totals: {
      ...report.totals,
      debitLocal: total((r) => r.debitLocal),
      creditLocal: total((r) => r.creditLocal),
      debitUsd: total((r) => r.debitUsd),
      creditUsd: total((r) => r.creditUsd),
    },
  };
}

type SheetLine = { accountId: string; code: string; name: string; displayName: string; amountLocal: Decimal; amountUsd: Decimal; group: string };
type SheetSection<L extends SheetLine> = { title: string; lines: L[]; totalLocal: Decimal; totalUsd: Decimal };

/**
 * The balance sheet with each netted agent on one line: under Accounts
 * Receivable when he owes the company, under Loans and other liabilities when
 * the company owes him. Assets and liabilities fall by the same amount, so
 * the balance check is unchanged.
 */
export function agentNettedBalanceSheet<
  L extends SheetLine,
  S extends { assets: SheetSection<L>; liabilities: SheetSection<L>; equity: SheetSection<L> },
>(sheet: S, netting: AgentNetting, groups: { owedToUs: string; weOwe: string }): S {
  if (netting.agents.length === 0 || !netting.clearingAccountId) return sheet;
  // Each line as debit minus credit, whatever side it is on.
  const signed = (side: 'assets' | 'liabilities' | 'equity', v: Decimal) => (side === 'assets' ? v : v.negated());
  const sides = ['assets', 'liabilities', 'equity'] as const;
  const kept: Record<(typeof sides)[number], L[]> = { assets: [], liabilities: [], equity: [] };
  const agentNet = new Map(netting.agents.map((a) => [a.agentId, { local: a.clearingLocal, usd: a.clearingUsd }]));
  let template: L | undefined;
  for (const side of sides) {
    for (const line of sheet[side].lines) {
      template ??= line;
      const owner = netting.agents.find((a) => a.accountIds.includes(line.accountId));
      if (owner) {
        const n = agentNet.get(owner.agentId)!;
        n.local = n.local.plus(signed(side, line.amountLocal));
        n.usd = n.usd.plus(signed(side, line.amountUsd));
        continue;
      }
      if (line.accountId === netting.clearingAccountId) {
        // What is left on the collections account once each netted agent's share is out.
        const rest = netting.agents.reduce(
          (r, a) => ({ local: r.local.minus(a.clearingLocal), usd: r.usd.minus(a.clearingUsd) }),
          { local: signed(side, line.amountLocal), usd: signed(side, line.amountUsd) },
        );
        if (!rest.local.isZero()) {
          kept[side].push({ ...line, amountLocal: toMoney(signed(side, rest.local)), amountUsd: toMoney(signed(side, rest.usd)) });
        }
        continue;
      }
      kept[side].push(line);
    }
  }
  for (const a of netting.agents) {
    const n = agentNet.get(a.agentId)!;
    if (n.local.isZero()) continue;
    const owesUs = n.local.greaterThan(0);
    const line = {
      ...(template as L),
      accountId: `${AGENT_ROW_PREFIX}${a.agentId}`,
      code: '',
      name: a.agentName,
      displayName: a.agentName,
      amountLocal: toMoney(owesUs ? n.local : n.local.negated()),
      amountUsd: toMoney(owesUs ? n.usd : n.usd.negated()),
      group: owesUs ? groups.owedToUs : groups.weOwe,
    } as L;
    kept[owesUs ? 'assets' : 'liabilities'].push(line);
  }
  const section = (s: SheetSection<L>, lines: L[]): SheetSection<L> => ({
    ...s,
    lines,
    totalLocal: toMoney(lines.reduce((t, l) => t.plus(l.amountLocal), dec(0))),
    totalUsd: toMoney(lines.reduce((t, l) => t.plus(l.amountUsd), dec(0))),
  });
  return {
    ...sheet,
    assets: section(sheet.assets, kept.assets),
    liabilities: section(sheet.liabilities, kept.liabilities),
    equity: section(sheet.equity, kept.equity),
  };
}
