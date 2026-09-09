-- VAT / TVA support.
--
-- Additive only: every new column carries a default, so existing rows keep the
-- meaning they had. Companies start with taxEnabled = false, which is the
-- correct state for a business that is not registered — no tax is calculated
-- and nothing about tax appears in the UI until an administrator turns it on.

-- --- Enums -----------------------------------------------------------------
CREATE TYPE "TaxAppliesTo" AS ENUM ('SALES', 'PURCHASE', 'BOTH');
CREATE TYPE "TaxTreatment" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE', 'REVERSE_CHARGE');
CREATE TYPE "TaxReturnStatus" AS ENUM ('DRAFT', 'FILED');

-- --- Company registration details ------------------------------------------
ALTER TABLE "companies"
  ADD COLUMN "taxEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "taxLabel" VARCHAR(12) NOT NULL DEFAULT 'VAT',
  ADD COLUMN "taxRegistrationNumber" TEXT,
  ADD COLUMN "taxPeriodMonths" INTEGER NOT NULL DEFAULT 3;

-- --- Tax codes -------------------------------------------------------------
CREATE TABLE "tax_codes" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "code" VARCHAR(12) NOT NULL,
  "name" TEXT NOT NULL,
  "ratePct" DECIMAL(9,4) NOT NULL DEFAULT 0,
  "treatment" "TaxTreatment" NOT NULL DEFAULT 'STANDARD',
  "appliesTo" "TaxAppliesTo" NOT NULL DEFAULT 'BOTH',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tax_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tax_codes_companyId_code_key" ON "tax_codes"("companyId", "code");
CREATE INDEX "tax_codes_companyId_status_idx" ON "tax_codes"("companyId", "status");
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- Tax returns -----------------------------------------------------------
CREATE TABLE "tax_returns" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "status" "TaxReturnStatus" NOT NULL DEFAULT 'DRAFT',
  "outputTax" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "inputTax" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "netPayable" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "standardSales" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "zeroRatedSales" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "exemptSales" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "purchases" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "reference" TEXT,
  "notes" TEXT,
  "filedAt" TIMESTAMP(3),
  "filedById" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tax_returns_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tax_returns_companyId_periodStart_periodEnd_key" ON "tax_returns"("companyId", "periodStart", "periodEnd");
CREATE INDEX "tax_returns_companyId_status_idx" ON "tax_returns"("companyId", "status");
ALTER TABLE "tax_returns" ADD CONSTRAINT "tax_returns_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tax_returns" ADD CONSTRAINT "tax_returns_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tax_returns" ADD CONSTRAINT "tax_returns_filedById_fkey"
  FOREIGN KEY ("filedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Sales -----------------------------------------------------------------
ALTER TABLE "sales_invoices"
  ADD COLUMN "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmountUsd" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "subtotalUsd" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- Existing invoices carry no tax, so their net equals their gross.
UPDATE "sales_invoices" SET "subtotalUsd" = "totalAmountUsd" WHERE "subtotalUsd" = 0;

ALTER TABLE "sales_invoice_lines"
  ADD COLUMN "taxCodeId" TEXT,
  ADD COLUMN "taxRatePct" DECIMAL(9,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmountUsd" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_taxCodeId_fkey"
  FOREIGN KEY ("taxCodeId") REFERENCES "tax_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Purchases -------------------------------------------------------------
ALTER TABLE "purchase_contracts"
  ADD COLUMN "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmountUsd" DECIMAL(18,4) NOT NULL DEFAULT 0;

ALTER TABLE "purchase_contract_lines"
  ADD COLUMN "taxCodeId" TEXT,
  ADD COLUMN "taxRatePct" DECIMAL(9,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmountUsd" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_contract_lines" ADD CONSTRAINT "purchase_contract_lines_taxCodeId_fkey"
  FOREIGN KEY ("taxCodeId") REFERENCES "tax_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Credit notes ----------------------------------------------------------
ALTER TABLE "credit_notes"
  ADD COLUMN "subtotalAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "subtotalAmountUsd" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmountUsd" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- Existing notes carry no tax, so their net equals their gross.
UPDATE "credit_notes" SET "subtotalAmount" = "totalAmount", "subtotalAmountUsd" = "totalAmountUsd"
  WHERE "subtotalAmount" = 0;

ALTER TABLE "credit_note_lines"
  ADD COLUMN "taxCodeId" TEXT,
  ADD COLUMN "taxRatePct" DECIMAL(9,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmountUsd" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_taxCodeId_fkey"
  FOREIGN KEY ("taxCodeId") REFERENCES "tax_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Expenses --------------------------------------------------------------
ALTER TABLE "expenses"
  ADD COLUMN "taxCodeId" TEXT,
  ADD COLUMN "taxRatePct" DECIMAL(9,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxAmountUsd" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_taxCodeId_fkey"
  FOREIGN KEY ("taxCodeId") REFERENCES "tax_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
