-- Management allocation of general/overhead expenses across shipments.
-- Additive only: no existing table loses a column and no data is touched.
-- Nothing here posts to the general ledger; the original general expenses
-- stay exactly where they are on the company profit and loss.

CREATE TYPE "OverheadAllocationBasis" AS ENUM ('QUANTITY', 'SALES_VALUE', 'PERCENTAGE', 'EQUAL');
CREATE TYPE "OverheadAllocationStatus" AS ENUM ('ACTIVE', 'WITHDRAWN');

CREATE TABLE "overhead_allocations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "basis" "OverheadAllocationBasis" NOT NULL,
    "amountUsd" DECIMAL(18,4) NOT NULL,
    "amountLocal" DECIMAL(18,4) NOT NULL,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "OverheadAllocationStatus" NOT NULL DEFAULT 'ACTIVE',
    CONSTRAINT "overhead_allocations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "overhead_allocation_lines" (
    "id" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "weight" DECIMAL(18,4) NOT NULL,
    "amountUsd" DECIMAL(18,4) NOT NULL,
    "amountLocal" DECIMAL(18,4) NOT NULL,
    CONSTRAINT "overhead_allocation_lines_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "expenses" ADD COLUMN "overheadAllocationId" TEXT;

CREATE INDEX "overhead_allocations_companyId_status_idx" ON "overhead_allocations"("companyId", "status");
CREATE INDEX "overhead_allocations_companyId_fromDate_toDate_idx" ON "overhead_allocations"("companyId", "fromDate", "toDate");
CREATE UNIQUE INDEX "overhead_allocation_lines_allocationId_shipmentId_key" ON "overhead_allocation_lines"("allocationId", "shipmentId");
CREATE INDEX "overhead_allocation_lines_shipmentId_idx" ON "overhead_allocation_lines"("shipmentId");

ALTER TABLE "overhead_allocations" ADD CONSTRAINT "overhead_allocations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "overhead_allocations" ADD CONSTRAINT "overhead_allocations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "overhead_allocation_lines" ADD CONSTRAINT "overhead_allocation_lines_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "overhead_allocations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "overhead_allocation_lines" ADD CONSTRAINT "overhead_allocation_lines_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_overheadAllocationId_fkey" FOREIGN KEY ("overheadAllocationId") REFERENCES "overhead_allocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
