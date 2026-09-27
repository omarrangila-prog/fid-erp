-- Settling an unpaid cost from the cost itself, and ledger to ledger against
-- an agent.
--
-- A receipt, payment or cost settled ledger to ledger may name an agent's
-- account (the money he holds for the company) instead of a ledger account.
-- An agent settlement may name the unpaid cost it settles, so a commission
-- paid or set off is tied to the exact cost rather than to the oldest one.
-- Additive only: every existing row keeps its values; the new columns are
-- empty on all of them.
ALTER TABLE "receipts" ADD COLUMN "ledgerAgentId" TEXT;
ALTER TABLE "payments" ADD COLUMN "ledgerAgentId" TEXT;
ALTER TABLE "expenses" ADD COLUMN "ledgerAgentId" TEXT;
ALTER TABLE "agent_settlements" ADD COLUMN "expenseId" TEXT;

CREATE INDEX "receipts_ledgerAgentId_idx" ON "receipts"("ledgerAgentId");
CREATE INDEX "payments_ledgerAgentId_idx" ON "payments"("ledgerAgentId");
CREATE INDEX "expenses_ledgerAgentId_idx" ON "expenses"("ledgerAgentId");
CREATE INDEX "agent_settlements_expenseId_idx" ON "agent_settlements"("expenseId");

ALTER TABLE "receipts" ADD CONSTRAINT "receipts_ledgerAgentId_fkey" FOREIGN KEY ("ledgerAgentId") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_ledgerAgentId_fkey" FOREIGN KEY ("ledgerAgentId") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_ledgerAgentId_fkey" FOREIGN KEY ("ledgerAgentId") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_settlements" ADD CONSTRAINT "agent_settlements_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
