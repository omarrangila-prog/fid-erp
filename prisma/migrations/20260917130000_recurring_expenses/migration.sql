-- Recurring expense templates.
--
-- Rent, the monthly warehouse charge, the same service invoice every quarter:
-- the voucher is the same each time and only the date moves. A template keeps
-- the voucher and the rhythm, and on its due date produces a DRAFT expense
-- for somebody to check and post. Nothing is posted by a clock — a wrong
-- amount that posts itself every month is worse than no template at all.
--
-- The template body is kept as JSON rather than mirrored column by column,
-- because it is re-validated through the expense schema every time a draft
-- is made from it; the columns that matter for finding and scheduling it are
-- real columns.
CREATE TYPE "RecurringFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

CREATE TABLE "recurring_expenses" (
  "id"            TEXT NOT NULL,
  "companyId"     TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "frequency"     "RecurringFrequency" NOT NULL,
  "nextDate"      DATE NOT NULL,
  "endDate"       DATE,
  "template"      JSONB NOT NULL,
  "status"        "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "lastCreatedId" TEXT,
  "createdById"   TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recurring_expenses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recurring_expenses_companyId_status_nextDate_idx"
  ON "recurring_expenses"("companyId", "status", "nextDate");

ALTER TABLE "recurring_expenses"
  ADD CONSTRAINT "recurring_expenses_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recurring_expenses"
  ADD CONSTRAINT "recurring_expenses_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
