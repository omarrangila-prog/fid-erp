-- One person, two roles.
--
-- The collection agent also buys coffee himself, so he is a customer as well:
-- one real party, an agent's clearing balance on one side and a trade
-- receivable on the other. Rather than a second person record, the customer
-- record can say which agent it is, so both sides can be read together while
-- the accounts stay properly classified underneath.
--
-- Optional, and null for every existing customer.
ALTER TABLE "customers" ADD COLUMN "agentId" TEXT;
ALTER TABLE "customers" ADD CONSTRAINT "customers_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "customers_agentId_idx" ON "customers"("agentId");
