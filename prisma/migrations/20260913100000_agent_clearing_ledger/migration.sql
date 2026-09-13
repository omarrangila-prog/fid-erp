-- The agent clearing ledger.
--
-- A customer settles by giving the agent a cheque written in the agent's own
-- name. The customer's debt is discharged, but FID has not been paid — the
-- money is with the agent. Recording that as cash or bank received would show
-- money the company does not have, and would leave nothing anywhere saying how
-- much is sitting with whom.
--
-- So it lands in an asset account of its own, carried per agent, and is cleared
-- only when the agent actually hands the money over.
--
--   customer pays the agent   Dr Agent Clearing   Cr Accounts Receivable
--   agent pays FID            Dr Bank / Cash      Cr Agent Clearing
--
-- The second half is `agent_settlements`. Commission owed to an agent for a
-- shipment is the mirror image and gets a liability account beside it, so an
-- unpaid commission can be a real cost of the shipment without pretending it
-- has been paid.

-- Agents become a sub-ledger in their own right, like customers and vendors.
ALTER TYPE "SubledgerType" ADD VALUE IF NOT EXISTS 'AGENT';

-- A receipt may be collected by an agent rather than banked.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'AGENT_COLLECTION';
ALTER TYPE "JournalSourceType" ADD VALUE IF NOT EXISTS 'AGENT_SETTLEMENT';

-- Every posting can name the agent it belongs to, which is what makes an
-- agent ledger possible at all.
ALTER TABLE "journal_lines" ADD COLUMN "agentId" TEXT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "journal_lines_agentId_idx" ON "journal_lines"("agentId");

-- Which agent collected a receipt.
ALTER TABLE "receipts" ADD COLUMN "agentId" TEXT;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "receipts_agentId_idx" ON "receipts"("agentId");

-- An expense may be owed to an agent — commission, typically — rather than
-- paid now or owed to a supplier.
ALTER TABLE "expenses" ADD COLUMN "payableToAgentId" TEXT;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payableToAgentId_fkey"
  FOREIGN KEY ("payableToAgentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "expenses_payableToAgentId_idx" ON "expenses"("payableToAgentId");

-- Money actually handed over by an agent, and commission actually paid to one.
CREATE TYPE "AgentSettlementDirection" AS ENUM ('COLLECTION', 'COMMISSION');

CREATE TABLE "agent_settlements" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "settlementNumber" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "settlementDate" DATE NOT NULL,
  -- COLLECTION: the agent hands over money he collected from customers.
  -- COMMISSION: FID pays the agent commission it owed him.
  "direction" "AgentSettlementDirection" NOT NULL,
  "cashBankAccountId" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  "rateToUsd" DECIMAL(18,8) NOT NULL DEFAULT 1,
  "amountUsd" DECIMAL(18,4) NOT NULL,
  "rateLocalPerUsd" DECIMAL(18,8) NOT NULL DEFAULT 1,
  "amountLocal" DECIMAL(18,4) NOT NULL,
  "reference" TEXT,
  "notes" TEXT,
  "status" "TransactionStatus" NOT NULL DEFAULT 'DRAFT',
  "postedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_settlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_settlements_companyId_settlementNumber_key"
  ON "agent_settlements"("companyId", "settlementNumber");
CREATE INDEX "agent_settlements_companyId_agentId_idx" ON "agent_settlements"("companyId", "agentId");
CREATE INDEX "agent_settlements_companyId_status_idx" ON "agent_settlements"("companyId", "status");

ALTER TABLE "agent_settlements" ADD CONSTRAINT "agent_settlements_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_settlements" ADD CONSTRAINT "agent_settlements_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON UPDATE CASCADE;
ALTER TABLE "agent_settlements" ADD CONSTRAINT "agent_settlements_cashBankAccountId_fkey"
  FOREIGN KEY ("cashBankAccountId") REFERENCES "cash_bank_accounts"("id") ON UPDATE CASCADE;
ALTER TABLE "agent_settlements" ADD CONSTRAINT "agent_settlements_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON UPDATE CASCADE;
