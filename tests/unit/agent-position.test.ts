import { describe, expect, it } from 'vitest';
import { netAgentRows, type AgentNetting } from '@/lib/services/agent-position';
import { dec } from '@/lib/money';

const row = (accountId: string, debit: number, credit: number) => ({
  accountId,
  debitLocal: dec(debit),
  creditLocal: dec(credit),
  debitUsd: dec(debit / 10),
  creditUsd: dec(credit / 10),
});

describe('an agent on one line', () => {
  const netting: AgentNetting = {
    clearingAccountId: 'clearing',
    agents: [{ agentId: 'radouan', agentName: 'Radouan', clearingLocal: dec(238090.8), clearingUsd: dec(23809.08), accountIds: ['loan'] }],
  };

  it('nets what he holds against what is owed to him, and the trial balance still balances', () => {
    const rows = [row('cash', 1000000, 0), row('clearing', 238090.8, 0), row('loan', 0, 427958.5), row('sales', 0, 810132.3)];
    const out = netAgentRows(rows, netting, (a, b) => ({ accountId: `agent-${a.agentId}`, ...b }));
    expect(out.map((r) => r.accountId)).toEqual(['cash', 'sales', 'agent-radouan']);
    const agent = out.find((r) => r.accountId === 'agent-radouan')!;
    expect(agent.creditLocal.toFixed(2)).toBe('189867.70');
    expect(agent.debitLocal.isZero()).toBe(true);
    const dr = out.reduce((t, r) => t.plus(r.debitLocal), dec(0));
    const cr = out.reduce((t, r) => t.plus(r.creditLocal), dec(0));
    expect(dr.toFixed(2)).toBe(cr.toFixed(2));
  });

  it('keeps what other agents hold on the collections line', () => {
    const rows = [row('clearing', 300000, 0), row('loan', 0, 427958.5)];
    const out = netAgentRows(rows, netting, (a, b) => ({ accountId: `agent-${a.agentId}`, ...b }));
    expect(out.find((r) => r.accountId === 'clearing')!.debitLocal.toFixed(2)).toBe('61909.20');
  });
});
