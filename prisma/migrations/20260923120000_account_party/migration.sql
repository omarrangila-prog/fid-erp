-- An account that is about one person points at that person.
--
-- "Loan from RADOUAN MOHAMMED" is his account. Naming it after him is how it
-- reads; this is how the software knows. Grouping by the words in the name
-- would break the first time somebody corrects a spelling.
ALTER TABLE "accounts" ADD COLUMN "agentId" TEXT;

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "accounts_agentId_idx" ON "accounts"("agentId");
