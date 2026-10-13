-- Who confirmed the rate actually paid, so the screen can name them.
--
-- The column was added in the previous migration; this is the key that makes
-- it a relation. ON DELETE SET NULL, because a person leaving must not take
-- the rate with them.
CREATE INDEX IF NOT EXISTS "purchase_contracts_actualRateSetById_idx"
  ON "purchase_contracts"("actualRateSetById");

ALTER TABLE "purchase_contracts"
  ADD CONSTRAINT "purchase_contracts_actualRateSetById_fkey"
  FOREIGN KEY ("actualRateSetById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
