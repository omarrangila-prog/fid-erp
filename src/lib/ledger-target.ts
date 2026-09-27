/**
 * The other side of a ledger-to-ledger settlement, as one picker value.
 *
 * A ledger account is chosen by its id; an agent's account — the money he
 * holds for the company, kept on Agent Clearing under his name — by
 * "agent:<id>", the same convention the journal voucher uses. Pure, so client
 * forms can use it without pulling in the database.
 */
export const AGENT_PREFIX = 'agent:';

export function ledgerTargetValue(ledgerAccountId?: string | null, ledgerAgentId?: string | null): string | null {
  if (ledgerAgentId) return `${AGENT_PREFIX}${ledgerAgentId}`;
  return ledgerAccountId ?? null;
}

export function ledgerTargetPayload(value: string | null | undefined): { ledgerAccountId: string; ledgerAgentId: string } {
  if (!value) return { ledgerAccountId: '', ledgerAgentId: '' };
  if (value.startsWith(AGENT_PREFIX)) return { ledgerAccountId: '', ledgerAgentId: value.slice(AGENT_PREFIX.length) };
  return { ledgerAccountId: value, ledgerAgentId: '' };
}

/** Where a document's money went: its drawer, or the other ledger it was settled through. */
export function settledThrough(
  doc: {
    cashBankAccount?: { name: string } | null;
    ledgerAccount?: { name: string } | null;
    ledgerAgent?: { agentName: string } | null;
  },
  fallback: string,
): string {
  if (doc.cashBankAccount) return doc.cashBankAccount.name;
  if (doc.ledgerAgent) return `Ledger to ledger · ${doc.ledgerAgent.agentName} — agent account`;
  if (doc.ledgerAccount) return `Ledger to ledger · ${doc.ledgerAccount.name}`;
  return fallback;
}
