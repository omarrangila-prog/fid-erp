-- Optional container and batch on a shipment expense.
--
-- A cost can belong to one container (or one batch) rather than being spread
-- across every kilogram on the job. Null means the existing behaviour: the
-- whole consignment. Additive only — existing expenses keep working.

ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "containerId" TEXT,
  ADD COLUMN IF NOT EXISTS "batchId" TEXT;

CREATE INDEX IF NOT EXISTS "expenses_containerId_idx" ON "expenses"("containerId");
CREATE INDEX IF NOT EXISTS "expenses_batchId_idx" ON "expenses"("batchId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_containerId_fkey'
  ) THEN
    ALTER TABLE "expenses"
      ADD CONSTRAINT "expenses_containerId_fkey"
      FOREIGN KEY ("containerId") REFERENCES "containers"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_batchId_fkey'
  ) THEN
    ALTER TABLE "expenses"
      ADD CONSTRAINT "expenses_batchId_fkey"
      FOREIGN KEY ("batchId") REFERENCES "batches"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
