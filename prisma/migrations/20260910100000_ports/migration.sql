-- A master list of ports.
--
-- Additive only. The shipment's own portOfLoading and portOfDischarge stay as
-- free text: a bill of lading says what it says, and the document has to
-- record that even when it disagrees with the list. This table exists so the
-- entry forms can offer a list instead of a blank box, because the same port
-- typed four ways is how a shipment register stops being groupable.

CREATE TABLE "ports" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "code" VARCHAR(12) NOT NULL,
  "name" TEXT NOT NULL,
  "country" TEXT,
  "notes" TEXT,
  "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ports_companyId_code_key" ON "ports"("companyId", "code");
CREATE INDEX "ports_companyId_status_idx" ON "ports"("companyId", "status");

ALTER TABLE "ports" ADD CONSTRAINT "ports_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
