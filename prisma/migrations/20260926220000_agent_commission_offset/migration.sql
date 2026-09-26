-- An agent's commission settled against the customer money he holds.
--
-- A ledger settlement between two balances with the same person: nothing is
-- paid in or out, so there is no cash or bank account to name. Every existing
-- settlement keeps its account; only this new kind may leave it empty.
ALTER TYPE "AgentSettlementDirection" ADD VALUE IF NOT EXISTS 'COMMISSION_OFFSET';

ALTER TABLE "agent_settlements" ALTER COLUMN "cashBankAccountId" DROP NOT NULL;
