-- A shortfall between an invoice and the money actually received.
--
-- The default is the behaviour the system already had: the remainder stays
-- owed and nothing extra is posted. Existing allocations therefore need no
-- data change — every one of them kept its remainder outstanding.
CREATE TYPE "SettlementShortfall" AS ENUM ('KEEP_OUTSTANDING', 'ROUND_OFF', 'OTHER_ADJUSTMENT');

ALTER TABLE "receipt_allocations"
  ADD COLUMN "shortfall" "SettlementShortfall" NOT NULL DEFAULT 'KEEP_OUTSTANDING',
  ADD COLUMN "writeOffAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "writeOffAmountUsd" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "writeOffReason" TEXT;
