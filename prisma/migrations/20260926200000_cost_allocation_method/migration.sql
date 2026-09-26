-- How a cost for the whole order is shared between its coffees.
--
-- Every existing cost keeps the rule it was spread with: PER_ITEM, an equal
-- share per coffee and then by weight. Nothing already posted moves.
CREATE TYPE "CostAllocationMethod" AS ENUM ('PER_ITEM', 'BY_WEIGHT', 'BY_VALUE');

ALTER TABLE "expenses" ADD COLUMN "allocationMethod" "CostAllocationMethod" NOT NULL DEFAULT 'PER_ITEM';

-- What each capitalised cost put on each batch, so it can be taken back
-- exactly. Costs posted before this table existed have no rows and are
-- unwound as they always were.
CREATE TABLE "expense_batch_shares" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "amountUsd" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_batch_shares_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "expense_batch_shares_expenseId_idx" ON "expense_batch_shares"("expenseId");
CREATE INDEX "expense_batch_shares_batchId_idx" ON "expense_batch_shares"("batchId");

ALTER TABLE "expense_batch_shares" ADD CONSTRAINT "expense_batch_shares_expenseId_fkey"
  FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expense_batch_shares" ADD CONSTRAINT "expense_batch_shares_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
