-- Shipment expenses against general company expenses.
--
-- Additive. Everything already recorded was entered under a category that
-- exists to capture a shipment cost, so SHIPMENT is the correct default for
-- existing rows; the general categories are new and are seeded as GENERAL
-- below by the application's own provisioning.

CREATE TYPE "ExpenseKind" AS ENUM ('SHIPMENT', 'GENERAL');

ALTER TABLE "expense_categories"
  ADD COLUMN "kind" "ExpenseKind" NOT NULL DEFAULT 'SHIPMENT';

ALTER TABLE "expenses"
  ADD COLUMN "kind" "ExpenseKind" NOT NULL DEFAULT 'SHIPMENT';

-- An expense with no shipment behind it was never a shipment cost, whatever
-- its category said.
UPDATE "expenses" SET "kind" = 'GENERAL' WHERE "shipmentId" IS NULL;

-- The categories that are plainly overheads, so an existing installation does
-- not have to reclassify them by hand.
UPDATE "expense_categories" SET "kind" = 'GENERAL'
  WHERE "code" IN ('WAREHOUSE', 'BANK', 'MISC');
